import { create } from 'zustand';
import { simParts, type SimFeatures } from '@gv/shared/web';

/**
 * Del 20 D: Knuts egne stil-tagger («Deep», «Tech», «Cyber-Soul» og egne navn). Ett trykk per låt. Lagres på PC-en
 * (data/tags.json) per låt, så de følger med til nye versjoner. Vault foreslår tagger for nye låter ut fra likhet
 * med låtene som er tagget (BPM, groove, bass, energi, tekstur) – ingen sjangergjenkjenning fra lyd.
 */
export const START_TAGS = ['Deep', 'Tech', 'Cyber-Soul'];

interface Store {
  tags: Record<string, string[]>;
  names: string[];
  loaded: boolean;
  load: () => Promise<void>;
  toggle: (slug: string, tag: string) => Promise<void>;
  addName: (name: string) => Promise<void>;
}

async function put(body: unknown) {
  const r = await fetch('/api/tags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { tags?: Record<string, string[]>; names?: string[]; error?: string };
  if (!r.ok) throw new Error(j.error ?? `Feil ${r.status}`);
  return j as { tags: Record<string, string[]>; names: string[] };
}

export const useTags = create<Store>((set, get) => ({
  tags: {},
  names: START_TAGS,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    const r = await fetch('/api/tags', { cache: 'no-store' }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { tags: Record<string, string[]>; names: string[] } | null) : null;
    set({ tags: j?.tags ?? {}, names: mergeNames(j?.names ?? []), loaded: true });
  },
  toggle: async (slug, tag) => {
    const cur = get().tags[slug] ?? [];
    const next = cur.some((t) => t.toLowerCase() === tag.toLowerCase()) ? cur.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...cur, tag];
    set({ tags: { ...get().tags, [slug]: next } }); // med en gang (ett trykk)
    const j = await put({ slug, tags: next });
    set({ tags: j.tags, names: mergeNames(j.names) });
  },
  addName: async (name) => {
    const n = name.trim().slice(0, 30);
    if (!n || get().names.some((x) => x.toLowerCase() === n.toLowerCase())) return;
    const j = await put({ names: [...get().names, n] });
    set({ names: mergeNames(j.names) });
  }
}));

const mergeNames = (saved: string[]) => [...new Set([...START_TAGS, ...saved])];

/**
 * Forslag til tagger for en låt: de taggene som går igjen blant de 5 mest like taggede låtene (likhet uten tagger),
 * når likheten er høy nok. Ren funksjon (testes).
 */
export function suggestTags(target: SimFeatures, tagged: Array<{ sim: SimFeatures; tags: string[] }>, k = 5, min = 0.72): string[] {
  const scored = tagged
    .map((t) => {
      const p = simParts({ ...target, tags: null }, { ...t.sim, tags: null });
      const parts = Object.values(p).filter((v): v is number => v != null);
      return { tags: t.tags, s: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0 };
    })
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, k);
  const count = new Map<string, number>();
  for (const x of scored) for (const t of x.tags) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].filter(([, n]) => n >= Math.max(2, Math.ceil(scored.length / 2))).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}
