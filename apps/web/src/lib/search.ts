import { matchesQuery, type AssetManifest } from '@gv/shared/web';

/**
 * Del 27 pkt. 6: søket viser reelt antall treff (ikke størrelsen på utvalget), «Vis flere» over 30,
 * og forslag når ingenting treffer (nærmeste titler, og et hint om BPM eller toneart).
 */
export const PAGE = 30;

export interface SearchResult<T> {
  results: T[];
  /** Alle treff, ikke bare de som vises. */
  total: number;
  /** Ved null treff: titler som ligner (stavefeil, manglende ord). */
  suggestions: string[];
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9æøå ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice-likhet på bokstavpar (0–1). Tåler stavefeil og byttet rekkefølge. */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(fold(a));
  const y = bigrams(fold(b));
  let inter = 0;
  let nx = 0;
  let ny = 0;
  for (const v of x.values()) nx += v;
  for (const v of y.values()) ny += v;
  for (const [g, v] of x) inter += Math.min(v, y.get(g) ?? 0);
  return nx + ny ? (2 * inter) / (nx + ny) : 0;
}

export function searchCatalog<T extends { manifest: AssetManifest }>(pool: T[], query: string, limit = PAGE): SearchResult<T> {
  const q = query.trim();
  const all = q ? pool.filter((a) => matchesQuery(a.manifest, q)) : pool;
  let suggestions: string[] = [];
  if (q && all.length === 0) {
    // Sammenlign med hele tittelen og med hvert ord, så «blu fier» finner «Blue Fire»
    const scored = new Map<string, number>();
    for (const a of pool) {
      const t = a.manifest.title;
      const words = fold(t).split(' ');
      const s = Math.max(titleSimilarity(q, t), ...fold(q).split(' ').map((w) => Math.max(...words.map((x) => titleSimilarity(w, x))) * 0.9));
      if (s >= 0.45 && (scored.get(t) ?? 0) < s) scored.set(t, s);
    }
    suggestions = [...scored.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([t]) => t);
  }
  return { results: all.slice(0, limit), total: all.length, suggestions };
}
