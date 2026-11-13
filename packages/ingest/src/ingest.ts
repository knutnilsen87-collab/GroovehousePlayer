import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  GOLD_FALLBACK,
  parseMasterName,
  titleFromSlug,
  type AssetKind,
  type AssetManifest,
  type AssetMarker,
  type CatalogIndex,
  type Palette
} from '@gv/shared';
import { analyze, ONSET_HOP, RATE } from './analyze';
import { processCover } from './cover';
import { encodeHls, encodePreview, measureLoudness } from './encode';
import { probe } from './ffmpeg';
import { liveLogToMarkers, type LiveLog } from './livelog';
import { estimateKey, estimateTempo, segmentStructure } from './music';

const AUDIO_RE = /\.(wav|wave|aif|aiff|flac)$/i;
const COVER_RE = /^cover\.(png|jpe?g|webp)$/i;
const SET_THRESHOLD_MS = 20 * 60 * 1000;

export type StepStatus = 'start' | 'ok' | 'skip' | 'warn';
export type StepReporter = (step: string, status: StepStatus, detail?: string) => void;

export interface IngestOptions {
  mediaDir: string;
  force?: boolean;
  /** Ekstra forskyvning av live-logg-markører (ms), hvis sync-ankeret bommer. */
  offsetMs?: number;
  report?: StepReporter;
}

export interface IngestResult {
  status: 'ingested' | 'unchanged';
  manifest: AssetManifest;
  outDir: string;
}

/** Valgfri sidecar i mappa: overstyrer tittel, type m.m. */
interface MetaFile {
  title?: string;
  artist?: string;
  kind?: AssetKind;
  versionLabel?: string;
  performedAt?: string;
  venue?: string;
  /** Visningsnavn per variant, f.eks. {"extended": "Extended Mix"} */
  variants?: Record<string, string>;
  /** Overstyr analysen hvis den bommer */
  bpm?: number;
  camelot?: string;
}

/**
 * Prosesserer en release-mappe. Én mappe kan ha flere varianter (`__extended`, `__radio-edit` …);
 * for hver variant brukes høyeste versjon. Cover, meta og live-logg deles.
 */
export async function ingestFolder(folder: string, opts: IngestOptions): Promise<IngestResult[]> {
  const report: StepReporter = opts.report ?? (() => {});
  const abs = path.resolve(folder);
  const entries = await readdir(abs);

  const audioFiles = entries.filter((f) => AUDIO_RE.test(f));
  if (audioFiles.length === 0) throw new Error(`Ingen WAV/AIFF/FLAC i ${abs}`);
  const folderName = path.basename(abs);
  const parsed = audioFiles.map((f) => ({ file: f, ...parseMasterName(folderName, f) }));

  // Høyeste versjon per variant
  const byVariant = new Map<string, (typeof parsed)[number]>();
  for (const p of parsed) {
    const k = p.variant ?? '';
    const cur = byVariant.get(k);
    if (!cur || p.version > cur.version) byVariant.set(k, p);
    if (p.slugMismatch) report('navn', 'warn', `${p.file}: filnavnet passer ikke mappenavnet – bruker slug "${p.slug}"`);
  }
  const skipped = parsed.length - byVariant.size;
  if (skipped > 0) report('versjon', 'warn', `${skipped} eldre versjon(er) hoppet over`);

  const coverFile = entries.find((f) => COVER_RE.test(f)) ?? null;
  const meta: MetaFile = entries.includes('meta.json') ? JSON.parse(await readFile(path.join(abs, 'meta.json'), 'utf8')) : {};
  const liveLog: LiveLog | null = entries.includes('live_log.json') ? JSON.parse(await readFile(path.join(abs, 'live_log.json'), 'utf8')) : null;

  const results: IngestResult[] = [];
  // Hovedversjonen først, så variantene alfabetisk
  const order = [...byVariant.values()].sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));
  for (const master of order) {
    if (order.length > 1) report('variant', 'ok', master.variant ?? 'hovedversjon');
    results.push(await ingestOne(abs, master, { coverFile, meta, liveLog }, opts, report));
  }
  return results;
}

