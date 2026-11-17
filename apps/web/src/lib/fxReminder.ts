import { explainTransition, placeSteps, reminderBarsLeft, toSbTracks, type FxIdea, type FxPreset } from '@gv/shared/web';
import type { LoadedAsset } from './catalog';
import { transitionPreset } from './fx';

/**
 * Del 18 pkt. 9: påminnelsen før mikspunktet, regnet ut én gang per overgang. Brukes av påminnelsen på skjermen
 * og sendes til Android-tjenesten, som viser den i varselet også når skjermen er av (JavaScript står da stille).
 */
export interface ReminderPlan {
  /** Mikspunktet i låta som spilles (A), ms. */
  outAtMs: number;
  barMs: number;
  overlapBars: number;
  preset: FxPreset;
  /** Stegene i låta som spilles (deck A), i rekkefølge. */
  steps: Array<{ atMs: number; text: string }>;
  /** B sitt cue (ms i neste låt) og stegene der (deck B og begge). */
  inAtMs: number;
  inSteps: Array<{ atMs: number; text: string }>;
}

export function reminderPlan(cur: LoadedAsset, next: LoadedAsset | undefined, lastTransition: boolean, ideas: FxIdea[]): ReminderPlan | null {
  if (!next) return null;
  const [a, b] = toSbTracks([
    { manifest: cur.manifest, analysis: null },
    { manifest: next.manifest, analysis: null }
  ]);
  if (!a || !b) return null;
  const info = explainTransition(a, b);
  const { preset } = transitionPreset(a, b, info, lastTransition, ideas);
  const placed = placeSteps(preset, info.mix, a.bpm, b.bpm);
  const steps = placed.filter((s) => s.track === 'A').map((s) => ({ atMs: s.atMs, text: s.text }));
  const inSteps = placed.filter((s) => s.track === 'B').map((s) => ({ atMs: s.atMs, text: s.text }));
  return { outAtMs: info.mix.outAtMs, barMs: a.bpm ? 240_000 / a.bpm : 2000, overlapBars: info.mix.bars, preset, steps, inAtMs: info.mix.inAtMs, inSteps };
}

/** Teksten som vises akkurat nå, eller null utenfor de siste 30 sekundene. Samme regel som Android-tjenesten. */
export function reminderText(positionMs: number, p: ReminderPlan): { head: string; step: string | null } | null {
  const bars = reminderBarsLeft(positionMs, p.outAtMs, p.barMs, p.overlapBars);
  if (bars === null) return null;
  const step = p.steps.find((s) => s.atMs >= positionMs) ?? p.steps[p.steps.length - 1];
  return { head: `Neste: ${p.preset.name} – ${bars > 0 ? `${bars} takter igjen` : 'nå'}`, step: step?.text ?? null };
}

/** Det Android-tjenesten trenger (ingen funksjoner, bare tall og tekst). */
export const nativeReminder = (p: ReminderPlan | null) =>
  p ? { outAtMs: Math.round(p.outAtMs), barMs: p.barMs, overlapBars: p.overlapBars, name: p.preset.name, steps: p.steps.map((s) => ({ atMs: Math.round(s.atMs), text: s.text })) } : null;
