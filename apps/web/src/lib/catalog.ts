import { useEffect, useState } from 'react';
import type { Analysis, AssetManifest, CatalogIndex } from '@gv/shared/web';

/**
 * Fase 1: leser filene ingest-motoren skrev til media/ (servert av Vite).
 * Fase 2: samme form hentes fra Supabase (`assets`) og media-workeren.
 */
export interface LoadedAsset {
  manifest: AssetManifest;
  analysis: Analysis | null;
  /** Mappe-URL for denne versjonen, f.eks. /blue-fire/v2/ */
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
    idx = await getJson<CatalogIndex>('/index.json');
  } catch (error) {
    // Ingen katalog ennå er normalt ved første oppstart; andre feil må vises til brukeren.
    if (error instanceof Error && error.message === '404 /index.json') return [];
    throw error;
  }
  if (!idx || !Array.isArray(idx.assets)) throw new Error('index.json har ugyldig format');
  // Kun nyeste versjon per slug + variant
  const latest = new Map<string, CatalogIndex['assets'][number]>();
  for (const a of idx.assets) {
    const k = `${a.slug}::${a.variant ?? ''}`;
    const cur = latest.get(k);
    if (!cur || a.version > cur.version) latest.set(k, a);
  }
  return Promise.all(
    [...latest.values()].map(async (entry) => {
      const base = `/${entry.manifest.replace(/manifest\.json$/, '')}`;
      const manifest = await getJson<AssetManifest>(`/${entry.manifest}`);
      const analysis = await getJson<Analysis>(`${base}${manifest.files.analysis}`).catch(() => null);
      return { manifest, analysis, base };
    })
  );
}

export function useCatalog() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ assets: LoadedAsset[]; loading: boolean; error: string | null }>({
    assets: [],
    loading: true,
    error: null
  });
  useEffect(() => {
    let alive = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    loadCatalog()
      .then((assets) => {
        if (alive) setState({ assets, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (alive) {
          setState({
            assets: [],
            loading: false,
            error: error instanceof Error ? error.message : 'Ukjent feil ved kataloglasting'
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
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
