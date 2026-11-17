import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANALYSIS_VERSION,
  carryMarkers,
  DRAFT_BASE,
  toDraftVersion,
  type AssetStatus,
  findSuno,
  isKept,
  mergeMarkers,
  FALLBACK_PALETTE,
  scrubSuno,
  titleFromSlug,
  type AssetKind,
  type AssetManifest,
  type AssetMarker,
  type CatalogIndex,
  type Palette,
  manualPalette
} from '@gv/shared';
import { analyze, ONSET_HOP, ONSET_TRACK_SAMPLES, RATE } from './analyze';
import { findRoot, formatCopyright, loadConfig, matchRule, type VaultConfig } from './config';
import { vaultCoverLogo, writeVaultCover } from './vault-cover';
import { paletteFrom, processCover } from './cover';
import { encodeHls, encodePreview, loudnormFilter, measureLoudness, measureLoudnorm, retagPreview, type EmbedTags } from './encode';
import { probe, probeTags } from './ffmpeg';
import { liveLogToMarkers } from './livelog';
import { estimateKey, estimateKeyEdma, estimateTempoHouse, segmentStructure, tempoPerChapter } from './music';
import { findMaster, makeMasterCopy } from './share';
import { analyzeSpectrum48, probeSourceFormat, SPECTRUM48_FILE } from './spectrum';
import { previousEdited, readMarkersFile, writeMarkersFile } from './markers-file';
import { recordSources, relativeToExport, sourceKey, sourcesFile } from './source-index';
import { readOverrides, releaseFromFolder, type MasterSource, type MetaFile, type ReleaseSource } from './sources';

/** Et BPM-hint fra filnavnet godtas hvis analysen er innenfor ± dette. */
const BPM_HINT_TOLERANCE = 2;

export type StepStatus = 'start' | 'ok' | 'skip' | 'warn' | 'progress';
export type StepReporter = (step: string, status: StepStatus, detail?: string) => void;

