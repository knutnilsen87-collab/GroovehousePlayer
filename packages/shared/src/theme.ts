import type { Palette } from './types';

/** Bakgrunnen alt måles mot. */
export const OBSIDIAN = '#07080B';

export const GOLD_FALLBACK: Palette = {
  primary: '#F0C030',
  secondary: '#B06000',
  onPrimary: '#120D02',
  source: 'fallback'
};

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
