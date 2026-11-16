import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { energyFeatures, preferredVersion, type Analysis, type AssetManifest, type CatalogIndex, type EnergyFeatures } from '@gv/shared';
import { readDupeReport } from './dupes';

/**
 * Én samlet katalog (GET /api/catalog) i stedet for to kall per låt (manifest + analysis.json på ~100 kB).
 * Listene får manifestet og en lett analyse (bølgeform med SLIM_BUCKETS punkter, uten spektrumrammer og
 * sub-bass). Full analyse hentes først når en låt åpnes eller spilles.
 * Filene leses bare på nytt når mtime er endret.
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

type Cached = { key: string; manifest: AssetManifest; analysis: Analysis | null; features: EnergyFeatures };

export function createCatalogBundler(mediaDir: string) {
  const media = path.resolve(mediaDir);
  const cache = new Map<string, Cached>();
  const mtime = (f: string) => stat(f).then((s) => s.mtimeMs, () => 0);

  async function entry(rel: string): Promise<Cached | null> {
    const mf = path.join(media, rel);
    const mKey = await mtime(mf);
    if (!mKey) return null;
    const hit = cache.get(rel);
    // Manifestet peker på analysefila; sjekk begge mtime-ene
    if (hit) {
      const af = hit.manifest.files.analysis ? path.join(path.dirname(mf), hit.manifest.files.analysis) : '';
      if (hit.key === `${mKey}:${af ? await mtime(af) : 0}`) return hit;
    }
    const manifest = JSON.parse(await readFile(mf, 'utf8')) as AssetManifest;
    const af = manifest.files.analysis ? path.join(path.dirname(mf), manifest.files.analysis) : '';
    const aKey = af ? await mtime(af) : 0;
    const full = af && aKey ? (JSON.parse(await readFile(af, 'utf8')) as Analysis) : null;
    // Energiscoren til settbyggeren regnes fra full analyse (den lette gir andre transienter)
    const c = { key: `${mKey}:${aKey}`, manifest, analysis: full ? slimAnalysis(full) : null, features: energyFeatures(manifest, full) };
    cache.set(rel, c);
    return c;
  }

  return async function bundle(dataDir?: string): Promise<CatalogBundle | null> {
    let idx: CatalogIndex;
    try {
      idx = JSON.parse(await readFile(path.join(media, 'index.json'), 'utf8')) as CatalogIndex;
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
    // Noen få om gangen: disken (Google Drive-synk) tåler ikke hundrevis av samtidige lesinger
    for (let i = 0; i < picked.length; i += 16) {
      const got = await Promise.all(picked.slice(i, i + 16).map((e) => entry(e.manifest).catch(() => null)));
      // Skjulte (f.eks. testlåta fra fixtures) vises ikke i listene
      for (const g of got) if (g && !g.manifest.hidden) assets.push({ manifest: g.manifest, analysis: g.analysis, features: g.features });
    }
    const dupes = dataDir ? ((await readDupeReport(dataDir))?.byKey ?? {}) : {};
    return { schema: 1, index: idx.assets, assets, groups: dupes };
  };
}
