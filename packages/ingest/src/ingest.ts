import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  findSuno,
  GOLD_FALLBACK,
  scrubSuno,
  titleFromSlug,
  type AssetKind,
  type AssetManifest,
  type AssetMarker,
  type CatalogIndex,
  type Palette
} from '@gv/shared';
import { analyze, ONSET_HOP, RATE } from './analyze';
import { formatCopyright, loadConfig, type VaultConfig } from './config';
import { processCover } from './cover';
import { encodeHls, encodePreview, measureLoudness, retagPreview, type EmbedTags } from './encode';
import { probe, probeTags } from './ffmpeg';
import { liveLogToMarkers } from './livelog';
import { estimateKey, estimateTempo, segmentStructure } from './music';
import { readOverrides, releaseFromFolder, type MasterSource, type MetaFile, type ReleaseSource } from './sources';

const SET_THRESHOLD_MS = 20 * 60 * 1000;
/** Et BPM-hint fra filnavnet godtas hvis analysen er innenfor ± dette. */
const BPM_HINT_TOLERANCE = 2;

export type StepStatus = 'start' | 'ok' | 'skip' | 'warn';
export type StepReporter = (step: string, status: StepStatus, detail?: string) => void;

export interface IngestOptions {
  mediaDir: string;
  force?: boolean;
  /** Ekstra forskyvning av live-logg-markører (ms), hvis sync-ankeret bommer. */
  offsetMs?: number;
  report?: StepReporter;
  config?: VaultConfig;
}

export interface IngestResult {
  status: 'ingested' | 'unchanged' | 'retagged';
  manifest: AssetManifest;
  outDir: string;
  /** Hva som ble funnet av «suno» og fjernet. */
  suno: string[];
  warnings: string[];
}

/** Release-mappe med cover.png, meta.json og live_log.json (konvensjonen fra README). */
export async function ingestFolder(folder: string, opts: IngestOptions): Promise<IngestResult[]> {
  const cfg = opts.config ?? loadConfig();
  return ingestRelease(await releaseFromFolder(folder, cfg), { ...opts, config: cfg });
}

/** Prosesserer én release: hver variant (høyeste versjon) for seg. Cover, meta og live-logg deles. */
export async function ingestRelease(release: ReleaseSource, opts: IngestOptions): Promise<IngestResult[]> {
  const report: StepReporter = opts.report ?? (() => {});
  const cfg = opts.config ?? loadConfig();
  for (const w of release.warnings) report('navn', 'warn', w);
  if (release.olderVersions.length) report('versjon', 'warn', `${release.olderVersions.length} eldre versjon(er) hoppet over: ${release.olderVersions.join(', ')}`);

  const overrides = await readOverrides(opts.mediaDir, release.slug);
  const results: IngestResult[] = [];
  for (const master of release.masters) {
    if (release.masters.length > 1) report('variant', 'ok', master.variant ?? 'hovedversjon');
    const warnings: string[] = [];
    const rep: StepReporter = (step, status, detail) => {
      if (status === 'warn' && detail) warnings.push(`${step}: ${detail}`);
      report(step, status, detail);
    };
    try {
      const res = await ingestOne(release, master, overrides, cfg, opts, rep);
      res.warnings = warnings;
      await appendIngestLog(opts.mediaDir, {
        at: new Date().toISOString(),
        slug: master.slug,
        variant: master.variant,
        version: master.version,
        title: res.manifest.title,
        status: res.status,
        suno: res.suno,
        warnings
      });
      results.push(res);
    } catch (err) {
      await appendIngestLog(opts.mediaDir, {
        at: new Date().toISOString(),
        slug: master.slug,
        variant: master.variant,
        version: master.version,
        title: master.titleFromFile,
        status: 'failed',
        suno: [],
        warnings: [...warnings, err instanceof Error ? err.message.split('\n')[0]! : String(err)]
      });
      throw err;
    }
  }
  return results;
}

// ------------------------------------------------------------------ metadata

export interface ResolvedMeta {
  title: string;
  artist: string | null;
  album: string | null;
  label: string | null;
  copyright: string | null;
  variantLabel: string | null;
  titleNeedsReview: boolean;
  venue: string | null;
}

