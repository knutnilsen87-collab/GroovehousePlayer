import { create } from 'zustand';
import { camelotDistance, simParts, similarity, simOf, tempoDiff, type SbTrack, type SimWeights, DEFAULT_SIM_WEIGHTS } from '@gv/shared/web';

/**
 * Del 20 D pkt. 17 og 19: Vibe Shifter og «Match groove» for «Passer etter …».
 *  - Strammere / Bredere: Camelot ±0 / ±1 / ±2 og BPM ±2 / ±3 / ±6 %.
 *  - Energi ↑ / → / ↓: bare låter som går opp, holder seg, eller går ned.
 *  - Stil: Knuts egne tagger. «Skift mot Tech» glir gradvis over 2–3 låter (sterkere for hver låt som spilles).
 *  - Match groove: groove (swing, tetthet, 4/4, hats) og bass teller mest, i tillegg til Camelot og BPM.
 */
export type Tightness = 'tight' | 'normal' | 'wide';
export const TIGHT: Record<Tightness, { camelot: number; bpmPct: number; label: string }> = {
  tight: { camelot: 0, bpmPct: 2, label: 'Strammere' },
  normal: { camelot: 1, bpmPct: 3, label: 'Normal' },
  wide: { camelot: 2, bpmPct: 6, label: 'Bredere' }
};
export type EnergyDir = 'up' | 'flat' | 'down' | null;

export interface VibeState {
  tight: Tightness;
  energy: EnergyDir;
  style: string | null;
  /** Hvor mange låter siden stil-skiftet startet (0 = nettopp). */
  styleStep: number;
  matchGroove: boolean;
  set: (p: Partial<Omit<VibeState, 'set' | 'advance'>>) => void;
  advance: () => void;
}
export const useVibe = create<VibeState>((set, get) => ({
  tight: 'normal',
  energy: null,
  style: null,
  styleStep: 0,
  matchGroove: false,
  set: (p) => set({ ...p, ...(p.style !== undefined && p.style !== get().style ? { styleStep: 0 } : {}) }),
  advance: () => set({ styleStep: get().styleStep + 1 })
}));

const GROOVE_WEIGHTS: SimWeights = { ...DEFAULT_SIM_WEIGHTS, groove: 3, bass: 2, tags: 0, energy: 0.6, texture: 1 };

export interface Ranked {
  t: SbTrack;
  /** Groove-likhet 0–100 (null = mangler analyse). */
  groovePct: number | null;
  score: number;
}

/** Rangerer kandidater etter låta som spilles. Ren funksjon (testes). */
export function rankMatches(ref: SbTrack, cands: SbTrack[], v: Pick<VibeState, 'tight' | 'energy' | 'style' | 'styleStep' | 'matchGroove'>): Ranked[] {
  const lim = TIGHT[v.tight];
  // Stil-skiftet glir inn: 1/3 med en gang, full styrke etter 2–3 låter
  const styleW = v.style ? Math.min(1, (v.styleStep + 1) / 3) : 0;
  const out: Ranked[] = [];
  for (const t of cands) {
    if (t.slug === ref.slug) continue;
    const kd = camelotDistance(ref.camelot, t.camelot);
    if (kd != null && kd > lim.camelot && !(kd === 1 && lim.camelot === 0 && relative(ref.camelot, t.camelot))) continue;
    const d = tempoDiff(ref.bpm, t.bpm);
    if (d != null && Math.abs(d) * 100 > lim.bpmPct) continue;
    const dE = t.energy - ref.energy;
    if (v.energy === 'up' && dE < 0.3) continue;
    if (v.energy === 'down' && dE > -0.3) continue;
    if (v.energy === 'flat' && Math.abs(dE) > 1) continue;
    const g = simParts(simOf(ref), simOf(t)).groove;
    let score = similarity(simOf(ref), simOf(t), v.matchGroove ? GROOVE_WEIGHTS : DEFAULT_SIM_WEIGHTS);
    if (styleW && (t.tags ?? []).some((x) => x.toLowerCase() === v.style!.toLowerCase())) score += 0.35 * styleW;
    out.push({ t, groovePct: g == null ? null : Math.round(g * 100), score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Relativ dur/moll (8A ↔ 8B) regnes som «samme» også i Strammere. */
const relative = (a: string | null, b: string | null) => !!a && !!b && a.slice(0, -1) === b.slice(0, -1) && a !== b;
