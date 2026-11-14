import { converter, formatHex, wcagContrast, clampChroma, type Oklch } from 'culori';
import type { Palette } from './types';
import { FALLBACK_PALETTE, OBSIDIAN } from './theme';


let _toOklch: ReturnType<typeof converter<'oklch'>> | null = null;
const toOklch = (c: string) => (_toOklch ??= converter('oklch'))(c);

export interface ColorCandidate {
  hex: string;
  /** Andel av bildet (vilkårlig skala, bare relativ betydning). */
  population: number;
}

const MIN_CHROMA = 0.045; // under dette regnes coveret som fargeløst
const MIN_CONTRAST = 4.5;

/** Del 8: innstillinger for farger fra cover. */
export interface PaletteOptions {
  /** Minste kontrast mot bakgrunnen (WCAG), 3–7. Standard 4.5. */
  minContrast?: number;
  /** Gull for fargeløse cover (standard). Av: bruk coverets egen (dempede) farge. */
  colorFallback?: boolean;
}

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
export function choosePalette(candidates: ColorCandidate[], opts: PaletteOptions = {}): Palette {
  const minContrast = opts.minContrast ?? MIN_CONTRAST;
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
  if (!best || (best.o.c < MIN_CHROMA && opts.colorFallback !== false)) return { ...FALLBACK_PALETTE };

  const primary = clampAccent(best.o, minContrast);

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
export function clampAccent(input: Oklch, minContrast = MIN_CONTRAST): Oklch {
  let c: Oklch = {
    mode: 'oklch',
    l: clamp(input.l, 0.68, 0.9),
    c: clamp(input.c, 0.09, 0.2),
    h: input.h ?? 0
  };
  for (let i = 0; i < 40 && wcagContrast(hex(c), OBSIDIAN) < minContrast; i++) {
    c = { ...c, l: Math.min(0.97, c.l + 0.01) };
  }
  return c;
}

/** Del 8: manuell farge fra Studio. Primærfargen må holde minst `minContrast` mot bakgrunnen. */
export function manualPalette(primary: string, secondary: string, minContrast = MIN_CONTRAST): { ok: true; palette: Palette } | { ok: false; error: string; contrast: number } {
  if (!/^#[0-9a-f]{6}$/i.test(primary) || !/^#[0-9a-f]{6}$/i.test(secondary)) return { ok: false, error: 'farger må være #rrggbb', contrast: 0 };
  const contrast = Math.round(wcagContrast(primary, OBSIDIAN) * 100) / 100;
  if (contrast < minContrast) return { ok: false, error: `primærfargen har bare ${contrast}:1 mot bakgrunnen (krav ${minContrast}:1)`, contrast };
  const onPrimary = wcagContrast(primary, OBSIDIAN) >= wcagContrast(primary, '#F4F1EA') ? '#07080B' : '#F4F1EA';
  return { ok: true, palette: { primary: primary.toUpperCase(), secondary: secondary.toUpperCase(), onPrimary, source: 'manual' } };
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