/** Standardverdier (config) < meta.json i kilden < overstyringer fra Studio. «suno» fjernes fra alle tekstfelt. */
export function resolveMeta(
  meta: MetaFile,
  master: Pick<MasterSource, 'titleFromFile' | 'wasAllCaps' | 'variant' | 'year'>,
  cfg: VaultConfig,
  found: string[]
): ResolvedMeta {
  const clean = (v: string | null | undefined, field: string): string | null => {
    if (v === null || v === undefined || v === '') return null;
    const hits = findSuno(v);
    if (hits.length) found.push(`${field}: «${v}»`);
    return hits.length ? scrubSuno(v) || null : v;
  };
  const title = clean(meta.title, 'tittel (meta.json)') ?? master.titleFromFile;
  const label = clean(meta.label, 'label') ?? cfg.defaults.label;
  const year = meta.year ?? master.year;
  const variantLabel = master.variant ? (clean(meta.variants?.[master.variant], 'variantnavn') ?? titleFromSlug(master.variant)) : null;
  return {
    title,
    artist: clean(meta.artist, 'artist') ?? cfg.defaults.artist,
    // Album: per låt, ellers låttittelen (singel). Aldri labelnavnet.
    album: clean(meta.album, 'album') ?? title,
    label,
    copyright: clean(meta.copyright, 'copyright') ?? formatCopyright(cfg.defaults.copyright, year),
    variantLabel,
    titleNeedsReview: !meta.title && master.wasAllCaps,
    venue: clean(meta.venue, 'sted')
  };
}

function embedTags(r: ResolvedMeta): EmbedTags {
  const title = r.variantLabel ? `${r.title} (${r.variantLabel})` : r.title;
  return { title, artist: r.artist, album: r.album, copyright: r.copyright };
}

// ------------------------------------------------------------------ én variant

