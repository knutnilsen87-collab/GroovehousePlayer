/**
 * Felles likhetsmål for «Lag sett fra denne», «Mer som denne» (del 20 E) og albumbyggeren (del 26).
 *
 * Hver dimensjon gir en likhet 0–1. Totalen er et vektet snitt over dimensjonene **begge låtene har**.
 * Mangler en dimensjon (groove før del 20 A, stil-tagger før del 20 D), teller den ikke, og vektene til de
 * andre fordeles på nytt. Når groove og tagger kommer, fylles bare feltene ut – ingen omskriving.
 */

export interface SimFeatures {
  bpm: number | null;
  camelot: string | null;
  /** 1–10 (settbyggerens energiscore). */
  energy: number | null;
  /** Bassandel i dropene, 0–1 (EnergyFeatures.bass). */
  bass?: number | null;
  /** Transient-tetthet i diskanten, 0–1 (EnergyFeatures.transients). */
  transients?: number | null;
  lufs?: number | null;
  /** Del 20 A (kommer): groove fra trommestammen. */
  groove?: { swing?: number | null; density?: number | null; fourOnFloor?: boolean | null; hats?: number | null } | null;
  /** Del 20 D (kommer): Knuts stil-tagger («Deep», «Tech» …). */
  tags?: string[] | null;
}

export type SimDim = 'bpm' | 'key' | 'energy' | 'bass' | 'texture' | 'lufs' | 'groove' | 'tags';
export type SimWeights = Record<SimDim, number>;
export const DEFAULT_SIM_WEIGHTS: SimWeights = { bpm: 1, key: 1, energy: 1, bass: 0.8, texture: 0.5, lufs: 0.3, groove: 1, tags: 1.2 };

/** Avstand på Camelot-hjulet (0 = samme, 1 = nabo eller relativ, … 6 = motsatt). */
export function camelotDistance(a: string | null, b: string | null): number | null {
  const pa = a?.match(/^(\d{1,2})([AB])$/i);
  const pb = b?.match(/^(\d{1,2})([AB])$/i);
  if (!pa || !pb) return null;
  const na = Number(pa[1]);
  const nb = Number(pb[1]);
  const d = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
  return d + (pa[2]!.toUpperCase() === pb[2]!.toUpperCase() ? 0 : 1);
}

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Likhet per dimensjon; null = mangler hos minst én av dem. */
export function simParts(a: SimFeatures, b: SimFeatures): Record<SimDim, number | null> {
  // Tempo: halv/dobbel regnes som nær (house 62 ≈ 124). Full likhet til 2 %, null ved 12 %.
  let bpm: number | null = null;
  if (num(a.bpm) && num(b.bpm) && a.bpm > 0 && b.bpm > 0) {
    const r = Math.min(...[1, 0.5, 2].map((f) => Math.abs(a.bpm! * f - b.bpm!) / b.bpm!));
    bpm = clamp01(1 - Math.max(0, r - 0.02) / 0.1);
  }
  const kd = camelotDistance(a.camelot, b.camelot);
  const key = kd == null ? null : clamp01(1 - kd / 4);
  const energy = num(a.energy) && num(b.energy) ? clamp01(1 - Math.abs(a.energy - b.energy) / 5) : null;
  const bass = num(a.bass) && num(b.bass) ? clamp01(1 - Math.abs(a.bass - b.bass) / 0.5) : null;
  const texture = num(a.transients) && num(b.transients) ? clamp01(1 - Math.abs(a.transients - b.transients) / 0.3) : null;
  const lufs = num(a.lufs) && num(b.lufs) ? clamp01(1 - Math.abs(a.lufs - b.lufs) / 6) : null;
  let groove: number | null = null;
  if (a.groove && b.groove) {
    const g: number[] = [];
    if (num(a.groove.swing) && num(b.groove.swing)) g.push(clamp01(1 - Math.abs(a.groove.swing - b.groove.swing) / 0.12));
    if (num(a.groove.density) && num(b.groove.density)) g.push(clamp01(1 - Math.abs(a.groove.density - b.groove.density) / 0.5));
    if (num(a.groove.hats) && num(b.groove.hats)) g.push(clamp01(1 - Math.abs(a.groove.hats - b.groove.hats) / 0.5));
    if (a.groove.fourOnFloor != null && b.groove.fourOnFloor != null) g.push(a.groove.fourOnFloor === b.groove.fourOnFloor ? 1 : 0);
    groove = g.length ? g.reduce((s, x) => s + x, 0) / g.length : null;
  }
  let tags: number | null = null;
  if (a.tags?.length && b.tags?.length) {
    const sa = new Set(a.tags.map((t) => t.toLowerCase()));
    const sb = new Set(b.tags.map((t) => t.toLowerCase()));
    const inter = [...sa].filter((t) => sb.has(t)).length;
    tags = inter / new Set([...sa, ...sb]).size; // Jaccard
  }
  return { bpm, key, energy, bass, texture, lufs, groove, tags };
}

/** Samlet likhet 0–1 (vektet snitt over dimensjonene begge har). */
export function similarity(a: SimFeatures, b: SimFeatures, w: SimWeights = DEFAULT_SIM_WEIGHTS): number {
  const p = simParts(a, b);
  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(p) as SimDim[]) {
    const v = p[k];
    if (v == null || !(w[k] > 0)) continue;
    sum += v * w[k];
    wsum += w[k];
  }
  return wsum ? sum / wsum : 0;
}
