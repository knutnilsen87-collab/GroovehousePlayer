import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetManifest, CatalogIndex } from '@gv/shared';
import { fingerprintFile, similarity, SIMILARITY_THRESHOLD, type Fingerprint } from './fingerprint';
import { sha256File } from './ingest';
import { findMaster } from './share';
import { readSources, sourcesFile } from './source-index';

/**
 * Sanger som allerede finnes i Vault, importeres ikke på nytt. Hver ny fil i en overvåket mappe sjekkes i
 * denne rekkefølgen:
 *  1. Samme lyd (eksakt hash mot alle versjoner og kildefiler) → hoppes over stille.
 *  2. Åpenbar stem (vokal/trommer/bass alene, acapella …) → hoppes over (vises i backlog-planen).
 *  3. Samme låt: samme slug (og variant) eller samme tittel etter rensing, eller lydlikhet over terskelen
 *     (kromagram + lik varighet ±2 s), uansett status → «Hoppet over – finnes allerede» i Studio, med
 *     hvilken låt den ligner på. Knut velger «Importer som ny versjon» eller «Importer som egen låt».
 *  4. Ellers importeres fila automatisk.
 *
 * Vault leser bare kildemappene; ingenting flyttes, endres eller slettes der.
 */

export type IncomingVerdict =
  | { action: 'import' }
  | { action: 'known'; slug: string }
  | { action: 'stem'; reason: string }
  | { action: 'listed'; item: SkippedItem };

export interface SkippedItem {
  id: string;
  file: string;
  fileName: string;
  status: 'release' | 'draft';
  /** Hva den ligner på. */
  matchSlug: string;
  matchVariant: string | null;
  matchTitle: string;
  reason: 'samme-slug' | 'samme-tittel' | 'lik-lyd';
  similarity: number | null;
  sha256: string;
  at: string;
}

/** Åpenbare stems i filnavnet. «Bass Don't Lie» o.l. er ikke stems: krever stem-ord i parentes/etter skille. */
const STEM_RE = /(?:^|[\s_\-(\[])(stems?|acapella|a[\s-]?cappella|vocals?\s*only|vox\s*only|drums?\s*only|bass\s*only|instrumental\s*stem|(?:vocal|drum|bass|other|vox)[\s_-]?stem)(?:$|[\s_\-)\].])/i;
const STEM_SUFFIX_RE = /(?:\s-\s|_|\()(vocals|vox|drums|bass|other|instrumental)\)?\.[a-z0-9]+$/i;
export function stemReason(fileName: string): string | null {
  const m = STEM_RE.exec(fileName) ?? STEM_SUFFIX_RE.exec(fileName);
  // «… (Instrumental).wav» er en egen versjon, ikke en stem
  if (m && /^instrumental$/i.test(m[1] ?? '') && /\(instrumental\)/i.test(fileName)) return null;
  return m ? `ser ut som en stem («${m[1]}»)` : null;
}

/** Tittel for sammenligning: små bokstaver, uten nummerering, versjonsord og tegnsetting. */
export function normTitle(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^\s*\d{1,3}\s*[.\-_)]\s*/, '')
    .replace(/\((?:\d+|v\d+|final|master(?:ed)?|mix|bounce|copy|kopi)\)/g, '')
    .replace(/\b(v\d+|final|master(?:ed)?|bounce|copy|kopi)\b/g, '')
    .replace(/[^a-z0-9æøå]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- hash-cache (sti + størrelse + mtime → sha256)

interface HashCache {
  [file: string]: { size: number; mtimeMs: number; sha256: string };
}
export function createHashCache(dataDir: string) {
  const file = path.join(dataDir, 'file-hashes.json');
  let cache: HashCache | null = null;
  let dirty = false;
  const load = async () => (cache ??= existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as HashCache) : {});
  return {
    async sha(p: string): Promise<string> {
      const c = await load();
      const s = await stat(p);
      const hit = c[p];
      if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.sha256;
      const sha = await sha256File(p);
      c[p] = { size: s.size, mtimeMs: s.mtimeMs, sha256: sha };
      dirty = true;
      return sha;
    },
    async save() {
      if (!dirty || !cache) return;
      await mkdir(dataDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(cache));
      await rename(`${file}.tmp`, file);
      dirty = false;
    }
  };
}

// ---------------------------------------------------------------- biblioteket

interface LibEntry {
  slug: string;
  variant: string | null;
  title: string;
  norm: string;
  durationMs: number;
  dir: string;
}
export interface Library {
  shas: Set<string>;
  entries: LibEntry[];
}

