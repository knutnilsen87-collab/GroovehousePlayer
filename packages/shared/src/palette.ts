import { converter, formatHex, wcagContrast, clampChroma, type Oklch } from 'culori';
import type { Palette } from './types';
import { GOLD_FALLBACK, OBSIDIAN } from './theme';


let _toOklch: ReturnType<typeof converter<'oklch'>> | null = null;
const toOklch = (c: string) => (_toOklch ??= converter('oklch'))(c);

export interface ColorCandidate {
  hex: string;
  /** Andel av bildet (vilkårlig skala, bare relativ betydning). */
  population: number;
}

const MIN_CHROMA = 0.045; // under dette regnes coveret som fargeløst
const MIN_CONTRAST = 4.5;

function oklchOf(hex: string): Oklch {
  const c = toOklch(hex);
  if (!c) throw new Error(`Ugyldig farge: ${hex}`);
  return { mode: 'oklch', l: c.l, c: c.c ?? 0, h: c.h ?? 0 };
}

function hex(c: Oklch): string {
  return formatHex(clampChroma(c, 'oklch')) ?? '#000000';
}

/**
 * Velger den mest *levende* fargen (ikke den mest dominerende) og låser den
 * til et lesbart område mot obsidian-bakgrunnen.
 */
export function choosePalette(candidates: ColorCandidate[]): Palette {
  const scored = candidates
    .filter((c) => /^#[0-9a-f]{6}$/i.test(c.hex))
    .map((c) => {
      const o = oklchOf(c.hex);
      // Metning teller mest; litt populasjon så vi ikke velger en piksel-flekk.
      const score = o.c * (0.35 + 0.65 * Math.sqrt(Math.min(1, c.population)));
      return { ...c, o, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.o.c < MIN_CHROMA) return { ...GOLD_FALLBACK };

  const primary = clampAccent(best.o);

  // Sekundær: en annen kulør (≥ 25° unna) hvis den finnes, ellers en mørkere variant.
  const other = scored.find((s) => s !== best && s.o.c >= MIN_CHROMA && hueDistance(s.o.h ?? 0, best.o.h ?? 0) >= 25);
  const secondaryBase: Oklch = other ? other.o : { mode: 'oklch', l: best.o.l * 0.7, c: best.o.c, h: ((best.o.h ?? 0) + 30) % 360 };
  const secondary: Oklch = {
    mode: 'oklch',
    l: clamp(secondaryBase.l, 0.42, 0.68),
    c: clamp(secondaryBase.c, 0.08, 0.22),
    h: secondaryBase.h ?? 0
  };

  const primaryHex = hex(primary);
  const onPrimary = wcagContrast(primaryHex, OBSIDIAN) >= wcagContrast(primaryHex, '#F4F1EA') ? '#07080B' : '#F4F1EA';

  return { primary: primaryHex, secondary: hex(secondary), onPrimary, source: 'cover' };
}

/** Hever lysheten til fargen har ≥ 4.5:1 mot bakgrunnen, og holder metningen i et pent område. */
export function clampAccent(input: Oklch): Oklch {
  let c: Oklch = {
    mode: 'oklch',
    l: clamp(input.l, 0.68, 0.9),
    c: clamp(input.c, 0.09, 0.2),
    h: input.h ?? 0
  };
  for (let i = 0; i < 40 && wcagContrast(hex(c), OBSIDIAN) < MIN_CONTRAST; i++) {
    c = { ...c, l: Math.min(0.97, c.l + 0.01) };
  }
  return c;
}

export function contrastOnObsidian(hexColor: string): number {
  return wcagContrast(hexColor, OBSIDIAN);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
