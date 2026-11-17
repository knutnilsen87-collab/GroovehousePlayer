import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { energyFeatures, preferredVersion, type Analysis, type AssetManifest, type CatalogIndex, type EnergyFeatures } from '@gv/shared';
import { readDupeReport } from './dupes';

/**
 * Én samlet katalog (GET /api/catalog) i stedet for to kall per låt (manifest + analysis.json på ~100 kB).
 * Listene får kun et slanket manifest (tittel, artist, BPM, toneart, varighet, palett, coverThumb og
 * seksjonsmarkører) + energigrunnlag (features) + mini-bølgeform (48 topper). Fullt manifest.json og analysis.json
 * hentes først når en låt åpnes eller spilles (useFullAsset).
 */
export const SLIM_BUCKETS = 200;

export interface CatalogBundle {
  schema: 1;
  index: CatalogIndex['assets'];
  /** Én per slug + variant (release hvis den finnes, ellers nyeste utkast), som før. */
  assets: Array<{ manifest: AssetManifest; analysis: Analysis | null; features: EnergyFeatures }>;
  /** slug::variant → duplikatgruppe (data/dupe-groups.json). Settbyggeren tar aldri to fra samme gruppe. */
  groups: Record<string, string>;
}

export interface PreparedCatalog {
  bundle: CatalogBundle;
  raw: Buffer;
  gzip: Buffer;
  etag: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function down(values: number[] | undefined, n: number): number[] {
  if (!values?.length) return [];
  if (values.length <= n) return values.map(r2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * values.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n));
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, values[k] ?? 0);
    out.push(r2(m));
  }
  return out;
}

export function slimAnalysis(a: Analysis): Analysis {
  return {
    schema: a.schema,
    version: a.version,
    durationMs: a.durationMs,
    peaks: down(a.peaks, SLIM_BUCKETS),
    energy: down(a.energy, SLIM_BUCKETS),
    spectrum: { bands: a.spectrum?.bands ?? 0, frameMs: a.spectrum?.frameMs ?? 0, frames: [] },
    bands3: { low: down(a.bands3?.low, SLIM_BUCKETS), mid: down(a.bands3?.mid, SLIM_BUCKETS), high: down(a.bands3?.high, SLIM_BUCKETS) },
    sub: { frameMs: a.sub?.frameMs ?? 50, b64: '' },
    ...(a.spectrum48 ? { spectrum48: a.spectrum48 } : {})
  };
}

/** Beholder kun feltene som listene, søk, filtre, spillelister og settbyggeren trenger. */
export function slimManifest(m: AssetManifest): AssetManifest {
  return {
    schema: 1,
    id: m.id,
    slug: m.slug,
    variant: m.variant,
    variantLabel: m.variantLabel,
    version: m.version,
    versionLabel: m.versionLabel,
    kind: m.kind,
    ...(m.status ? { status: m.status } : {}),
    title: m.title,
    artist: m.artist,
    album: null,
    label: null,
    copyright: null,
    ...(m.titleNeedsReview ? { titleNeedsReview: true } : {}),
    ...(m.hidden ? { hidden: true } : {}),
    ...(m.shareBlocked ? { shareBlocked: m.shareBlocked } : {}),
    durationMs: m.durationMs,
    sampleRate: m.sampleRate,
    channels: m.channels,
    bpm: m.bpm,
    bpmConfidence: m.bpmConfidence,
    key: m.key,
    masterSha256: '',
    coverSha256: m.coverSha256,
    ...(m.coverSource ? { coverSource: m.coverSource } : {}),
    loudness: m.loudness,
    palette: m.palette,
    markers: (m.markers ?? [])
      .filter((x) => x.kind === 'chapter' || x.kind === 'drop' || m.kind === 'set')
      .map((x) => ({
        kind: x.kind,
        source: x.source,
        startMs: x.startMs,
        ...(x.endMs != null ? { endMs: x.endMs } : {}),
        ...(x.label ? { label: x.label } : {}),
        ...(x.refSlug ? { refSlug: x.refSlug } : {}),
        confirmed: x.confirmed,
        ...(x.bpm != null ? { bpm: x.bpm } : {})
      })),
    ...(m.energy != null ? { energy: m.energy } : {}),
    performedAt: m.performedAt,
    venue: m.venue,
    files: m.files,
    createdAt: m.createdAt
  };
}

/** Mini-bølgeform i katalogen (radene i Studio-arkivet tegner 48 søyler). Full analyse hentes ved behov. */
export const ROW_PEAKS = 48;
/** Manifestene sjekkes for endringer (mtime) høyst så ofte. Skriving via API-et nullstiller med invalidate(). */
const RECHECK_MS = 10_000;

type Cached = { key: string; manifest: AssetManifest; features: EnergyFeatures; peaks: number[] };

/** Bare toppene, i lav oppløsning: nok til radene, og liten nok til å ligge i katalogen. */
const rowAnalysis = (c: Cached, durationMs: number): Analysis | null =>
  c.peaks.length ? { schema: 1, durationMs, peaks: c.peaks, energy: [], spectrum: { bands: 0, frameMs: 0, frames: [] }, bands3: { low: [], mid: [], high: [] }, sub: { frameMs: 50, b64: '' } } : null;

