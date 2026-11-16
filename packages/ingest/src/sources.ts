import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFlatName, parseMasterName, scrubSuno, titleFromSlug, type AssetKind } from '@gv/shared';
import { matchRule, type VaultConfig } from './config';
import type { LiveLog } from './livelog';

export const AUDIO_RE = /\.(wav|wave|aif|aiff|flac)$/i;
/** Mappene for umastrede låter tar også tapsbaserte filer (Suno, mobilopptak o.l.). Release-mappa er bare tapsfri. */
export const DRAFT_AUDIO_RE = /\.(wav|wave|aif|aiff|flac|mp3|m4a|aac|ogg|opus)$/i;
export const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const COVER_RE = /^cover\.(png|jpe?g|webp)$/i;

/** Valgfri meta.json (i release-mappa, eller media/<slug>/meta.json fra Studio). Alt er valgfritt. */
export interface MetaFile {
  title?: string;
  artist?: string;
  album?: string;
  label?: string;
  /** Overstyrer hele copyright-linja, f.eks. "℗ 2024 Groovehouse Records". */
  copyright?: string;
  /** Overstyrer året i copyright (standard: filens år). */
  year?: number;
  kind?: AssetKind;
  versionLabel?: string;
  performedAt?: string;
  venue?: string;
  /** Visningsnavn per variant, f.eks. {"extended": "Extended Mix"} */
  variants?: Record<string, string>;
  /** Overstyr analysen hvis den bommer */
  bpm?: number;
  camelot?: string;
  /** Del 8: manuell palett fra Studio (overlever ny ingest). */
  palette?: { primary: string; secondary: string };
  /** Del 8: live-sett – flytt markørene så mange ms (±10 000, steg på 50). */
  liveOffsetMs?: number;
  /** Del 17: energiscore for settbyggeren (1–10), overstyrt i Studio. */
  energy?: number;
  /** Del 23 punkt 9: AI-cover – nok til å gjenskape det (bulkIMG lagrer ikke frø, så seed er null). */
  aiCover?: { source: 'bulkimg'; provider: string | null; model: string | null; prompt: string | null; seed: null; exportId: string | null; receivedAt: string };
}

export interface MasterSource {
  path: string;
  fileName: string;
  slug: string;
  variant: string | null;
  version: number;
  /** Tittel utledet og renset fra filnavnet. */
  titleFromFile: string;
  wasAllCaps: boolean;
  bpmHint: number | null;
  /** Tekst som ble fjernet fra filnavnet under rensing. */
  removed: string[];
  /** Filens år (eldste av opprettet/endret). */
  year: number;
  mtimeMs: number;
}

export interface ReleaseSource {
  slug: string;
  origin: 'folder' | 'flat';
  /** Høyeste versjon per variant, hovedversjonen først. */
  masters: MasterSource[];
  /** Eldre versjoner som hoppes over. */
  olderVersions: string[];
  coverPath: string | null;
  meta: MetaFile;
  liveLog: LiveLog | null;
  warnings: string[];
}

async function fileYear(file: string): Promise<{ year: number; mtimeMs: number }> {
  const s = await stat(file);
  const times = [s.mtimeMs, s.birthtimeMs].filter((t) => t > 0);
  return { year: new Date(Math.min(...times)).getFullYear(), mtimeMs: s.mtimeMs };
}

function pickLatest(all: MasterSource[]): { masters: MasterSource[]; older: string[] } {
  const by = new Map<string, MasterSource>();
  for (const m of all) {
    const k = m.variant ?? '';
    const cur = by.get(k);
    if (!cur || m.version > cur.version || (m.version === cur.version && m.mtimeMs > cur.mtimeMs)) by.set(k, m);
  }
  const masters = [...by.values()].sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));
  return { masters, older: all.filter((m) => !masters.includes(m)).map((m) => m.fileName) };
}

/** Release-mappe: <slug>/<slug>[__variant]_vN.wav + cover.png + meta.json + live_log.json. */
export async function releaseFromFolder(folder: string, cfg: VaultConfig): Promise<ReleaseSource> {
  const abs = path.resolve(folder);
  const entries = await readdir(abs);
  const audio = entries.filter((f) => AUDIO_RE.test(f));
  if (audio.length === 0) throw new Error(`Ingen WAV/AIFF/FLAC i ${abs}`);
  const folderName = scrubSuno(path.basename(abs)) || path.basename(abs);
  const warnings: string[] = [];
  const all: MasterSource[] = [];
  for (const f of audio) {
    const p = parseMasterName(folderName, f);
    if (p.slugMismatch) warnings.push(`${f}: filnavnet passer ikke mappenavnet – bruker slug "${p.slug}"`);
    const flat = parseFlatName(f, cfg.titleCleanup);
    all.push({
      path: path.join(abs, f),
      fileName: f,
      slug: p.slug,
      variant: p.variant,
      version: p.version,
      titleFromFile: titleFromSlug(p.slug),
      wasAllCaps: false,
      bpmHint: flat.clean.bpmHint,
      removed: [],
      ...(await fileYear(path.join(abs, f)))
    });
  }
  const { masters, older } = pickLatest(all);
  const cover = entries.find((f) => COVER_RE.test(f));
  return {
    slug: masters[0]!.slug,
    origin: 'folder',
    masters,
    olderVersions: older,
    coverPath: cover ? path.join(abs, cover) : null,
    meta: entries.includes('meta.json') ? JSON.parse(await readFile(path.join(abs, 'meta.json'), 'utf8')) : {},
    liveLog: entries.includes('live_log.json') ? JSON.parse(await readFile(path.join(abs, 'live_log.json'), 'utf8')) : null,
    warnings
  };
}

