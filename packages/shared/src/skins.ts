import { FALLBACK_PALETTE, withAlpha } from './theme';
import type { Palette } from './types';

/**
 * Del 19: skins. Et skin bestemmer hele utseendet: fargemodus, bakgrunn, paneler, glød, kanter,
 * hjørneradius, bølgeformstil og logo. Alt går via CSS-variabler; komponentene hardkoder ingen farger.
 *
 *  - chameleon: aksenten kommer fra låtas palett (coveret, eller manuell farge fra Studio).
 *  - fixed: skinnets egne aksenter. Manuell låtfarge gjelder IKKE (pkt. 3).
 */
export type SkinMode = 'chameleon' | 'fixed';
export type WaveformStyle = 'accent' | '3band' | 'gradient';
/** Del 22: selvhostede display-fonter et skin kan velge. */
export type DisplayFont = 'clash' | 'satoshi';
export const DISPLAY_FONTS: Record<DisplayFont, string> = {
  clash: "'Clash Display', 'Inter', system-ui, sans-serif",
  satoshi: "'Satoshi', 'Inter', system-ui, sans-serif"
};

export interface SkinBrand {
  /** Paneletikett i sperret versal, f.eks. «MUSIC · PEOPLE · NIGHTS · NO LIMITS». */
  labels?: string;
  /** Korte tekster til tomme tilstander og oppstart. */
  taglines?: string[];
  /** Hjerteslag-linja med hjerte (favoritter, lasting, under «Spilles nå»). */
  motif?: 'heartbeat' | null;
  /** Neon-script (sparsomt: sitater og tomme tilstander). */
  script?: boolean;
}

export interface Skin {
  id: string;
  name: string;
  description: string;
  mode: SkinMode;
  /** Bare for mode=fixed. */
  accent?: string | null;
  accent2?: string | null;
  /** Valgfri tredje tone (Echo Groove Nights: blålilla). */
  accent3?: string | null;
  background: {
    /** Sidebakgrunn. Alle aksenter måles mot denne. */
    base: string;
    /** Hevet flate (kort, menyer). */
    surface: string;
    /** Senket flate (søkefelt, bunnmeny). */
    sunken: string;
    /** Toning av glasspanelene (hex) og styrke 0–100 %. */
    panelTint: string;
    panelAlpha: number;
    /** Valgfri «måne»: radial glød øverst til høyre bak hovedpanelet. */
    moon?: string | null;
  };
  /** 0–100. 50 = slik Kameleon har vært fram til nå. */
  glow: number;
  /** Kantstyrke 0–100 (prosent aksent i panelkanten). */
  border: number;
  /** Hjørneradius på paneler i px. */
  radius: number;
  waveform: WaveformStyle;
  /** Gull i rammene også (bare «Gull klassisk»). Gull i logoen gjelder alltid. */
  goldFrame: boolean;
  /** Rammefargen når goldFrame er på. */
  frame?: string | null;
  /** Logo i sidemeny og oppstart. echo-groove faller tilbake til Groovehouse til fila finnes. */
  logo: 'groovehouse' | 'echo-groove';
  /** Del 22: display-font for titler og store tall. Standard Clash Display; resten av skriften er felles. */
  displayFont?: DisplayFont;
  /** Del 22: glass (backdrop-blur). false = ingen blur (OLED Svart). Standard på. */
  glass?: boolean;
  brand?: SkinBrand | null;
  /** Ferdig skin (i kode) eller eget (data/skins/). */
  builtIn?: boolean;
}

export const DEFAULT_SKIN_ID = 'kameleon';
export const MIN_SKIN_CONTRAST = 4.5;
const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

// ---------------------------------------------------------------- kontrast (WCAG 2.x, uten avhengigheter så web kan bruke den)

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Problemer med kontrast: tom liste = skinnet holder kontrastlåsen (≥ 4.5:1 mot bakgrunnen). */
export function skinContrastIssues(skin: Skin, min = MIN_SKIN_CONTRAST): string[] {
  const out: string[] = [];
  const bg = skin.background.base;
  const check = (label: string, c: string | null | undefined) => {
    if (!c) return;
    const r = contrastRatio(c, bg);
    if (r < min) out.push(`${label} ${c} har ${r.toFixed(2)}:1 mot ${bg} (krav ${min}:1)`);
  };
  if (skin.mode === 'fixed') {
    check('Aksent', skin.accent);
    check('Aksent 2', skin.accent2);
    check('Aksent 3', skin.accent3);
  }
  if (skin.goldFrame) check('Ramme', skin.frame);
  // Teksten (ink #E9ECF2) må også være lesbar på bakgrunnen
  check('Tekst', '#E9ECF2');
  return out;
}

// ---------------------------------------------------------------- validering (egne skins fra data/skins/)

export class SkinError extends Error {}

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt);
const hexOr = (v: unknown, dflt: string | null): string | null => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : dflt);
const reqHex = (v: unknown, field: string): string => {
  if (typeof v === 'string' && HEX.test(v)) return v.toUpperCase();
  throw new SkinError(`${field} må være en farge på formen #RRGGBB`);
};