/** Alle versjoner i media/ (alle statuser) + kildefilenes hash fra data/sources.json. */
export async function loadLibrary(mediaDir: string, dataDir: string): Promise<Library> {
  const media = path.resolve(mediaDir);
  const shas = new Set<string>();
  const entries: LibEntry[] = [];
  const idxFile = path.join(media, 'index.json');
  if (existsSync(idxFile)) {
    const idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
    const seen = new Set<string>();
    for (const a of idx.assets) {
      const mp = path.join(media, a.manifest);
      if (!existsSync(mp)) continue;
      const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
      shas.add(m.masterSha256);
      const k = `${m.slug}::${m.variant ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push({ slug: m.slug, variant: m.variant, title: m.title, norm: normTitle(m.title), durationMs: m.durationMs, dir: path.dirname(mp) });
    }
  }
  for (const r of Object.values((await readSources(sourcesFile(mediaDir, dataDir))).entries)) shas.add(r.sha256);
  return { shas, entries };
}

/** Biblioteket leses på nytt bare når media/index.json eller data/sources.json er endret. */
const libCache = new Map<string, { key: string; lib: Library }>();
async function cachedLibrary(mediaDir: string, dataDir: string): Promise<Library> {
  const mt = async (f: string) => (existsSync(f) ? (await stat(f)).mtimeMs : 0);
  const key = `${await mt(path.join(path.resolve(mediaDir), 'index.json'))}:${await mt(sourcesFile(mediaDir, dataDir))}`;
  const hit = libCache.get(mediaDir);
  if (hit && hit.key === key) return hit.lib;
  const lib = await loadLibrary(mediaDir, dataDir);
  libCache.set(mediaDir, { key, lib });
  return lib;
}

/** Fingeravtrykk for bibliotekets låter, bufret i data/fingerprints.json (lages ved behov fra master.flac). */
export function createFingerprintStore(dataDir: string) {
  const file = path.join(dataDir, 'fingerprints.json');
  let fps: Record<string, Fingerprint> | null = null;
  let dirty = false;
  const load = async () => (fps ??= existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Record<string, Fingerprint>) : {});
  return {
    async forEntry(e: LibEntry): Promise<Fingerprint | null> {
      const all = await load();
      const key = `${e.slug}::${e.variant ?? ''}::${path.basename(e.dir)}`;
      if (all[key]) return all[key];
      const master = findMaster(e.dir);
      if (!master) return null;
      const fp = await fingerprintFile(master);
      all[key] = fp;
      dirty = true;
      return fp;
    },
    async save() {
      if (!dirty || !fps) return;
      await mkdir(dataDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(fps));
      await rename(`${file}.tmp`, file);
      dirty = false;
    }
  };
}

// ---------------------------------------------------------------- klassifisering

export interface IncomingCtx {
  mediaDir: string;
  dataDir: string;
  hashes: ReturnType<typeof createHashCache>;
  fingerprints: ReturnType<typeof createFingerprintStore>;
  /** Lastes på nytt per fil (biblioteket endres mens køen går). */
  library?: Library;
}

/**
 * Avgjør hva som skal skje med en ny fil. `slug`, `variant` og `title` er det filnavnet tolkes som.
 * `durationMs` fra ffprobe. Skriver ingenting (bortsett fra hurtigbuffere i data/).
 */
export async function classifyIncoming(
  ctx: IncomingCtx,
  f: { file: string; fileName: string; slug: string; variant: string | null; title: string; durationMs: number; status: 'release' | 'draft' }
): Promise<IncomingVerdict> {
  const lib = ctx.library ?? (await cachedLibrary(ctx.mediaDir, ctx.dataDir));
  const sha = await ctx.hashes.sha(f.file);
  if (lib.shas.has(sha)) return { action: 'known', slug: f.slug };
  const stem = stemReason(f.fileName);
  if (stem) return { action: 'stem', reason: stem };
  const item = (e: LibEntry, reason: SkippedItem['reason'], sim: number | null): IncomingVerdict => ({
    action: 'listed',
    item: { id: randomUUID(), file: f.file, fileName: f.fileName, status: f.status, matchSlug: e.slug, matchVariant: e.variant, matchTitle: e.title, reason, similarity: sim, sha256: sha, at: new Date().toISOString() }
  });
  const sameSlug = lib.entries.find((e) => e.slug === f.slug && (e.variant ?? null) === (f.variant ?? null));
  if (sameSlug) return item(sameSlug, 'samme-slug', null);
  const n = normTitle(f.title);
  const sameTitle = n ? lib.entries.find((e) => e.norm === n && (e.variant ?? null) === (f.variant ?? null)) : undefined;
  if (sameTitle) return item(sameTitle, 'samme-tittel', null);
  // Lydlikhet: bare mot låter med lik varighet (±2 s), så det holder å lage fingeravtrykk for få
  const near = lib.entries.filter((e) => Math.abs(e.durationMs - f.durationMs) <= 2000);
  if (near.length) {
    const fp = await fingerprintFile(f.file);
    let best: { e: LibEntry; s: number } | null = null;
    for (const e of near) {
      const efp = await ctx.fingerprints.forEntry(e).catch(() => null);
      if (!efp) continue;
      const s = similarity(fp, efp, f.durationMs, e.durationMs);
      if (!best || s > best.s) best = { e, s };
    }
    await ctx.fingerprints.save();
    if (best && best.s >= SIMILARITY_THRESHOLD) return item(best.e, 'lik-lyd', Math.round(best.s * 1000) / 1000);
  }
  return { action: 'import' };
}

// ---------------------------------------------------------------- lista «Hoppet over – finnes allerede»

export function createSkippedStore(dataDir: string) {
  const file = path.join(dataDir, 'import-skipped.json');
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  const read = async (): Promise<SkippedItem[]> => (existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as SkippedItem[]) : []);
  const write = async (items: SkippedItem[]) => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(items, null, 2) + '\n');
    await rename(`${file}.tmp`, file);
  };
  return {
    list: read,
    /** Samme fil (hash) legges bare inn én gang. */
    add: (it: SkippedItem) =>
      serial(async () => {
        const items = await read();
        if (items.some((x) => x.sha256 === it.sha256)) return false;
        items.push(it);
        await write(items);
        return true;
      }),
    take: (id: string) =>
      serial(async () => {
        const items = await read();
        const it = items.find((x) => x.id === id) ?? null;
        if (it) await write(items.filter((x) => x.id !== id));
        return it;
      }),
    has: async (sha: string) => (await read()).some((x) => x.sha256 === sha)
  };
}
export type SkippedStore = ReturnType<typeof createSkippedStore>;