async function ingestOne(
  release: ReleaseSource,
  master: MasterSource,
  overrides: MetaFile,
  cfg: VaultConfig,
  opts: IngestOptions,
  report: StepReporter
): Promise<IngestResult> {
  const { liveLog } = release;
  const meta: MetaFile = { ...release.meta, ...overrides, variants: { ...release.meta.variants, ...overrides.variants } };

  // «suno» i filnavn, tags eller tekstfelt: varsle tydelig, og sørg for at det ikke følger med videre.
  const suno: string[] = [];
  for (const hit of findSuno(master.fileName)) suno.push(`filnavn: «${master.fileName}» (${hit})`);
  if (release.coverPath) for (const hit of findSuno(path.basename(release.coverPath))) suno.push(`cover-filnavn: «${path.basename(release.coverPath)}» (${hit})`);
  for (const tag of await probeTags(master.path)) if (findSuno(tag).length) suno.push(`tag i kildefila: ${tag}`);
  for (const e of liveLog?.events ?? []) {
    for (const v of [e.label, e.slug]) if (v && findSuno(v).length) suno.push(`live_log: «${v}»`);
  }
  const resolved = resolveMeta(meta, master, cfg, suno);
  const fromSource = resolveMeta({ ...release.meta }, master, cfg, []);
  const sourceMeta: NonNullable<AssetManifest['sourceMeta']> = {
    title: fromSource.title,
    artist: fromSource.artist,
    album: fromSource.album,
    label: fromSource.label,
    copyright: fromSource.copyright,
    variantLabel: fromSource.variantLabel,
    venue: fromSource.venue
  };
  if (liveLog) {
    for (const e of liveLog.events) {
      if (e.label && findSuno(e.label).length) e.label = scrubSuno(e.label) || e.label.replace(/suno/gi, '').trim();
    }
  }
  if (suno.length) {
    report('SUNO', 'warn', `fant «suno» ${suno.length} sted(er) – fjernet fra alt som lages:`);
    for (const s of suno) report('SUNO', 'warn', `  ${s}`);
  }
  if (master.removed.length) report('tittel', 'ok', `«${master.titleFromFile}» (fjernet fra filnavnet: ${master.removed.join(', ')})`);
  if (resolved.titleNeedsReview) report('tittel', 'warn', `filnavnet er i versaler – bruker «${resolved.title}». Rett i Studio ved behov.`);

  report('hash', 'start');
  const sha = await sha256File(master.path);
  const coverSha = release.coverPath ? await sha256File(release.coverPath) : null;
  report('hash', 'ok', sha.slice(0, 12));

  const outDir = path.join(path.resolve(opts.mediaDir), master.slug, master.variant ?? 'main', `v${master.version}`);
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!opts.force && existsSync(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
    if (existing.masterSha256 === sha && (existing.coverSha256 ?? null) === coverSha) {
      if (tagsDiffer(existing, resolved) || !existing.sourceMeta) {
        const updated = await retagOne(outDir, { ...existing, sourceMeta }, resolved);
        report('tags', 'ok', 'samme lyd og cover – oppdaterte bare tags og manifest');
        return { status: 'retagged', manifest: updated, outDir, suno, warnings: [] };
      }
      report('alt', 'skip', 'samme master og cover er allerede prosessert (bruk --force for å kjøre på nytt)');
      await updateCatalog(opts.mediaDir, existing);
      return { status: 'unchanged', manifest: existing, outDir, suno, warnings: [] };
    }
  }

  const work = `${outDir}.partial`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  try {
    report('probe', 'start');
    const info = await probe(master.path);
    report('probe', 'ok', `${(info.durationMs / 1000).toFixed(1)} s · ${info.sampleRate} Hz · ${info.channels} kanaler`);

    report('analyse', 'start');
    const { analysis, firstTransientMs, onset, chroma } = await analyze(master.path, info.durationMs);
    await writeFile(path.join(work, 'analysis.json'), JSON.stringify(analysis));
    report('analyse', 'ok', `bølgeform i 3 bånd · sub-bass 50 ms · ${analysis.spectrum.frames.length} spektrumrammer`);

    const tempo = resolveTempo(meta.bpm, master.bpmHint, estimateTempo(onset, RATE / ONSET_HOP), report);
    const key = meta.camelot ? { name: meta.camelot, camelot: meta.camelot, confidence: 1 } : estimateKey(chroma);
    report(
      'bpm/key',
      tempo ? 'ok' : 'warn',
      `${tempo ? `${tempo.bpm} BPM (${pct(tempo.confidence)})` : 'fant ikke tempo'} · ${key ? `${key.camelot} ${key.name} (${pct(key.confidence)})` : 'fant ikke toneart'}`
    );

    report('lufs', 'start');
    const loudness = await measureLoudness(master.path);
    report('lufs', 'ok', `${loudness.integratedLufs} LUFS · gain ${loudness.playbackGainDb >= 0 ? '+' : ''}${loudness.playbackGainDb} dB`);

    report('hls', 'start');
    const hls = await encodeHls(master.path, work);
    report('hls', 'ok', 'AAC 256k · 6 s segmenter · kildetags fjernet');

    let palette: Palette = { ...GOLD_FALLBACK };
    let cover: string | null = null;
    let coverThumb: string | null = null;
    if (release.coverPath) {
      report('palett', 'start');
      const c = await processCover(release.coverPath, work);
      palette = c.palette;
      cover = c.cover;
      coverThumb = c.coverThumb;
      report('palett', 'ok', `${palette.primary} / ${palette.secondary} (${palette.source}) · cover uten EXIF/XMP/C2PA`);
    } else {
      report('palett', 'warn', release.origin === 'flat' ? `ingen «${master.titleFromFile}.png/jpg» ved siden av lydfila – bruker gull` : 'ingen cover.png/jpg – bruker gull. Legg til cover og kjør på nytt.');
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
    const preview = await encodePreview(master.path, work, previewStart, info.durationMs, embedTags(resolved));
    report('preview', 'ok', `30 s fra ${(previewStart / 1000).toFixed(1)} s · egne tags`);

    const manifest: AssetManifest = {
      schema: 1,
      id: uuidFrom(`${master.slug}:${master.variant ?? ''}:${master.version}:${sha}`),
      slug: master.slug,
      variant: master.variant,
      variantLabel: resolved.variantLabel,
      version: master.version,
      versionLabel: meta.versionLabel ?? (master.version > 1 ? `v${master.version}` : null),
      kind,
      title: resolved.title,
      artist: resolved.artist,
      album: resolved.album,
      label: resolved.label,
      copyright: resolved.copyright,
      ...(resolved.titleNeedsReview ? { titleNeedsReview: true } : {}),
      sourceMeta,
      durationMs: info.durationMs,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bpm: tempo?.bpm ?? null,
      bpmConfidence: tempo?.confidence ?? null,
      key,
      masterSha256: sha,
      coverSha256: coverSha,
      loudness,
      palette,
      markers,
      performedAt: meta.performedAt ?? null,
      venue: resolved.venue,
      files: { hls, analysis: 'analysis.json', preview, cover, coverThumb },
      createdAt: new Date().toISOString()
    };
    await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await swapDir(work, outDir);
    await updateCatalog(opts.mediaDir, manifest);
    report('katalog', 'ok', 'media/index.json oppdatert');
    return { status: 'ingested', manifest, outDir, suno, warnings: [] };
  } catch (err) {
    await rm(work, { recursive: true, force: true });
    throw err;
  }
}

/** meta.json-BPM vinner. Ellers: BPM-hint fra filnavnet hvis analysen bekrefter innenfor ±2, ellers analysen. */
export function resolveTempo(
  metaBpm: number | undefined,
  hint: number | null,
  analysed: { bpm: number; confidence: number } | null,
  report: StepReporter = () => {}
): { bpm: number; confidence: number } | null {
  if (metaBpm) return { bpm: metaBpm, confidence: 1 };
  if (hint === null) return analysed;
  if (!analysed) {
    report('bpm', 'warn', `analysen fant ikke tempo – bruker ${hint} BPM fra filnavnet`);
    return { bpm: hint, confidence: 0.5 };
  }
  if (Math.abs(analysed.bpm - hint) <= BPM_HINT_TOLERANCE) {
    report('bpm', 'ok', `${hint} BPM fra filnavnet, bekreftet av analysen (${analysed.bpm})`);
    return { bpm: hint, confidence: Math.max(analysed.confidence, 0.95) };
  }
  report('bpm', 'warn', `filnavnet sier ${hint} BPM, analysen ${analysed.bpm} – bruker analysen. Sjekk med øret.`);
  return analysed;
}

function tagsDiffer(m: AssetManifest, r: ResolvedMeta): boolean {
  return m.title !== r.title || m.artist !== r.artist || m.album !== r.album || m.label !== r.label || m.copyright !== r.copyright || m.variantLabel !== r.variantLabel || m.venue !== r.venue;
}

/** Bare tag- og manifest-steget: ny tittel/artist/album i manifest og preview.m4a, lyden kodes ikke på nytt. */
async function retagOne(outDir: string, m: AssetManifest, r: ResolvedMeta): Promise<AssetManifest> {
  const updated: AssetManifest = {
    ...m,
    title: r.title,
    artist: r.artist,
    album: r.album,
    label: r.label,
    copyright: r.copyright,
    variantLabel: r.variantLabel,
    venue: r.venue
  };
  delete updated.titleNeedsReview;
  if (r.titleNeedsReview) updated.titleNeedsReview = true;
  delete (updated as unknown as Record<string, unknown>).masterFile;
  await retagPreview(path.join(outDir, m.files.preview), embedTags(r));
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(updated, null, 2));
  await updateCatalog(path.dirname(path.dirname(path.dirname(outDir))), updated);
  return updated;
}