export interface IngestOptions {
  mediaDir: string;
  force?: boolean;
  /** Ekstra forskyvning av live-logg-markører (ms), hvis sync-ankeret bommer. */
  offsetMs?: number;
  report?: StepReporter;
  config?: VaultConfig;
  /** Del 16: «draft» for filer fra utkastmappa (egne versjonsnumre, loudnorm-HLS). Standard: release. */
  status?: AssetStatus;
  /** Del 24: fast versjonsnavn, f.eks. «LANDR-master» for filer fra LANDR-mappa. */
  versionLabel?: string;
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
  // Del 16: utkast får egne versjonsnumre (1000 + N), så de aldri kolliderer med release-versjoner
  const masters = opts.status === 'draft' ? release.masters.map((m) => ({ ...m, version: toDraftVersion(m.version) })) : release.masters;
  if (opts.status === 'draft') report('status', 'ok', 'umastret (fra mappa for umastrede låter) – holdes atskilt fra release-klare');
  if (opts.status === 'released') report('status', 'ok', 'utgitt (fra mappa for utgitte låter) – versjonen heter «Utgitt master»');
  for (const master of masters) {
    if (masters.length > 1) report('variant', 'ok', master.variant ?? 'hovedversjon');
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
    copyright: clean(meta.copyright, 'copyright') ?? formatCopyright(cfg.defaults.copyright, year, label),
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
  const storedCover = path.join(path.resolve(opts.mediaDir), master.slug, 'cover.jpg');
  const effectiveCover = release.coverPath ?? (existsSync(storedCover) ? storedCover : null);
  const coverSha = effectiveCover ? await sha256File(effectiveCover) : null;
  report('hash', 'ok', sha.slice(0, 12));
  // Kildefil (privat, data/sources.json): bare til «Kildefil» i Info og Studio, aldri i manifest/tags/deling.
  const noteSource = () =>
    recordSources(sourcesFile(opts.mediaDir), {
      [sourceKey(master.slug, master.variant, master.version)]: { fileName: master.fileName, relPath: relativeToExport(master.path, cfg.exportDir ?? undefined), sha256: sha, recordedAt: new Date().toISOString() }
    }).catch((err) => report('kildefil', 'warn', `klarte ikke å lagre kildefil: ${err instanceof Error ? err.message : err}`));

  const outDir = path.join(path.resolve(opts.mediaDir), master.slug, master.variant ?? 'main', `v${master.version}`);
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!opts.force && existsSync(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
    if (existing.masterSha256 === sha && (existing.coverSha256 ?? null) === coverSha) {
      if (tagsDiffer(existing, resolved) || !existing.sourceMeta) {
        const updated = await retagOne(outDir, { ...existing, sourceMeta }, resolved);
        report('tags', 'ok', 'samme lyd og cover – oppdaterte bare tags og manifest');
        await noteSource();
        return { status: 'retagged', manifest: updated, outDir, suno, warnings: [] };
      }
      report('alt', 'skip', 'samme master og cover er allerede prosessert (bruk --force for å kjøre på nytt)');
      await updateCatalog(opts.mediaDir, existing);
      await noteSource();
      if (!findMaster(outDir)) {
        await makeMasterCopy(master.path, outDir);
        report('master', 'ok', 'kopi av masteren lagt til (del 10)');
      }
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

    const draft = opts.status === 'draft';
    // Del 4: alt som bare leser masteren, kjører samtidig: analyse (+ spektrum og format), LUFS,
    // HLS, cover og Vaults master-kopi. Tempo, toneart, struktur og preview venter bare på analysen.
    const long = info.durationMs >= PROGRESS_MIN_MS;
    const prog = { analyse: 0, spektrum: 0, hls: 0, lufs: 0, master: 0 };
    const stopProgress = long ? startProgress(opts.mediaDir, master, prog, report) : () => Promise.resolve();
    const timed = <T>(step: string, fn: () => Promise<T>, done: (v: T) => string, key?: keyof typeof prog): Promise<T> => {
      report(step, 'start');
      return fn().then((v) => {
        if (key) prog[key] = 1;
        report(step, 'ok', done(v));
        return v;
      });
    };

    const analysisP = timed(
      'analyse',
      () =>
        Promise.all([
          analyze(master.path, info.durationMs, { onProgress: (f) => (prog.analyse = f) }),
          analyzeSpectrum48(master.path, info.durationMs, (f) => (prog.spektrum = f)),
          probeSourceFormat(master.path, master.fileName)
        ]).then(async ([a, spec48, sourceFormat]) => {
          a.analysis.version = ANALYSIS_VERSION;
          a.analysis.spectrum48 = spec48.info;
          await writeFile(path.join(work, SPECTRUM48_FILE), spec48.data);
          await writeFile(path.join(work, 'analysis.json'), JSON.stringify(a.analysis));
          prog.spektrum = 1;
          return { ...a, spec48, sourceFormat };
        }),
      (r) => `bølgeform i 3 bånd · sub-bass 50 ms · spektrum 48 bånd × ${r.spec48.info.frames} · ${r.sourceFormat.label}`,
      'analyse'
    );
    const loudnessP = timed('lufs', () => measureLoudness(master.path, cfg.audio.targetLufs), (l) => `${l.integratedLufs} LUFS · gain ${l.playbackGainDb >= 0 ? '+' : ''}${l.playbackGainDb} dB`, 'lufs');
    // Del 16: utkast er ofte mye svakere enn masterne – HLS normaliseres (loudnorm, 2 passeringer, −1 dBTP).
    // master.flac lagres uendret. Release-låter røres ikke.
    const normP = draft ? measureLoudnorm(master.path, cfg.audio.targetLufs) : null;
    const hlsP = timed(
      'hls',
      async () => encodeHls(master.path, work, (ms) => (prog.hls = Math.min(1, ms / info.durationMs)), normP ? loudnormFilter(cfg.audio.targetLufs, await normP) : undefined),
      () => (draft ? `AAC 256k · normalisert til ${cfg.audio.targetLufs} LUFS (umastret) · kildetags fjernet` : 'AAC 256k · 6 s segmenter · kildetags fjernet'),
      'hls'
    );
    // Del 10: Vaults egen tapsfrie kopi av masteren (FLAC), så deling ikke avhenger av at fila
    // fortsatt ligger i eksportmappa, og aldri lages fra HLS. Kilden leses bare.
    const masterP = timed('master', () => makeMasterCopy(master.path, work), (f) => path.basename(f), 'master');
    const coverP = effectiveCover ? timed('palett', () => processCover(effectiveCover, work, cfg.colors), (c) => `${c.palette.primary} / ${c.palette.secondary} (${c.palette.source}) · cover uten EXIF/XMP/C2PA`) : Promise.resolve(null);
    // Ingen ubehandlede avvisninger mens vi venter på analysen: feil fanges i Promise.all under
    for (const p of [loudnessP, hlsP, masterP, coverP]) p.catch(() => {});

    const { analysis, firstTransientMs, onset, chroma, hpcp, sourceFormat } = await analysisP;
    // Del 3: tempo med kam over 1–8 slag og house-regel (118–132), fra de første 6 minuttene
    const hopRate = RATE / ONSET_HOP;
    const tempo = resolveTempo(meta.bpm, master.bpmHint, estimateTempoHouse(onset.subarray(0, Math.ceil(ONSET_TRACK_SAMPLES / ONSET_HOP)), hopRate), report);
    // Del 3: toneart etter innstillingen (Krumhansl til fasiten avgjør, eller HPCP + tuning + EDMA)
    const estimated = cfg.analysis.keyMethod === 'edma' ? estimateKeyEdma(hpcp) : estimateKey(chroma);
    const key = meta.camelot ? { name: meta.camelot, camelot: meta.camelot, confidence: 1 } : estimated ? { name: estimated.name, camelot: estimated.camelot, confidence: estimated.confidence } : null;
    report(
      'bpm/key',
      tempo ? 'ok' : 'warn',
      `${tempo ? `${tempo.bpm} BPM (${pct(tempo.confidence)})` : 'fant ikke tempo'} · ${key ? `${key.camelot} ${key.name} (${pct(key.confidence)})` : 'fant ikke toneart'}`
    );

    const rule = matchRule(cfg, path.basename(master.path));
    const kind: AssetKind = meta.kind ?? rule?.kind ?? (liveLog || info.durationMs >= cfg.ingest.setThresholdMinutes * 60_000 ? 'set' : 'track');
    let markers: AssetMarker[] = [];
    if (liveLog && kind === 'set') {
      const r = liveLogToMarkers(liveLog, info.durationMs, firstTransientMs, opts.offsetMs ?? meta.liveOffsetMs ?? 0);
      markers = r.markers;
      report('live-logg', r.synced ? 'ok' : 'warn', `${r.markers.length} markører · forskyvning ${r.offsetMs} ms${r.synced ? '' : ' (fant ikke sync-klikk – ubekreftet)'}`);
    }
    if (kind !== 'set') {
      markers = segmentStructure(analysis.energy, info.durationMs, tempo?.bpm ?? null);
      const labels = markers.filter((m) => m.kind === 'chapter').map((m) => m.label);
      report('struktur', labels.length ? 'ok' : 'warn', labels.length ? `${labels.join(' → ')} (forslag)` : 'fant ingen tydelig struktur');
    }

    // Del 3: tempo per kapittel i sett, og tempoendringer i loggen
    if (kind === 'set') {
      const chapters = markers.filter((m) => m.kind === 'chapter');
      const per = tempoPerChapter(onset, hopRate, chapters.map((c, i) => ({ startMs: c.startMs, endMs: c.endMs ?? chapters[i + 1]?.startMs ?? info.durationMs })), info.durationMs);
      chapters.forEach((c, i) => {
        if (per[i] != null) c.bpm = per[i]!;
      });
      const known = chapters.filter((c) => c.bpm != null);
      const changes = known.filter((c, i) => i > 0 && Math.abs(c.bpm! - known[i - 1]!.bpm!) >= 1);
      if (known.length) report('tempo', changes.length ? 'warn' : 'ok', changes.length ? `tempoendringer: ${known.map((c) => `${c.label ?? '?'} ${c.bpm}`).join(' → ')}` : `jevnt tempo i settet (${known[0]!.bpm} BPM)`);
    }

    // Del 2: Knuts rettelser fra Studio (markers.json) overlever ny ingest av samme versjon (--force).
    // Ny versjon: foreslå markørene fra forrige rettede versjon, som ubekreftede.
    const edited = await readMarkersFile(outDir);
    if (edited) {
      markers = mergeMarkers(markers, edited);
      await writeMarkersFile(work, edited);
      report('markører', 'ok', `${edited.markers.filter(isKept).length} rettet i Studio beholdt`);
    } else {
      const prev = await previousEdited(opts.mediaDir, master.slug, master.variant, master.version);
      if (prev) {
        markers = carryMarkers({ markers: prev.manifest.markers, durationMs: prev.manifest.durationMs }, { markers, durationMs: info.durationMs });
        report('markører', 'warn', `overført fra v${prev.manifest.version} som ubekreftede – sjekk dem i Studio`);
      }
    }

    const firstDrop = markers.find((m) => m.kind === 'drop');
    const previewStart = firstDrop ? Math.max(0, firstDrop.startMs - 4000) : info.durationMs * 0.25;
    const previewP = timed('preview', () => encodePreview(master.path, work, previewStart, info.durationMs, embedTags(resolved)), () => `30 s fra ${(previewStart / 1000).toFixed(1)} s · egne tags`);

    let loudness, hls, preview, coverRes;
    try {
      [loudness, hls, preview, coverRes] = await Promise.all([loudnessP, hlsP, previewP, coverP, masterP]);
    } finally {
      await stopProgress();
    }
    if (draft) loudness = { ...loudness, playbackGainDb: 0, normalizedLufs: cfg.audio.targetLufs };

    let palette: Palette = { ...FALLBACK_PALETTE };
    let cover: string | null = null;
    let coverThumb: string | null = null;
    let coverSource: 'file' | 'generated' | 'ai' | undefined;
    if (coverRes) {
      // Del 23: cover lagt inn fra bulkIMG (lagret i media/<slug>/) beholder AI-merket ved ny ingest
      coverSource = !release.coverPath && overrides.aiCover ? 'ai' : 'file';
      palette = coverRes.palette;
      cover = coverRes.cover;
      coverThumb = coverRes.coverThumb;
    } else {
      // Del 23 nivå 1: Vault-cover fra låtas egne data (toneart, bølgeform, spektrum, energi). Et ekte cover erstatter det alltid.
      try {
        const gen = await timed(
          'cover',
          async () => {
            const png = await writeVaultCover(work, { title: resolved.title, artist: resolved.artist, slug: master.slug, camelot: key?.camelot ?? null, draft, analysis }, vaultCoverLogo(findRoot(opts.mediaDir)));
            return processCover(png, work, cfg.colors);
          },
          (c) => `Vault-cover (3000 px) · ${c.palette.primary} / ${c.palette.secondary} · ${release.origin === 'flat' ? `legg «${master.titleFromFile}.png/jpg» ved lydfila for ekte cover` : 'legg cover.png/jpg i mappa for ekte cover'}`
        );
        palette = gen.palette;
        cover = gen.cover;
        coverThumb = gen.coverThumb;
        coverSource = 'generated';
      } catch (err) {
        report('palett', 'warn', `fikk ikke laget Vault-cover (${err instanceof Error ? err.message : err}) – bruker standardfargen (grønn)`);
      }
    }
    // Del 8: manuell farge fra Studio vinner over coveret
    if (meta.palette) {
      const mp = manualPalette(meta.palette.primary, meta.palette.secondary, 0);
      if (mp.ok) {
        palette = mp.palette;
        report('palett', 'ok', `${palette.primary} / ${palette.secondary} (valgt i Studio)`);
      }
    }

    const manifest: AssetManifest = {
      schema: 1,
      id: uuidFrom(`${master.slug}:${master.variant ?? ''}:${master.version}:${sha}`),
      slug: master.slug,
      variant: master.variant,
      variantLabel: resolved.variantLabel,
      version: master.version,
      versionLabel: opts.versionLabel ?? (opts.status === 'released' ? 'Utgitt master' : null) ?? (meta.versionLabel ?? (draft ? `Umastret v${master.version - DRAFT_BASE}` : master.version > 1 ? `v${master.version}` : null)),
      kind,
      status: draft ? 'draft' : opts.status === 'released' ? 'released' : 'release',
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
      sourceFormat,
      bpm: tempo?.bpm ?? null,
      bpmConfidence: tempo?.confidence ?? null,
      key,
      masterSha256: sha,
      coverSha256: coverSha,
      ...(coverSource ? { coverSource } : {}),
      ...(coverSource === 'ai' && overrides.aiCover ? { coverAi: { provider: overrides.aiCover.provider, model: overrides.aiCover.model } } : {}),
      loudness,
      palette,
      markers,
      ...(kind === 'set' && meta.liveOffsetMs ? { liveOffsetMs: meta.liveOffsetMs } : {}),
      ...(typeof meta.energy === 'number' ? { energy: meta.energy } : {}),
      performedAt: meta.performedAt ?? null,
      venue: resolved.venue,
      files: { hls, analysis: 'analysis.json', preview, cover, coverThumb },
      createdAt: new Date().toISOString()
    };
    await writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await swapDir(work, outDir);
    await updateCatalog(opts.mediaDir, manifest);
    report('katalog', 'ok', 'media/index.json oppdatert');
    await noteSource();
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

/** Flytter markørene `deltaMs` (del 8, live-forskyvning), innenfor låta. */
export function shiftMarkers(markers: AssetMarker[], deltaMs: number, durationMs: number): AssetMarker[] {
  const c = (v: number) => Math.min(durationMs, Math.max(0, v + deltaMs));
  return markers.map((m) => ({ ...m, startMs: c(m.startMs), ...(m.endMs !== undefined && m.endMs !== null ? { endMs: c(m.endMs) } : {}) }));
}

function tagsDiffer(m: AssetManifest, r: ResolvedMeta): boolean {
  return m.title !== r.title || m.artist !== r.artist || m.album !== r.album || m.label !== r.label || m.copyright !== r.copyright || m.variantLabel !== r.variantLabel || m.venue !== r.venue;
}

/** Bare tag- og manifest-steget: ny tittel/artist/album i manifest og preview.m4a, lyden kodes ikke på nytt. */
async function retagOne(outDir: string, m: AssetManifest, r: ResolvedMeta, overrides: MetaFile = {}, cfg: VaultConfig = loadConfig()): Promise<AssetManifest> {
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
  // Del 8: manuell farge – eller tilbake til coverets når overstyringen er fjernet
  if (overrides.palette) {
    const mp = manualPalette(overrides.palette.primary, overrides.palette.secondary, 0);
    if (mp.ok) updated.palette = mp.palette;
  } else if (m.palette.source === 'manual') {
    updated.palette = m.files.cover ? await paletteFrom(path.join(outDir, m.files.cover), cfg.colors) : { ...FALLBACK_PALETTE };
  }
  // Del 17: energi for settbyggeren
  if (typeof overrides.energy === 'number') updated.energy = overrides.energy;
  else delete updated.energy;
  // Del 8: live-sett – flytt markørene med endringen i forskyvning
  if (m.kind === 'set') {
    const delta = (overrides.liveOffsetMs ?? 0) - (m.liveOffsetMs ?? 0);
    if (delta) {
      updated.markers = shiftMarkers(m.markers, delta, m.durationMs);
      // Del 2: rettelsene i markers.json flyttes likt, så de står seg ved ny ingest
      const edited = await readMarkersFile(outDir);
      if (edited) await writeMarkersFile(outDir, { ...edited, markers: shiftMarkers(edited.markers, delta, m.durationMs) });
    }
    delete updated.liveOffsetMs;
    if (overrides.liveOffsetMs) updated.liveOffsetMs = overrides.liveOffsetMs;
  }
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
      const updated = await retagOne(dir, m, r, overrides, cfg);
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

/**
 * Lagrer opplastet/sluppet coverbilde (renset for EXIF/XMP/C2PA) på alle versjoner av en låt (slug)
 * i media/<slug>/, og oppdaterer manifestene uten å røre eksportmappa.
 */
export async function setAssetCover(mediaDir: string, slug: string, buf: Buffer, cfg: VaultConfig = loadConfig()): Promise<AssetManifest[]> {
  const root = path.join(path.resolve(mediaDir), slug);
  if (!existsSync(root)) throw new Error('ukjent låt');
  const coverSha256 = createHash('sha256').update(buf).digest('hex');
  const masterCover = await processCover(buf, root, cfg.colors);
  const bigBuf = await readFile(path.join(root, masterCover.cover));
  const thumbBuf = await readFile(path.join(root, masterCover.coverThumb));
  const overrides = await readOverrides(mediaDir, slug);
  const out: AssetManifest[] = [];
  for (const variantDir of await readdir(root, { withFileTypes: true })) {
    if (!variantDir.isDirectory()) continue;
    for (const vDir of await readdir(path.join(root, variantDir.name), { withFileTypes: true })) {
      const dir = path.join(root, variantDir.name, vDir.name);
      const mp = path.join(dir, 'manifest.json');
      if (!vDir.isDirectory() || vDir.name.endsWith('.partial') || !existsSync(mp)) continue;
      await writeFile(path.join(dir, 'cover.jpg'), bigBuf);
      await writeFile(path.join(dir, 'cover_300.jpg'), thumbBuf);
      await rm(path.join(dir, 'share'), { recursive: true, force: true }).catch(() => {});
      // Del 23: ekte cover erstatter alltid Vault-coveret
      await rm(path.join(dir, 'cover_vault.png'), { force: true }).catch(() => {});
      const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
      let palette = m.palette;
      if (overrides.palette) {
        const man = manualPalette(overrides.palette.primary, overrides.palette.secondary, 0);
        if (man.ok) palette = man.palette;
      } else if (m.palette.source !== 'manual') {
        // Paletten hentes fra det nye coveret (Kameleon-skinnet følger det)
        palette = masterCover.palette;
      }
      const updated: AssetManifest = {
        ...m,
        coverSha256,
        coverSource: 'file',
        coverAi: undefined,
        palette,
        files: { ...m.files, cover: 'cover.jpg', coverThumb: 'cover_300.jpg' }
      };
      await writeFile(mp, JSON.stringify(updated, null, 2));
      await updateCatalog(mediaDir, updated);
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
    kind: m.kind,
    ...(m.status === 'draft' || m.status === 'released' ? { status: m.status } : {})
  });
  idx.assets.sort((a, b) => a.slug.localeCompare(b.slug) || (a.variant ?? '').localeCompare(b.variant ?? '') || b.version - a.version);
  idx.updatedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(idx, null, 2));
}

// ---------------------------------------------------------------- Del 4: fremdrift for lange filer

/** Sett over 20 minutter viser fremdrift i prosent (terminal og Studio). */
export const PROGRESS_MIN_MS = 20 * 60_000;
export const PROGRESS_FILE = 'ingest-progress.json';
/** Vekting av de parallelle stegene (HLS tar lengst tid). */
const WEIGHTS = { analyse: 0.3, spektrum: 0.15, hls: 0.4, lufs: 0.1, master: 0.05 };

export interface IngestProgress {
  slug: string;
  variant: string | null;
  version: number;
  title: string;
  percent: number;
  updatedAt: string;
}

export function progressPercent(p: Record<keyof typeof WEIGHTS, number>): number {
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) sum += w * Math.min(1, Math.max(0, p[k as keyof typeof WEIGHTS] ?? 0));
  return Math.min(99, Math.floor(sum * 100));
}

/** Melder fremdrift hvert sekund (rapport + media/ingest-progress.json). Returnerer stopp-funksjon. */
function startProgress(mediaDir: string, master: MasterSource, prog: Record<keyof typeof WEIGHTS, number>, report: StepReporter): () => Promise<void> {
  const file = path.join(path.resolve(mediaDir), PROGRESS_FILE);
  let last = -1;
  const tick = () => {
    const percent = progressPercent(prog);
    if (percent === last) return;
    last = percent;
    report('fremdrift', 'progress', `${percent} %`);
    const body: IngestProgress = { slug: master.slug, variant: master.variant, version: master.version, title: master.titleFromFile, percent, updatedAt: new Date().toISOString() };
    void writeFile(`${file}.tmp`, JSON.stringify(body))
      .then(() => rename(`${file}.tmp`, file))
      .catch(() => {});
  };
  tick();
  const t = setInterval(tick, 1000);
  return async () => {
    clearInterval(t);
    report('fremdrift', 'progress', '100 %');
    await new Promise((r) => setTimeout(r, 50));
    await rm(file, { force: true }).catch(() => {});
  };
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