async function ingestOne(
  abs: string,
  master: { file: string; slug: string; variant: string | null; version: number },
  shared: { coverFile: string | null; meta: MetaFile; liveLog: LiveLog | null },
  opts: IngestOptions,
  report: StepReporter
): Promise<IngestResult> {
  const { coverFile, meta, liveLog } = shared;
  const masterPath = path.join(abs, master.file);

  report('hash', 'start');
  const sha = await sha256File(masterPath);
  report('hash', 'ok', sha.slice(0, 12));

  const outDir = path.join(path.resolve(opts.mediaDir), master.slug, master.variant ?? 'main', `v${master.version}`);
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!opts.force && existsSync(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
    if (existing.masterSha256 === sha) {
      report('alt', 'skip', 'samme master er allerede prosessert (bruk --force for å kjøre på nytt)');
      await updateCatalog(opts.mediaDir, existing);
      return { status: 'unchanged', manifest: existing, outDir };
    }
  }

  const work = `${outDir}.partial`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  try {
    report('probe', 'start');
    const info = await probe(masterPath);
    report('probe', 'ok', `${(info.durationMs / 1000).toFixed(1)} s · ${info.sampleRate} Hz · ${info.channels} kanaler`);

    report('analyse', 'start');
    const { analysis, firstTransientMs, onset, chroma } = await analyze(masterPath, info.durationMs);
    await writeFile(path.join(work, 'analysis.json'), JSON.stringify(analysis));
    report('analyse', 'ok', `bølgeform i 3 bånd · sub-bass 50 ms · ${analysis.spectrum.frames.length} spektrumrammer`);

    const tempo = meta.bpm ? { bpm: meta.bpm, confidence: 1 } : estimateTempo(onset, RATE / ONSET_HOP);
    const key = meta.camelot ? { name: meta.camelot, camelot: meta.camelot, confidence: 1 } : estimateKey(chroma);
    report(
      'bpm/key',
      tempo ? 'ok' : 'warn',
      `${tempo ? `${tempo.bpm} BPM (${pct(tempo.confidence)})` : 'fant ikke tempo'} · ${key ? `${key.camelot} ${key.name} (${pct(key.confidence)})` : 'fant ikke toneart'}`
    );

    report('lufs', 'start');
    const loudness = await measureLoudness(masterPath);
    report('lufs', 'ok', `${loudness.integratedLufs} LUFS · gain ${loudness.playbackGainDb >= 0 ? '+' : ''}${loudness.playbackGainDb} dB`);

    report('hls', 'start');
    const hls = await encodeHls(masterPath, work);
    report('hls', 'ok', 'AAC 256k · 6 s segmenter');

    let palette: Palette = { ...GOLD_FALLBACK };
    let cover: string | null = null;
    let coverThumb: string | null = null;
    if (coverFile) {
      report('palett', 'start');
      const c = await processCover(path.join(abs, coverFile), work);
      palette = c.palette;
      cover = c.cover;
      coverThumb = c.coverThumb;
      report('palett', 'ok', `${palette.primary} / ${palette.secondary} (${palette.source})`);
    } else {
      report('palett', 'warn', 'ingen cover.png/jpg – bruker gull. Legg til cover og kjør på nytt.');
    }

    const kind: AssetKind = meta.kind ?? (liveLog || info.durationMs >= SET_THRESHOLD_MS ? 'set' : 'track');
    let markers: AssetMarker[] = [];
    if (liveLog && kind === 'set') {
      const r = liveLogToMarkers(liveLog, info.durationMs, firstTransientMs, opts.offsetMs ?? 0);
      markers = r.markers;
      report('live-logg', r.synced ? 'ok' : 'warn', `${r.markers.length} markører · forskyvning ${r.offsetMs} ms${r.synced ? '' : ' (fant ikke sync-klikk – ubekreftet)'}`);
    }
    if (kind !== 'set') {
      markers = segmentStructure(analysis.energy, info.durationMs, tempo?.bpm ?? null);
      const labels = markers.filter((m) => m.kind === 'chapter').map((m) => m.label);
      report('struktur', labels.length ? 'ok' : 'warn', labels.length ? `${labels.join(' → ')} (forslag)` : 'fant ingen tydelig struktur');
    }

    report('preview', 'start');
    const firstDrop = markers.find((m) => m.kind === 'drop');
    const previewStart = firstDrop ? Math.max(0, firstDrop.startMs - 4000) : info.durationMs * 0.25;
    const preview = await encodePreview(masterPath, work, previewStart, info.durationMs);
    report('preview', 'ok', `30 s fra ${(previewStart / 1000).toFixed(1)} s`);

    const variantLabel = master.variant ? (meta.variants?.[master.variant] ?? titleFromSlug(master.variant)) : null;
    const manifest: AssetManifest = {
      schema: 1,
      id: uuidFrom(`${master.slug}:${master.variant ?? ''}:${master.version}:${sha}`),
      slug: master.slug,
      variant: master.variant,
      variantLabel,
      version: master.version,
      versionLabel: meta.versionLabel ?? (master.version > 1 ? `v${master.version}` : null),
      kind,
      title: meta.title ?? titleFromSlug(master.slug),
      artist: meta.artist ?? null,
      durationMs: info.durationMs,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bpm: tempo?.bpm ?? null,
      bpmConfidence: tempo?.confidence ?? null,
      key,
      masterSha256: sha,
      masterFile: master.file,
      loudness,
      palette,
      markers,
      performedAt: meta.performedAt ?? null,
      venue: meta.venue ?? null,
      files: { hls, analysis: 'analysis.json', preview, cover, coverThumb },
      createdAt: new Date().toISOString()
    };
    await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.dirname(outDir), { recursive: true });
    await rename(work, outDir);
    await updateCatalog(opts.mediaDir, manifest);
    report('katalog', 'ok', 'media/index.json oppdatert');
    return { status: 'ingested', manifest, outDir };
  } catch (err) {
    await rm(work, { recursive: true, force: true });
    throw err;
  }
}

export async function updateCatalog(mediaDir: string, m: AssetManifest): Promise<void> {
  const file = path.join(path.resolve(mediaDir), 'index.json');
  let idx: CatalogIndex = { schema: 1, updatedAt: '', assets: [] };
  if (existsSync(file)) idx = JSON.parse(await readFile(file, 'utf8'));
  // Fjern oppføringer i gammelt format (uten variant-felt) for samme slug
  idx.assets = idx.assets.filter((a) => a.variant !== undefined || a.slug !== m.slug);
  idx.assets = idx.assets.filter((a) => !(a.slug === m.slug && (a.variant ?? null) === m.variant && a.version === m.version));
  idx.assets.push({
    slug: m.slug,
    variant: m.variant,
    version: m.version,
    manifest: `${m.slug}/${m.variant ?? 'main'}/v${m.version}/manifest.json`,
    title: m.title,
    kind: m.kind
  });
  idx.assets.sort((a, b) => a.slug.localeCompare(b.slug) || (a.variant ?? '').localeCompare(b.variant ?? '') || b.version - a.version);
  idx.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(idx, null, 2));
}

function pct(v: number): string {
  return `sikkerhet ${Math.round(v * 100)} %`;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function uuidFrom(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