export interface FlatScan {
  releases: ReleaseSource[];
  /** Filer som ikke er lyd eller bilde (prosjektfiler, mp3 …) – røres ikke. */
  ignored: string[];
  /** Bilder uten tilhørende lydfil. */
  orphanImages: string[];
}

/**
 * Flat eksportmappe (leses bare, endres aldri). Slug og tittel kommer fra filnavnet;
 * cover er et bilde med samme navn ved siden av («Eyes on you.png»).
 */
/**
 * Del 16: utkastmappa skannes med undermapper (f.eks. én mappe per prosjekt). Hver mappe tolkes som en
 * flat eksportmappe; skjulte mapper hoppes over. Mappa leses bare.
 */
export async function scanDrafts(dir: string, cfg: VaultConfig, depth = 8): Promise<FlatScan> {
  const out: FlatScan = { releases: [], ignored: [], orphanImages: [] };
  const walk = async (d: string, left: number) => {
    const s = await scanFlat(d, cfg, { lossy: true });
    out.releases.push(...s.releases);
    out.ignored.push(...s.ignored.map((f) => path.relative(dir, path.join(d, f))));
    out.orphanImages.push(...s.orphanImages.map((f) => path.relative(dir, path.join(d, f))));
    if (left <= 0) return;
    for (const e of await readdir(d, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(d, e.name), left - 1);
  };
  await walk(path.resolve(dir), depth);
  out.releases.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

export async function scanFlat(dir: string, cfg: VaultConfig, opts: { lossy?: boolean } = {}): Promise<FlatScan> {
  const audioRe = opts.lossy ? DRAFT_AUDIO_RE : AUDIO_RE;
  const abs = path.resolve(dir);
  const entries = (await readdir(abs, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  const bySlug = new Map<string, MasterSource[]>();
  const images: Array<{ file: string; slug: string; mtimeMs: number }> = [];
  const ignored: string[] = [];

  for (const f of entries.sort((a, b) => a.localeCompare(b, 'nb'))) {
    const full = path.join(abs, f);
    if (audioRe.test(f)) {
      const p = parseFlatName(f, cfg.titleCleanup);
      const ms: MasterSource = {
        path: full,
        fileName: f,
        slug: p.slug,
        // Del 8: en filnavnregel kan sette varianten («* (Club *)» → club)
        variant: matchRule(cfg, f)?.variant || p.variant,
        version: p.version,
        titleFromFile: p.clean.title,
        wasAllCaps: p.clean.wasAllCaps,
        bpmHint: p.clean.bpmHint,
        removed: p.clean.removed,
        ...(await fileYear(full))
      };
      bySlug.set(p.slug, [...(bySlug.get(p.slug) ?? []), ms]);
    } else if (IMAGE_RE.test(f)) {
      images.push({ file: f, slug: parseFlatName(f, cfg.titleCleanup).slug, mtimeMs: (await stat(full)).mtimeMs });
    } else {
      ignored.push(f);
    }
  }

  const releases: ReleaseSource[] = [];
  for (const [slug, all] of bySlug) {
    const { masters, older } = pickLatest(all);
    const cover = images.filter((i) => i.slug === slug).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    releases.push({ slug, origin: 'flat', masters, olderVersions: older, coverPath: cover ? path.join(abs, cover.file) : null, meta: {}, liveLog: null, warnings: [] });
  }
  return {
    releases: releases.sort((a, b) => a.slug.localeCompare(b.slug)),
    ignored,
    orphanImages: images.filter((i) => !bySlug.has(i.slug)).map((i) => i.file)
  };
}

/** Overstyringer fra Studio ligger i media/<slug>/meta.json – eksportmappa endres aldri. */
export function overridePath(mediaDir: string, slug: string): string {
  return path.join(path.resolve(mediaDir), slug, 'meta.json');
}

export async function readOverrides(mediaDir: string, slug: string): Promise<MetaFile> {
  const p = overridePath(mediaDir, slug);
  return existsSync(p) ? (JSON.parse(await readFile(p, 'utf8')) as MetaFile) : {};
}
