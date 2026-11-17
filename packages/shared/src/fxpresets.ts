import type { TransitionInfo } from './setbuilder';

/**
 * Del 18: overgangs-presets (FX-planer). En PLAN og en huskelapp, ikke lydbehandling: Vault spiller
 * ingen effekter. Stegene festes til takter relativt til mikspunktet (takt 0 = A begynner å mikses ut).
 */
export type FxDeck = 'A' | 'B' | 'AB';
export interface FxStep {
  /** Takt relativt til mikspunktet (negativ = før). */
  bar: number;
  deck: FxDeck;
  text: string;
}
export interface FxPreset {
  id: string;
  name: string;
  /** Kort ikon-tegn (emoji eller symbol). */
  icon: string;
  /** #RRGGBB – brukes på brikken og på hot cue i rekordbox. */
  color: string;
  /** Lengde i takter. */
  bars: number;
  deck: FxDeck;
  steps: FxStep[];
  builtIn?: boolean;
}

const P = (id: string, name: string, icon: string, color: string, bars: number, deck: FxDeck, steps: Array<[number, FxDeck, string]>): FxPreset => ({
  id,
  name,
  icon,
  color,
  bars,
  deck,
  steps: steps.map(([bar, d, text]) => ({ bar, deck: d, text })),
  builtIn: true
});

/** Standardsettet (pkt. 1). Kan dupliseres og endres; egne lagres i data/fx-presets.json. */
export const BUILT_IN_PRESETS: FxPreset[] = [
  P('long-blend-32', 'Lang blend 32', '≋', '#3CB4FF', 32, 'AB', [[-16, 'B', 'B inn, bass av'], [0, 'AB', 'EQ-blend starter'], [16, 'AB', 'Bass swap A→B'], [32, 'A', 'A ute']]),
  P('bass-swap-16', 'Bass swap 16', '⇄', '#2FD27A', 16, 'AB', [[-16, 'B', 'B inn, bass av'], [0, 'AB', 'Bytt bass A→B'], [8, 'A', 'A ut med HPF']]),
  P('filter-fade', 'Filter fade', '◢', '#8C7BFF', 16, 'A', [[0, 'A', 'HPF opp på A'], [0, 'B', 'B inn rent'], [16, 'A', 'A ute']]),
  P('echo-out', 'Echo out', '◎', '#FF5FD0', 4, 'A', [[-4, 'A', 'Echo/delay på A'], [0, 'B', 'B starter på frase'], [0, 'A', 'A av']]),
  P('reverb-wash', 'Reverb wash', '☁', '#7FD1FF', 8, 'A', [[-4, 'A', 'Reverb-hale på A'], [0, 'A', 'A av'], [4, 'B', 'B inn etter break']]),
  P('cut-on-drop', 'Cut på drop', '✂', '#FF6B4A', 1, 'AB', [[-1, 'B', 'B klar på drop'], [0, 'AB', 'Hard cut til B sitt drop']]),
  P('loop-build', 'Loop & build', '↻', '#FFB23F', 8, 'A', [[-8, 'A', 'Loop 4 takter'], [-4, 'A', 'Loop 2'], [-2, 'A', 'Loop 1'], [0, 'B', 'B inn på drop']]),
  P('loop-roll', 'Loop roll / stutter', '⋯', '#FFD84A', 1, 'A', [[-1, 'A', 'Kort roll'], [0, 'B', 'B inn']]),
  P('backspin', 'Backspin / brake', '↺', '#FF4A6E', 1, 'A', [[0, 'A', 'Stopp A (brake)'], [0, 'B', 'B rett inn']]),
  P('acapella-layer', 'Acapella-lag', '♪', '#C38BFF', 16, 'B', [[-16, 'B', 'B sin intro under A sitt break'], [0, 'AB', 'Blend ut A']]),
  P('energy-lift', 'Energiløft (+2/+7)', '⤴', '#FF8A3D', 4, 'AB', [[-4, 'B', 'B klar (toneløft)'], [0, 'AB', 'Kort overgang til B']]),
  P('slow-fade', 'Rolig fade', '◡', '#6F86FF', 32, 'A', [[0, 'A', 'Lang volumfade ned'], [32, 'A', 'A ute']])
];

