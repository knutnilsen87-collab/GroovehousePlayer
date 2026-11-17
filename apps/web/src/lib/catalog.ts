import { useEffect, useMemo, useRef, useState } from 'react';
import { preferredVersion, type Analysis, type AssetManifest, type CatalogIndex, type EnergyFeatures } from '@gv/shared/web';
import { serverBase } from './connection';

/** Media-mappa serveres under dette prefikset (Vite-dev og apps/server). */
export const MEDIA = '/media';

/**
 * Fase 1: leser filene ingest-motoren skrev til media/, servert under /media/.
 * Fase 2: samme form hentes fra Supabase (`assets`) og media-workeren.
 */
export interface LoadedAsset {
  manifest: AssetManifest;
  analysis: Analysis | null;
  /** Mappe-URL for denne versjonen, f.eks. /media/blue-fire/main/v2/ */
  base: string;
  /**
   * Fra den samlede katalogen (/api/catalog): analysen er lett (bølgeform i lav oppløsning, uten spektrumrammer
   * og sub-bass). Komponenter som trenger detaljene bruker useFullAsset(), som henter analysis.json ved behov.
   */
  slim?: boolean;
  /** Settbyggerens energigrunnlag, beregnet på serveren fra full analyse. */
  features?: EnergyFeatures;
}

/** slug::variant → duplikatgruppe (samme låt under ulike titler). Fylles av den samlede katalogen. */
let groups: Record<string, string> = {};
export const dupeGroups = () => groups;