/**
 * Kjører tag- og manifest-steget på nytt for alle versjoner av en slug etter at Studio har lagret
 * media/<slug>/meta.json. Felt som ikke er overstyrt, beholder verdien fra forrige ingest.
 */
export async function retagSlug(mediaDir: string, slug: string, cfg: VaultConfig = loadConfig()): Promise<AssetManifest[]> {
  const root = path.join(path.resolve(mediaDir), slug);
  const overrides = await readOverrides(mediaDir, slug);
  const out: AssetManifest[] = [];
  for (const variantDir of await readdir(root, { withFileTypes: true })) {
    if (!variantDir.isDirectory()) continue;
    for (const vDir of await readdir(path.join(root, variantDir.name), { withFileTypes: true })) {
      const dir = path.join(root, variantDir.name, vDir.name);
      const mp = path.join(dir, 'manifest.json');
      if (!vDir.isDirectory() || vDir.name.endsWith('.partial') || !existsSync(mp)) continue;
      const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
      // Utgangspunktet er det ingest kom fram til fra kilden – ikke forrige overstyring.
      const src = m.sourceMeta ?? { title: m.title, artist: m.artist, album: m.album ?? m.title, label: m.label ?? null, copyright: m.copyright ?? null, variantLabel: m.variantLabel, venue: m.venue };
      const base: MetaFile = {
        title: src.title,
        artist: src.artist ?? undefined,
        // Album som bare fulgte tittelen (singel) skal fortsette å følge en ny tittel.
        album: src.album && src.album !== src.title ? src.album : undefined,
        label: src.label ?? undefined,
        copyright: src.copyright ?? undefined,
        venue: src.venue ?? undefined,
        variants: m.variant && src.variantLabel ? { [m.variant]: src.variantLabel } : {}
      };
      const meta: MetaFile = { ...base, ...overrides, variants: { ...base.variants, ...overrides.variants } };
      const found: string[] = [];
      const r = resolveMeta(meta, { titleFromFile: src.title, wasAllCaps: false, variant: m.variant, year: new Date().getFullYear() }, cfg, found);
      if (overrides.title === undefined && m.titleNeedsReview) r.titleNeedsReview = true;
      const updated = await retagOne(dir, m, r);
      await appendIngestLog(mediaDir, {
        at: new Date().toISOString(),
        slug,
        variant: m.variant,
        version: m.version,
        title: updated.title,
        status: 'retagged',
        suno: found,
        warnings: []
      });
      out.push(updated);
    }
  }
  return out;
}

