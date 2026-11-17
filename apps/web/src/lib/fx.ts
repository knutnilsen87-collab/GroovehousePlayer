import { create } from 'zustand';
import { BUILT_IN_PRESETS, cueName, mostUsed, placeSteps, presetById, presetFor, suggestPreset, type FxIdea, type FxPreset, type SbTrack, type TransitionInfo } from '@gv/shared/web';

/**
 * Del 18: overgangs-presets i klienten. Presetene er en plan og en huskelapp – Vault spiller ingen effekter.
 * Idéer lagres med ett trykk (uten dialog), og meldingen har «Angre».
 */
interface FxStore {
  custom: FxPreset[];
  ideas: FxIdea[];
  /** Del 20 C: tommel ned på en ferdig overgang (A>B>preset) – foreslås ikke igjen for det paret. */
  dislikes: string[];
  loaded: boolean;
  /** Siste lagrede idé (for «Angre»-meldingen). */
  lastSaved: { idea: FxIdea; text: string } | null;
  load: () => Promise<void>;
  saveIdea: (from: string, to: string | null, preset: string, note?: string) => Promise<FxIdea | null>;
  undo: (id: string) => Promise<void>;
  dismiss: () => void;
  savePreset: (p: FxPreset) => Promise<void>;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Feil (${r.status})`);
  return j;
}

export const useFx = create<FxStore>((set, get) => ({
  custom: [],
  ideas: [],
  dislikes: [],
  loaded: false,
  lastSaved: null,
  load: async () => {
    try {
      const r = await api<{ presets: FxPreset[]; ideas: FxIdea[] }>('/api/fx');
      const fb = await api<{ items: Array<{ from: string; to: string; preset: string; vote: number }> }>('/api/renders/feedback').catch(() => ({ items: [] }));
      set({ custom: r.presets, ideas: r.ideas, dislikes: fb.items.filter((x) => x.vote < 0).map((x) => `${x.from}>${x.to}>${x.preset}`), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  saveIdea: async (from, to, preset, note) => {
    try {
      const { idea } = await api<{ idea: FxIdea }>('/api/fx/ideas', 'POST', { from, to, preset, note });
      const p = presetById(allPresets(), preset);
      set({ ideas: [...get().ideas, idea], lastSaved: { idea, text: `${p?.name ?? preset} lagret ${to ? 'på overgangen' : 'ut av låta'}` } });
      return idea;
    } catch {
      return null;
    }
  },
  undo: async (id) => {
    await api('/api/fx/ideas/' + id, 'DELETE').catch(() => undefined);
    set({ ideas: get().ideas.filter((i) => i.id !== id), lastSaved: null });
  },
  dismiss: () => set({ lastSaved: null }),
  savePreset: async (p) => {
    const r = await api<{ presets: FxPreset[] }>(`/api/fx/presets/${encodeURIComponent(p.id)}`, 'PUT', p);
    set({ custom: r.presets });
  }
}));

/** Del 20 C: tommel opp på en overgang = idé for akkurat dette paret (læringen). */
export const captureIdeaFor = (from: string, to: string, preset: string) => useFx.getState().saveIdea(from, to, preset);

export const allPresets = () => [...BUILT_IN_PRESETS, ...useFx.getState().custom];
export const useAllPresets = () => {
  const custom = useFx((s) => s.custom);
  return [...BUILT_IN_PRESETS, ...custom];
};
export const useMostUsed = (n = 6) => {
  const ideas = useFx((s) => s.ideas);
  return mostUsed(ideas, useAllPresets(), n);
};

/** Preset for overgangen a → b: idé/læring først, ellers regelen fra settbyggeren. */
export function transitionPreset(a: SbTrack, b: SbTrack, info: TransitionInfo, last: boolean, ideas: FxIdea[]): { preset: FxPreset; reason: string; learned: boolean } {
  const rule = suggestPreset({ info, energyA: a.energy, energyB: b.energy, last });
  let pick = presetFor(ideas, a.slug, b.slug, rule);
  // Del 20 C: tommel ned på denne overgangen med dette presetet → en annen type overgang
  if (useFx.getState().dislikes.includes(`${a.slug}>${b.slug}>${pick.id}`)) {
    const alt = pick.id === 'echo-out' ? 'cut-on-drop' : 'echo-out';
    pick = { id: alt, reason: 'Du ga tommel ned på forrige forslag her', learned: true };
  }
  const preset = presetById(allPresets(), pick.id) ?? presetById(allPresets(), rule.id)!;
  return { preset, reason: pick.reason, learned: pick.learned };
}

/** Cues til rekordbox for en overgang: A-stegene i låt A og B-stegene i låt B. */
export function fxCuesFor(p: FxPreset, a: SbTrack, b: SbTrack, info: TransitionInfo) {
  const placed = placeSteps(p, info.mix, a.bpm, b.bpm);
  return {
    a: placed.filter((s) => s.track === 'A').map((s) => ({ atMs: s.atMs, name: cueName(p.name, s.text) })),
    b: placed.filter((s) => s.track === 'B').map((s) => ({ atMs: s.atMs, name: cueName(p.name, s.text) }))
  };
}
