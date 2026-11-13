import { useEffect, useState } from 'react';
import type { Analysis, AssetManifest, CatalogIndex } from '@gv/shared/web';

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
}

export function assetUrl(a: LoadedAsset, file: string | null): string | null {
  return file ? `${a.base}${file}` : null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

export async function loadCatalog(): Promise<LoadedAsset[]> {
  let idx: CatalogIndex;
  try {
    idx = await getJson<CatalogIndex>(`${MEDIA}/index.json`);
  } catch {
    return [];
  }
  // Kun nyeste versjon per slug + variant
  const latest = new Map<string, CatalogIndex['assets'][number]>();
  for (const a of idx.assets) {
    const k = `${a.slug}::${a.variant ?? ''}`;
    const cur = latest.get(k);
    if (!cur || a.version > cur.version) latest.set(k, a);
  }
  return Promise.all(
    [...latest.values()].map(async (entry) => {
      const base = `${MEDIA}/${entry.manifest.replace(/manifest\.json$/, '')}`;
      const manifest = await getJson<AssetManifest>(`${MEDIA}/${entry.manifest}`);
      const analysis = await getJson<Analysis>(`${base}${manifest.files.analysis}`).catch(() => null);
      return { manifest, analysis, base };
    })
  );
}

export function useCatalog() {
  const [state, setState] = useState<{ assets: LoadedAsset[]; loading: boolean }>({ assets: [], loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    loadCatalog().then((assets) => alive && setState({ assets, loading: false }));
    return () => {
      alive = false;
    };
  }, [tick]);
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

/** Siste logglinje for en bestemt versjon (der ingest faktisk kjørte, ikke «uendret»). */
export function lastLogFor(entries: IngestLogEntry[], a: LoadedAsset): IngestLogEntry | undefined {
  const m = a.manifest;
  return entries.find((e) => e.slug === m.slug && e.variant === m.variant && e.version === m.version && e.status !== 'unchanged');
}

/** Lagrer tittel/artist/album/variantnavn for en låt. Tom streng = bruk standard. */
export async function saveAssetMeta(slug: string, body: { title?: string; artist?: string; album?: string; variants?: Record<string, string> }): Promise<void> {
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