export const presetById = (list: FxPreset[], id: string | null | undefined) => (id ? list.find((p) => p.id === id) : undefined);

// ---------------------------------------------------------------- automatisk forslag (pkt. 3)

export interface SuggestInput {
  info: Pick<TransitionInfo, 'relation' | 'tempoPct' | 'mix'> & { score?: Pick<TransitionInfo['score'], 'vocalClash' | 'bassClash' | 'swingDiff'> };
  /** Energi 1–10 for A og B, hvis kjent. */
  energyA?: number | null;
  energyB?: number | null;
  /** Siste overgang i settet. */
  last?: boolean;
}

/** Hvilken preset settbyggeren velger for en overgang, og hvorfor. */
export function suggestPreset(x: SuggestInput): { id: string; reason: string } {
  if (x.last) return { id: 'slow-fade', reason: 'Siste låt' };
  const { relation, tempoPct, mix } = x.info;
  const dE = x.energyA != null && x.energyB != null ? x.energyB - x.energyA : 0;
  if (relation === 'clash') return { id: dE >= 2 ? 'cut-on-drop' : 'echo-out', reason: 'Toneartskollisjon' };
  // Del 20 B: vokal oppå vokal eller ulik groove gir kort overgang, ikke lang blend
  if (x.info.score?.vocalClash) return { id: dE >= 2 ? 'loop-build' : 'echo-out', reason: 'Vokal oppå vokal' };
  if (x.info.score?.swingDiff != null && x.info.score.swingDiff > 4 && mix.kind === 'short') return { id: 'cut-on-drop', reason: `Ulik swing (${x.info.score.swingDiff} %)` };
  if (tempoPct != null && Math.abs(tempoPct) > 3) return { id: dE >= 2 ? 'loop-build' : 'echo-out', reason: `Tempoavvik ${Math.abs(tempoPct).toFixed(1)} %` };
  if (dE >= 3) return { id: 'loop-build', reason: 'Stort hopp opp i energi' };
  if (dE <= -2) return { id: mix.bars >= 16 ? 'filter-fade' : 'reverb-wash', reason: 'Ned i energi' };
  if (relation === 'boost2' || relation === 'boost7') return { id: 'energy-lift', reason: 'Energiløft i Camelot' };
  if (mix.bars >= 32) return { id: 'long-blend-32', reason: 'God harmoni, lange intro/outro' };
  if (mix.bars >= 16) return { id: 'bass-swap-16', reason: x.info.score?.bassClash ? 'Bass i begge låtene' : 'God harmoni, 16 takter' };
  return { id: 'echo-out', reason: 'Kort intro/outro' };
}

// ---------------------------------------------------------------- festing til takter (pkt. 4)

/** Runder en takt til nærmeste frasegrense (8 takter) i samme retning, så stegene treffer frasene. */
export function snapToPhrase(bar: number, phrase = 8): number {
  if (Math.abs(bar) < phrase) return bar; // korte steg (1–4 takter) står der de er
  return Math.round(bar / phrase) * phrase;
}

export interface PlacedStep extends FxStep {
  /** Tid i låt A (deck A) eller B (deck B / AB) i ms. */
  atMs: number;
  track: 'A' | 'B';
}
/**
 * Plasserer stegene: takt 0 = A sitt mikspunkt (outAtMs) = øyeblikket B starter fra sitt cue (inAtMs).
 * Steg for deck A regnes i A sin tid, steg for B (og AB) i B sin tid. Tider før låtstart settes til 0.
 */
export function placeSteps(p: FxPreset, mix: { outAtMs: number; inAtMs: number }, bpmA: number | null, bpmB: number | null): PlacedStep[] {
  const barA = bpmA && bpmA > 0 ? 240_000 / bpmA : 2000;
  const barB = bpmB && bpmB > 0 ? 240_000 / bpmB : barA;
  return p.steps.map((s) => {
    const bar = snapToPhrase(s.bar);
    return s.deck === 'A'
      ? { ...s, bar, track: 'A' as const, atMs: Math.max(0, Math.round(mix.outAtMs + bar * barA)) }
      : { ...s, bar, track: 'B' as const, atMs: Math.max(0, Math.round(mix.inAtMs + bar * barB)) };
  });
}

// ---------------------------------------------------------------- idéer og læring (pkt. 5–7)