// ------------------------------------------------------------------ katalog og logg

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

export interface IngestLogEntry {
  at: string;
  slug: string;
  variant: string | null;
  version: number;
  title: string;
  status: 'ingested' | 'unchanged' | 'retagged' | 'failed';
  /** Hva som ble funnet av «suno» – alt er fjernet fra det som ble laget. */
  suno: string[];
  warnings: string[];
}

/** media/ingest-log.json – leses av ingest-kortene i Studio. De 200 siste hendelsene. */
export async function appendIngestLog(mediaDir: string, entry: IngestLogEntry): Promise<void> {
  const file = path.join(path.resolve(mediaDir), 'ingest-log.json');
  await mkdir(path.dirname(file), { recursive: true });
  let log: { schema: 1; entries: IngestLogEntry[] } = { schema: 1, entries: [] };
  if (existsSync(file)) {
    try {
      log = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      /* ødelagt logg – start på nytt */
    }
  }
  log.entries = [entry, ...log.entries].slice(0, 200);
  await writeFile(file, JSON.stringify(log, null, 2));
}

/**
 * Bytter inn den ferdige mappa uten å miste den gamle hvis noe feiler. På Windows kan rename
 * feile kortvarig med EPERM/EBUSY når en annen prosess (Vite, antivirus, Utforsker) har en
 * fil åpen i mappa, så vi prøver igjen en stund før vi gir opp.
 */
export async function swapDir(work: string, outDir: string): Promise<void> {
  await mkdir(path.dirname(outDir), { recursive: true });
  const old = `${outDir}.old`;
  await rm(old, { recursive: true, force: true });
  const hadOld = existsSync(outDir);
  if (hadOld) await renameRetry(outDir, old);
  try {
    await renameRetry(work, outDir);
  } catch (err) {
    if (hadOld) await renameRetry(old, outDir).catch(() => {});
    throw err;
  }
  if (hadOld) await rm(old, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 25 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 100 + i * 60));
    }
  }
}

function pct(v: number): string {
  return `sikkerhet ${Math.round(v * 100)} %`;
}

export function sha256File(file: string): Promise<string> {
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