/** Godtar et skin fra disk eller klienten, eller kaster SkinError. */
export function validateSkin(input: unknown): Skin {
  if (!input || typeof input !== 'object') throw new SkinError('skin mangler');
  const s = input as Record<string, unknown>;
  const id = String(s.id ?? '');
  if (!ID.test(id)) throw new SkinError('ugyldig id (små bokstaver, tall og bindestrek)');
  const name = String(s.name ?? '').trim().slice(0, 40);
  if (!name) throw new SkinError('skinnet trenger et navn');
  const mode: SkinMode = s.mode === 'fixed' ? 'fixed' : 'chameleon';
  const bg = (s.background ?? {}) as Record<string, unknown>;
  const base = reqHex(bg.base, 'Bakgrunn');
  const skin: Skin = {
    id,
    name,
    description: String(s.description ?? '').slice(0, 200),
    mode,
    accent: mode === 'fixed' ? reqHex(s.accent, 'Aksent') : null,
    accent2: mode === 'fixed' ? hexOr(s.accent2, null) ?? reqHex(s.accent, 'Aksent') : null,
    accent3: hexOr(s.accent3, null),
    background: {
      base,
      surface: hexOr(bg.surface, base)!,
      sunken: hexOr(bg.sunken, base)!,
      panelTint: hexOr(bg.panelTint, '#FFFFFF')!,
      panelAlpha: clamp(bg.panelAlpha, 0, 20, 3),
      moon: hexOr(bg.moon, null)
    },
    glow: clamp(s.glow, 0, 100, 50),
    border: clamp(s.border, 0, 100, 24),
    radius: clamp(s.radius, 0, 32, 16),
    waveform: s.waveform === '3band' || s.waveform === 'gradient' ? s.waveform : 'accent',
    goldFrame: s.goldFrame === true,
    frame: hexOr(s.frame, null),
    logo: s.logo === 'echo-groove' ? 'echo-groove' : 'groovehouse',
    displayFont: s.displayFont === 'satoshi' ? 'satoshi' : 'clash',
    glass: s.glass !== false,
    brand: null,
    builtIn: false
  };
  if (s.brand && typeof s.brand === 'object') {
    const b = s.brand as Record<string, unknown>;
    skin.brand = {
      labels: typeof b.labels === 'string' ? b.labels.slice(0, 80) : undefined,
      taglines: Array.isArray(b.taglines) ? b.taglines.filter((t): t is string => typeof t === 'string').map((t) => t.slice(0, 60)).slice(0, 8) : undefined,
      motif: b.motif === 'heartbeat' ? 'heartbeat' : null,
      script: b.script === true
    };
  }
  if (skin.goldFrame && !skin.frame) throw new SkinError('Gull i rammene krever en rammefarge');
  return skin;
}

// ---------------------------------------------------------------- hvilken palett gjelder

/**
 * Pkt. 3: manuell låtfarge fra Studio gjelder bare i Kameleon-modus. Faste skins overstyrer alt.
 * Kameleon uten palett (ingen låt valgt) → standardfargen.
 */
export function skinPalette(skin: Skin, track?: Palette | null): Palette {
  if (skin.mode === 'fixed' && skin.accent) {
    const accent = skin.accent;
    return {
      primary: accent,
      secondary: skin.accent2 ?? accent,
      onPrimary: luminance(accent) > 0.18 ? '#07080B' : '#F5F7FA',
      source: 'fallback'
    };
  }
  return track ?? { ...FALLBACK_PALETTE };
}

/** Aksent-variablene for en låt (eller ingen låt) i et skin. `dim` = utkast (halv glød, del 16). */
export function skinAccentVars(skin: Skin, track?: Palette | null, dim = false): Record<string, string> {
  const p = skinPalette(skin, track);
  const k = skin.glow / 50;
  const a = (x: number) => Math.min(1, x * k * (dim ? 0.5 : 1));
  return {
    '--accent': p.primary,
    '--accent-2': p.secondary,
    '--accent-3': skin.accent3 ?? p.secondary,
    '--on-accent': p.onPrimary,
    '--glow': withAlpha(p.primary, a(0.42)),
    '--glow-2': withAlpha(p.secondary, a(0.18))
  };
}

/** Variablene som ligger på <html> og gjelder hele appen (bakgrunn, paneler, glød, kanter, radius, ramme). */
export function skinRootVars(skin: Skin): Record<string, string> {
  const b = skin.background;
  return {
    '--c-obsidian': b.base,
    '--c-surface': b.surface,
    '--c-sunken': b.sunken,
    '--panel-bg': withAlpha(b.panelTint, b.panelAlpha / 100),
    '--glow-k': String(skin.glow / 50),
    '--border-pct': `${skin.border}%`,
    '--panel-radius': `${skin.radius}px`,
    '--moon': b.moon ? withAlpha(b.moon, 0.22) : 'transparent',
    '--frame': skin.goldFrame && skin.frame ? skin.frame : 'color-mix(in srgb, var(--accent) var(--border-pct), transparent)',
    // Del 22: ingen panelkanter, bortsett fra skin som velger ramme selv (Gull klassisk)
    '--panel-edge': skin.goldFrame && skin.frame ? withAlpha(skin.frame, 0.55) : 'transparent',
    '--font-display': DISPLAY_FONTS[skin.displayFont ?? 'clash'],
    '--glass-blur': skin.glass === false ? 'none' : 'blur(24px) saturate(140%)'
  };
}

/** Kopi av et skin som utgangspunkt for «Dupliser og tilpass». */
export function duplicateSkin(skin: Skin, taken: Set<string>): Skin {
  let n = 1;
  let id = `${skin.id}-egen`;
  while (taken.has(id)) id = `${skin.id}-egen-${++n}`;
  const pal = skinPalette(skin);
  return {
    ...structuredClone(skin),
    id,
    name: `${skin.name} (egen)`.slice(0, 40),
    mode: 'fixed',
    accent: skin.accent ?? pal.primary,
    accent2: skin.accent2 ?? pal.secondary,
    builtIn: false
  };
}

/** Id-ene til de ferdige skinnene (filene i apps/web/src/skins/). En test passer på at lista stemmer. */
export const BUILT_IN_SKIN_IDS = ['kameleon', 'cyan-studio', 'gronn-neon', 'gull-klassisk', 'magenta-club', 'ultraviolett', 'mono-studio', 'oled-svart', 'echo-groove-nights'] as const;