export function createCatalogBundler(mediaDir: string) {
  const media = path.resolve(mediaDir);
  const cache = new Map<string, Cached>();
  let diskLoaded = false;
  let dirty = true;
  let lastMetaKey = '';
  let lastPrepared: PreparedCatalog | null = null;
  let lastCheck = 0;
  let inflight: Promise<PreparedCatalog | null> | null = null;

  const mtime = (f: string) => stat(f).then((s) => `${s.mtimeMs}:${s.size}`, () => '');

  async function loadDiskCache(dataDir?: string) {
    if (diskLoaded || !dataDir) return;
    diskLoaded = true;
    try {
      const raw = JSON.parse(await readFile(path.join(dataDir, 'catalog-bundle-cache.json'), 'utf8')) as { schema?: number; entries?: Record<string, Cached> };
      // Eldre format (uten mini-bølgeform) bygges på nytt
      if (raw?.schema === 2 && raw.entries) {
        for (const [k, v] of Object.entries(raw.entries)) cache.set(k, v);
      }
    } catch {
      /* ingen disk-cache ennå */
    }
  }

  async function saveDiskCache(dataDir?: string) {
    if (!dataDir) return;
    try {
      await mkdir(dataDir, { recursive: true });
      const file = path.join(dataDir, 'catalog-bundle-cache.json');
      const tmp = `${file}.${process.pid}.tmp`;
      const entries: Record<string, Cached> = {};
      for (const [k, v] of cache.entries()) entries[k] = v;
      await writeFile(tmp, JSON.stringify({ schema: 2, entries }));
      await rename(tmp, file);
    } catch {
      /* ikke kritisk */
    }
  }

  async function entry(rel: string): Promise<{ item: Cached; changed: boolean } | null> {
    const mf = path.join(media, rel);
    const mKey = await mtime(mf);
    if (!mKey) return null;
    const hit = cache.get(rel);
    if (hit) {
      const af = hit.manifest.files.analysis ? path.join(path.dirname(mf), hit.manifest.files.analysis) : '';
      if (hit.key === `${mKey}|${af ? await mtime(af) : ''}`) return { item: hit, changed: false };
    }
    const manifest = JSON.parse(await readFile(mf, 'utf8')) as AssetManifest;
    const af = manifest.files.analysis ? path.join(path.dirname(mf), manifest.files.analysis) : '';
    const aKey = af ? await mtime(af) : '';
    const full = af && aKey ? (JSON.parse(await readFile(af, 'utf8')) as Analysis) : null;
    const c: Cached = { key: `${mKey}|${aKey}`, manifest: slimManifest(manifest), features: energyFeatures(manifest, full), peaks: down(full?.peaks, ROW_PEAKS) };
    cache.set(rel, c);
    return { item: c, changed: true };
  }

  /** Samtidige kall (oppvarming + første forespørsel) deler samme kjøring. */
  function prepared(dataDir?: string): Promise<PreparedCatalog | null> {
    inflight ??= build(dataDir).finally(() => (inflight = null));
    return inflight;
  }

  async function build(dataDir?: string): Promise<PreparedCatalog | null> {
    await loadDiskCache(dataDir);
    const idxFile = path.join(media, 'index.json');
    const idxMtime = await mtime(idxFile);
    if (!idxMtime) return null;
    const dupeFile = dataDir ? path.join(dataDir, 'dupe-groups.json') : '';
    const dupeMtime = dupeFile ? await mtime(dupeFile) : '';
    const metaKey = `${idxMtime}|${dupeMtime}`;

    if (!dirty && lastPrepared && metaKey === lastMetaKey && Date.now() - lastCheck < RECHECK_MS) return lastPrepared;

    let idx: CatalogIndex;
    try {
      idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
    } catch {
      return null;
    }
    const groups = new Map<string, CatalogIndex['assets']>();
    for (const a of idx.assets) {
      const k = `${a.slug}::${a.variant ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    const picked = [...groups.values()].map((l) => preferredVersion(l)!);
    const assets: CatalogBundle['assets'] = [];
    let anyChanged = false;
    for (let i = 0; i < picked.length; i += 16) {
      const got = await Promise.all(picked.slice(i, i + 16).map((e) => entry(e.manifest).catch(() => null)));
      for (const g of got) {
        if (g) {
          if (g.changed) anyChanged = true;
          // Skjulte (testlåta fra fixtures) sendes ikke
          if (!g.item.manifest.hidden) assets.push({ manifest: g.item.manifest, analysis: rowAnalysis(g.item, g.item.manifest.durationMs), features: g.item.features });
        }
      }
    }
    lastCheck = Date.now();
    // Ingenting endret siden sist (bare tiden for ny sjekk var ute): samme svar og samme ETag
    if (!anyChanged && !dirty && lastPrepared && metaKey === lastMetaKey) return lastPrepared;
    if (anyChanged) void saveDiskCache(dataDir);
    const dupes = dataDir ? ((await readDupeReport(dataDir))?.byKey ?? {}) : {};
    const b: CatalogBundle = { schema: 1, index: idx.assets, assets, groups: dupes };
    const raw = Buffer.from(JSON.stringify(b));
    const etag = `W/"${createHash('sha1').update(raw).digest('hex').slice(0, 20)}"`;
    const gzip = gzipSync(raw, { level: 6 });
    lastMetaKey = metaKey;
    dirty = false;
    lastPrepared = { bundle: b, raw, gzip, etag };
    return lastPrepared;
  }

  const fn = async function bundle(dataDir?: string): Promise<CatalogBundle | null> {
    const p = await prepared(dataDir);
    return p ? p.bundle : null;
  };
  return Object.assign(fn, {
    prepared,
    invalidate: () => {
      dirty = true;
    }
  });
}