export interface FxIdea {
  id: string;
  /** Overgang A → B (slug), eller bare A («ut av denne»). */
  from: string;
  to: string | null;
  preset: string;
  note?: string;
  at: string;
}
export const pairKey = (from: string, to: string | null) => `${from}>${to ?? '*'}`;

/**
 * Pkt. 5 og 7: preset for en overgang. Først en idé for akkurat dette paret, så «ut av denne»-idéer,
 * så læring (samme preset ut av A eller inn i B minst to ganger), ellers regelen.
 */
export function presetFor(ideas: FxIdea[], from: string, to: string, fallback: { id: string; reason: string }): { id: string; reason: string; learned: boolean } {
  const latest = (xs: FxIdea[]) => xs.sort((a, b) => b.at.localeCompare(a.at))[0];
  const exact = latest(ideas.filter((i) => i.from === from && i.to === to));
  if (exact) return { id: exact.preset, reason: 'Din idé for denne overgangen', learned: true };
  const outOf = latest(ideas.filter((i) => i.from === from && i.to === null));
  if (outOf) return { id: outOf.preset, reason: 'Din idé: ut av denne', learned: true };
  const count = new Map<string, number>();
  for (const i of ideas) if (i.from === from || i.to === to) count.set(i.preset, (count.get(i.preset) ?? 0) + 1);
  const best = [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  if (best) return { id: best[0], reason: `Du har valgt den ${best[1]} ganger her`, learned: true };
  return { ...fallback, learned: false };
}

/** De N mest brukte presetene (ett-trykks-raden), fylt opp med standardrekkefølgen. */
export function mostUsed(ideas: FxIdea[], all: FxPreset[], n = 6): FxPreset[] {
  const count = new Map<string, number>();
  for (const i of ideas) count.set(i.preset, (count.get(i.preset) ?? 0) + 1);
  return [...all].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || all.indexOf(a) - all.indexOf(b)).slice(0, n);
}

// ---------------------------------------------------------------- eksport (pkt. 10)

/** Cue-navn i rekordbox: «Echo out · A ut», maks 32 tegn. */
export function cueName(preset: string, step: string): string {
  const s = `${preset} · ${step}`;
  return s.length <= 32 ? s : `${s.slice(0, 31)}…`;
}

/** Validerer en egendefinert preset (data/fx-presets.json). Kaster Error med norsk melding. */
export function validatePreset(x: unknown): FxPreset {
  const o = (x ?? {}) as Record<string, unknown>;
  const id = String(o.id ?? '');
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error('ugyldig id');
  const name = String(o.name ?? '').trim().slice(0, 40);
  if (!name) throw new Error('presetet trenger et navn');
  const color = typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color.toUpperCase() : '#3CB4FF';
  const deck: FxDeck = o.deck === 'A' || o.deck === 'B' ? o.deck : 'AB';
  const steps = (Array.isArray(o.steps) ? o.steps : []).slice(0, 4).map((s) => {
    const st = s as Record<string, unknown>;
    const bar = Math.max(-64, Math.min(64, Math.round(Number(st.bar) || 0)));
    const d: FxDeck = st.deck === 'A' || st.deck === 'B' ? st.deck : 'AB';
    const text = String(st.text ?? '').trim().slice(0, 40);
    if (!text) throw new Error('hvert steg trenger en tekst');
    return { bar, deck: d, text };
  });
  if (!steps.length) throw new Error('presetet trenger minst ett steg');
  return { id, name, icon: String(o.icon ?? '•').slice(0, 2), color, bars: Math.max(1, Math.min(64, Math.round(Number(o.bars) || 8))), deck, steps, builtIn: false };
}

// ---------------------------------------------------------------- påminnelse når du øver (pkt. 9)

export const REMINDER_MS = 30_000;
/**
 * Takter igjen til mikspunktet når vi er innenfor de siste 30 sekundene (0 = nå, under overgangen),
 * ellers null (ingen påminnelse).
 */
export function reminderBarsLeft(positionMs: number, outAtMs: number, barMs: number, overlapBars: number): number | null {
  const left = outAtMs - positionMs;
  if (left > REMINDER_MS) return null;
  if (left < -Math.max(1, overlapBars) * barMs) return null;
  return Math.max(0, Math.ceil(left / barMs));
}