export function assetUrl(a: LoadedAsset, file: string | null): string | null {
  if (!file) return null;
  const bust = /\.(jpe?g|png|webp)$/i.test(file) && a.manifest.coverSha256 ? `?v=${a.manifest.coverSha256.slice(0, 8)}` : '';
  return `${a.base}${file}${bust}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

/** Én linje i media/index.json – én per slug + variant + versjon (eldre versjoner blir liggende). */
export type IndexEntry = CatalogIndex['assets'][number];

const versionCache = new Map<string, Promise<LoadedAsset>>();

/** Laster én versjon (manifest + analyse). Bufres, så hver versjon hentes bare én gang. */
export function loadVersion(entry: IndexEntry, fresh = false): Promise<LoadedAsset> {
  let p = fresh ? undefined : versionCache.get(entry.manifest);
  if (!p) {
    p = (async () => {
      // I Android-appen ligger media på Vault (Tailscale): URL-ene må være absolutte (også for <img> og Media3).
      const base = `${serverBase()}${MEDIA}/${entry.manifest.replace(/manifest\.json$/, '')}`;
      const manifest = await getJson<AssetManifest>(`${MEDIA}/${entry.manifest}`);
      const analysis = await getJson<Analysis>(`${base}${manifest.files.analysis}`).catch(() => null);
      return { manifest, analysis, base };
    })();
    p.catch(() => versionCache.delete(entry.manifest));
    versionCache.set(entry.manifest, p);
  }
  return p;
}

export const versionKey = (slug: string, variant: string | null, version: number) => `${slug}::${variant ?? ''}::${version}`;

/** Alle versjoner av en slug + variant i indeksen, nyeste først. */
export function versionsOf(index: IndexEntry[], slug: string, variant: string | null): IndexEntry[] {
  return index.filter((e) => e.slug === slug && (e.variant ?? null) === variant).sort((a, b) => b.version - a.version);
}

const mediaBase = (manifestPath: string) => `${serverBase()}${MEDIA}/${manifestPath.replace(/manifest\.json$/, '')}`;

export const CATALOG_CACHE_KEY = 'gv:catalog:v2';

interface CachedCatalogPayload {
  etag: string | null;
  server: string;
  index: IndexEntry[];
  assets: Array<{ manifest: AssetManifest; analysis?: Analysis | null; features?: EnergyFeatures }>;
  groups?: Record<string, string>;
}

function hydrateAssets(rawAssets: Array<{ manifest: AssetManifest; analysis?: Analysis | null; features?: EnergyFeatures }>, index: IndexEntry[]): LoadedAsset[] {
  const byKey = new Map(index.map((e) => [versionKey(e.slug, e.variant, e.version), e] as const));
  return rawAssets
    .filter((x) => !x.manifest.hidden)
    .map((x) => {
      const e = byKey.get(versionKey(x.manifest.slug, x.manifest.variant, x.manifest.version));
      return {
        manifest: x.manifest,
        analysis: x.analysis ?? null,
        features: x.features,
        base: mediaBase(e?.manifest ?? `${x.manifest.slug}/${x.manifest.variant ?? 'main'}/v${x.manifest.version}/manifest.json`),
        slim: true
      };
    });
}

export function readCachedCatalog(): { assets: LoadedAsset[]; index: IndexEntry[]; etag: string | null } | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CATALOG_CACHE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCatalogPayload;
    if (!parsed || !Array.isArray(parsed.assets) || !Array.isArray(parsed.index)) return null;
    if (parsed.server && serverBase() && parsed.server !== serverBase()) return null;
    groups = parsed.groups ?? {};
    return { assets: hydrateAssets(parsed.assets, parsed.index), index: parsed.index, etag: parsed.etag ?? null };
  } catch {
    return null;
  }
}

function writeCachedCatalog(payload: CachedCatalogPayload) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(payload));
    }
  } catch {
    /* lagringskvote nådd eller privat modus */
  }
}

export async function loadCatalog(opts?: { etag?: string | null }): Promise<{ assets: LoadedAsset[]; index: IndexEntry[]; error: string | null; notModified?: boolean; etag?: string | null }> {
  // Ett kall med alt listene trenger. Eldre server uten /api/catalog: hent filene én og én som før.
  try {
    const headers: Record<string, string> = {};
    if (opts?.etag) headers['If-None-Match'] = opts.etag;
    const r = await fetch('/api/catalog', { cache: 'no-store', headers });
    if (r.status === 304) {
      return { assets: [], index: [], error: null, notModified: true, etag: opts?.etag ?? null };
    }
    if (r.status === 404 && (r.headers.get('content-type') ?? '').includes('json')) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (j.error === 'tomt hvelv') {
        writeCachedCatalog({ etag: null, server: serverBase(), index: [], assets: [], groups: {} });
        return { assets: [], index: [], error: null };
      }
    } else if (r.ok) {
      const etag = r.headers.get('etag') ?? null;
      const b = (await r.json()) as { index: IndexEntry[]; assets: Array<{ manifest: AssetManifest; analysis: Analysis | null; features?: EnergyFeatures }>; groups?: Record<string, string> };
      groups = b.groups ?? {};
      const assets = hydrateAssets(b.assets, b.index);
      writeCachedCatalog({
        etag,
        server: serverBase(),
        index: b.index,
        assets: b.assets,
        groups
      });
      return { assets, index: b.index, error: null, etag };
    } else if (r.status === 401) {
      return { assets: [], index: [], error: `401 /api/catalog` };
    }
  } catch {
    /* faller tilbake til filene */
  }
  return loadCatalogFiles();
}

async function loadCatalogFiles(): Promise<{ assets: LoadedAsset[]; index: IndexEntry[]; error: string | null }> {
  let idx: CatalogIndex;
  try {
    idx = await getJson<CatalogIndex>(`${MEDIA}/index.json`);
  } catch (err) {
    // 404 = tomt hvelv (ingen index.json ennå). Nettverksfeil/401 = ingen kontakt (vises i appen).
    const msg = err instanceof Error ? err.message : String(err);
    return { assets: [], index: [], error: /^404 /.test(msg) ? null : msg };
  }
  // Katalogen viser én versjon per slug + variant: release hvis den finnes, ellers nyeste utkast (del 16).
  // Eldre versjoner hentes ved behov (låst versjon i spilleliste, versjonsvelger i Studio).
  const groups = new Map<string, IndexEntry[]>();
  for (const a of idx.assets) {
    const k = `${a.slug}::${a.variant ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const latest = new Map<string, IndexEntry>();
  for (const [k, list] of groups) latest.set(k, preferredVersion(list)!);
  const loaded = await Promise.all([...latest.values()].map((e) => loadVersion(e, true)));
  return { assets: loaded.filter((a) => !a.manifest.hidden), index: idx.assets, error: null };
}

/** Fullt manifest + analyse (manifest.json + analysis.json) hentes ved behov når en låt åpnes eller spilles. */
const fullCache = new Map<string, Promise<Analysis | null>>();
const fullDone = new Map<string, Analysis | null>();
const fullManifestCache = new Map<string, Promise<AssetManifest>>();
const fullManifestDone = new Map<string, AssetManifest>();

export function loadFullManifest(a: LoadedAsset): Promise<AssetManifest> {
  const key = `${a.base}manifest.json`;
  let p = fullManifestCache.get(key);
  if (!p) {
    p = getJson<AssetManifest>(key).catch(() => {
      fullManifestCache.delete(key);
      return a.manifest;
    });
    // Feilet hentingen, får vi det slanke tilbake: da er det ikke «fullt» (prøves igjen neste gang)
    void p.then((m) => m !== a.manifest && fullManifestDone.set(key, m));
    fullManifestCache.set(key, p);
  }
  return p;
}

export function loadFullAnalysis(a: LoadedAsset): Promise<Analysis | null> {
  const key = a.base + (a.manifest.files.analysis ?? '');
  let p = fullCache.get(key);
  if (!p) {
    p = a.manifest.files.analysis
      ? getJson<Analysis>(`${a.base}${a.manifest.files.analysis}`).catch(() => {
          fullCache.delete(key);
          return a.analysis;
        })
      : Promise.resolve(a.analysis);
    void p.then((x) => fullDone.set(key, x));
    fullCache.set(key, p);
  }
  return p;
}

/**
 * Samme låt med fullt manifest og full analyse. Returnerer den lette versjonen til den fulle er hentet,
 * og henter bare når låta faktisk åpnes eller spilles. Låter som ikke er «slim» returneres som de er.
 */
export function useFullAsset<T extends LoadedAsset | null | undefined>(a: T): T {
  const aKey = a?.slim ? a.base + (a.manifest.files.analysis ?? '') : '';
  const mKey = a?.slim ? `${a.base}manifest.json` : '';
  const [, bump] = useState(0);
  useEffect(() => {
    if (!a?.slim || (fullDone.has(aKey) && fullManifestDone.has(mKey))) return;
    let alive = true;
    void Promise.all([loadFullManifest(a), loadFullAnalysis(a)]).then(() => alive && bump((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [aKey, mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const fullAn = aKey ? fullDone.get(aKey) : undefined;
  const fullMan = mKey ? fullManifestDone.get(mKey) : undefined;
  return useMemo(
    // «slim» blir false først når det fulle manifestet er hentet (redigering må aldri lagre fra det slanke)
    () => (a && a.slim && (fullAn !== undefined || fullMan !== undefined) ? ({ ...a, manifest: fullMan ?? a.manifest, analysis: fullAn ?? a.analysis, slim: !fullMan } as T) : a),
    [a, fullAn, fullMan]
  );
}

const catalogListeners = new Set<() => void>();
export function notifyCatalogChanged() {
  versionCache.clear();
  fullCache.clear();
  fullDone.clear();
  fullManifestCache.clear();
  fullManifestDone.clear();
  for (const fn of catalogListeners) fn();
}

export function useCatalog() {
  const [state, setState] = useState<{ assets: LoadedAsset[]; index: IndexEntry[]; error: string | null; loading: boolean; refreshing: boolean }>(() => {
    const cached = readCachedCatalog();
    if (cached && cached.assets.length > 0) {
      return { assets: cached.assets, index: cached.index, error: null, loading: false, refreshing: true };
    }
    return { assets: [], index: [], error: null, loading: true, refreshing: false };
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    catalogListeners.add(bump);
    return () => {
      catalogListeners.delete(bump);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const cached = tick === 0 ? readCachedCatalog() : null;
    setState((s) => (s.assets.length > 0 ? { ...s, refreshing: true, error: null } : { ...s, loading: true, error: null }));
    loadCatalog({ etag: cached?.etag }).then((c) => {
      if (!alive) return;
      if (c.notModified) {
        setState((s) => ({ ...s, loading: false, refreshing: false, error: null }));
        return;
      }
      // Behold lagret katalog hvis nettverket er midlertidig utilgjengelig (men ikke ved 401: da må appen kobles til på nytt)
      setState((s) => (c.error && s.assets.length > 0 && !/^401 /.test(c.error) ? { ...s, loading: false, refreshing: false } : { assets: c.assets, index: c.index, error: c.error, loading: false, refreshing: false }));
    });
    return () => {
      alive = false;
    };
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** media/ingest-log.json – skrevet av ingest-motoren. */
export interface IngestLogEntry {
  at: string;
  slug: string;
  variant: string | null;
  version: number;
  title: string;
  status: 'ingested' | 'unchanged' | 'retagged' | 'failed';
  suno: string[];
  warnings: string[];
}

export function useIngestLog(tick = 0): IngestLogEntry[] {
  const [entries, setEntries] = useState<IngestLogEntry[]>([]);
  useEffect(() => {
    let alive = true;
    getJson<{ entries: IngestLogEntry[] }>(`${MEDIA}/ingest-log.json`)
      .then((j) => alive && setEntries(j.entries ?? []))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [tick]);
  return entries;
}

/** Del 4: fremdrift for lange sett som ingestes nå (media/ingest-progress.json, finnes bare underveis). */
export interface IngestProgress {
  slug: string;
  variant: string | null;
  version: number;
  title: string;
  percent: number;
  updatedAt: string;
}
export function useIngestProgress(onDone?: () => void): IngestProgress | null {
  const [p, setP] = useState<IngestProgress | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let alive = true;
    let had = false;
    const poll = async () => {
      const r = await fetch(`${MEDIA}/ingest-progress.json`, { cache: 'no-store' }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as IngestProgress | null) : null;
      // Gammel fil (ingest avbrutt): ikke vis den
      const fresh = j && Date.now() - Date.parse(j.updatedAt) < 30_000 ? j : null;
      if (!alive) return;
      setP(fresh);
      if (had && !fresh) done.current?.();
      had = !!fresh;
    };
    void poll();
    const t = window.setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return p;
}

/** Siste logglinje for en bestemt versjon (der ingest faktisk kjørte, ikke «uendret»). */
export function lastLogFor(entries: IngestLogEntry[], a: LoadedAsset): IngestLogEntry | undefined {
  const m = a.manifest;
  return entries.find((e) => e.slug === m.slug && e.variant === m.variant && e.version === m.version && e.status !== 'unchanged');
}

/** Lagrer tittel/artist/album/variantnavn for en låt. Tom streng = bruk standard. */
export async function saveAssetMeta(
  slug: string,
  body: { title?: string; artist?: string; album?: string; variants?: Record<string, string>; palette?: { primary: string; secondary: string } | null; liveOffsetMs?: number | null }
): Promise<void> {
  const r = await fetch(`/api/assets/${encodeURIComponent(slug)}/meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `Lagring feilet (${r.status})`);
  }
}

/** Laster opp nytt coverbilde (dra-og-slipp eller filvelger) til alle versjoner av en låt (slug). */
export async function uploadAssetCover(slug: string, file: File): Promise<AssetManifest[]> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const fallbackMime: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff' };
  const type = file.type && /^image\//.test(file.type) ? file.type : (fallbackMime[ext] ?? 'image/jpeg');
  const r = await fetch(`/api/assets/${encodeURIComponent(slug)}/cover`, {
    method: 'PUT',
    headers: { 'Content-Type': type },
    body: file
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `Opplasting av cover feilet (${r.status})`);
  }
  const { manifests } = (await r.json()) as { manifests: AssetManifest[] };
  notifyCatalogChanged();
  return manifests ?? [];
}

/** Nedskalerer peaks til n søyler (maks per bøtte) for bølgeform-visning. */
export function downsample(values: number[], n: number): number[] {
  if (values.length === 0) return new Array(n).fill(0.15);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * values.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n));
    let m = 0;
    for (let k = a; k < b; k++) m = Math.max(m, values[k] ?? 0);
    out.push(m);
  }
  return out;
}

/** En låt eller et sett, med alle samtidige varianter (Radio Edit, Extended …) samlet på én rad. */
export interface Track {
  slug: string;
  main: LoadedAsset;
  variants: LoadedAsset[];
}

export function groupTracks(assets: LoadedAsset[]): Track[] {
  const by = new Map<string, LoadedAsset[]>();
  for (const a of assets) by.set(a.manifest.slug, [...(by.get(a.manifest.slug) ?? []), a]);
  return [...by.entries()]
    .map(([slug, vs]) => {
      const variants = [...vs].sort((x, y) => (x.manifest.variant ?? '').localeCompare(y.manifest.variant ?? ''));
      return { slug, variants, main: variants.find((v) => v.manifest.variant === null) ?? variants[0]! };
    })
    .sort((a, b) => b.main.manifest.createdAt.localeCompare(a.main.manifest.createdAt));
}

/** Hovedvarianten av en slug (brukes av drops, som peker på slug). */
export function findMain(assets: LoadedAsset[], slug: string): LoadedAsset | undefined {
  return assets.find((a) => a.manifest.slug === slug && a.manifest.variant === null) ?? assets.find((a) => a.manifest.slug === slug);
}

export function variantName(a: LoadedAsset): string {
  return a.manifest.variantLabel ?? 'Original';
}

/** Dekoder sub-bass-konvolutten (Uint8 base64) én gang per asset. */
const subCache = new WeakMap<object, Uint8Array>();
export function subEnvelope(a: LoadedAsset): { frameMs: number; values: Uint8Array } | null {
  const sub = a.analysis?.sub;
  if (!sub) return null;
  let v = subCache.get(sub);
  if (!v) {
    const bin = atob(sub.b64);
    v = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) v[i] = bin.charCodeAt(i);
    subCache.set(sub, v);
  }
  return { frameMs: sub.frameMs, values: v };
}
