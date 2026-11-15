import type { Palette } from './types';

/** Bakgrunnen alt måles mot. */
export const OBSIDIAN = '#07080B';

/**
 * Standardpaletten (Knut 2026-11-15): grønn (#06B211 / #14E177).
 * Brukes når en låt mangler cover eller coveret er fargeløst, og før noen låt er valgt. Gull er bare for logoen.
 */
export const FALLBACK_PALETTE: Palette = {
  primary: '#06B211',
  secondary: '#14E177',
  onPrimary: '#07080B',
  source: 'fallback'
};

/** Før noen låt er valgt (del 14): samme grønne standard. */
export const NEUTRAL_PALETTE: Palette = FALLBACK_PALETTE;

/** CSS-variablene UI-et bruker. Ingen komponent skal hardkode aksentfarger. */
export function paletteToCssVars(p: Palette): Record<string, string> {
  return {
    '--accent': p.primary,
    '--accent-2': p.secondary,
    '--on-accent': p.onPrimary,
    '--glow': withAlpha(p.primary, 0.42),
    '--glow-2': withAlpha(p.secondary, 0.18)
  };
}

export function withAlpha(hexColor: string, a: number): string {
  const n = parseInt(hexColor.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
