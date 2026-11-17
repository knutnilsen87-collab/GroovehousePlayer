import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, GLOW_PEAK, skinAccentVars, skinPalette, validateSkin, type Palette, type Skin } from '@gv/shared/web';

/**
 * Del 27 pkt. 12: faktisk kontrast for tekst og kontroller over dynamisk bakgrunn (gløden i coverfargen),
 * i alle ferdige skins og over tre ulike cover fra katalogen (mørkest, lysest og mest mettet primærfarge,
 * valgt 2026-11-17 blant 307 cover). WCAG 2.2 AA: 4,5:1 for tekst, 3:1 for stor tekst og komponenter.
 */
const DIR = path.resolve(__dirname, '../src/skins');
const skins: Skin[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => validateSkin(JSON.parse(readFileSync(path.join(DIR, f), 'utf8'))));

const COVERS: Record<string, Palette> = {
  'Easy (mørkest)': { primary: '#e65bbb', secondary: '#a5003c', onPrimary: '#07080B', source: 'cover' },
  'Dub On My Skin (lysest)': { primary: '#c7ec6a', secondary: '#b27b21', onPrimary: '#07080B', source: 'cover' },
  'I’ll Keep It Real (mest mettet)': { primary: '#0cebf8', secondary: '#045c8c', onPrimary: '#07080B', source: 'cover' }
};

// Teksttokenene i tailwind.config (faste, ikke fra skinnet)
const TEXT = { 'ink-strong': '#F5F7FA', ink: '#E9ECF2', soft: '#C6CDD9', muted: '#A3ACBA' };

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** a over b med dekkevne t (0–1). */
const over = (a: string, b: string, t: number) => {
  const [x, y] = [hex(a), hex(b)];
  return '#' + x.map((v, i) => Math.round(v * t + y[i]! * (1 - t)).toString(16).padStart(2, '0')).join('');
};

const alphaOf = (rgba: string) => Number(/,\s*([\d.]+)\)\s*$/.exec(rgba)?.[1] ?? 1);

function surfaces(skin: Skin, track: Palette): Record<string, string> {
  const b = skin.background;
  const p = skinPalette(skin, track);
  // Verdiene appen faktisk bruker (skinAccentVars), ikke en egen modell
  const vars = skinAccentVars(skin, track);
  const glowA = alphaOf(vars['--glow']!);
  const glow2A = alphaOf(vars['--glow-2']!);
  return {
    bakgrunn: b.base,
    flate: b.surface,
    senket: b.sunken,
    panel: over(b.panelTint, b.base, b.panelAlpha / 100),
    // AmbientGlow: midten (--glow) ligger bak toppen av siden (logo, overskrift, bannere), opasitet opptil 0,65
    'glød (topp)': over(p.primary, b.base, glowA * GLOW_PEAK),
    // Fullskjerm: midten er bak coveret; teksten under står i ytre ring (--glow-2), opasitet opptil 0,9
    'glød (fullskjerm, tekst)': over(p.secondary, b.base, glow2A * 0.9),
    'aktiv rad': over(p.primary, b.base, 0.14)
  };
}

const results = skins.flatMap((skin) =>
  Object.entries(COVERS).map(([cover, track]) => {
    const p = skinPalette(skin, track);
    const s = surfaces(skin, track);
    const issues: string[] = [];
    for (const [sn, bg] of Object.entries(s)) {
      for (const [tn, fg] of Object.entries(TEXT)) {
        const c = contrastRatio(fg, bg);
        if (c < 4.5) issues.push(`${tn} på ${sn}: ${c.toFixed(2)}:1`);
      }
      // Aksent brukes som liten tekst (etiketter, aktiv rad) – tekstkrav – unntatt på «aktiv rad», der teksten er ink-strong
      if (sn !== 'aktiv rad') {
        const c = contrastRatio(p.primary, bg);
        if (c < 4.5) issues.push(`aksent-tekst på ${sn}: ${c.toFixed(2)}:1`);
      }
    }
    const onAccent = contrastRatio(p.onPrimary, p.primary);
    if (onAccent < 4.5) issues.push(`tekst på aksentknapp: ${onAccent.toFixed(2)}:1`);
    const control = contrastRatio(p.primary, skin.background.base);
    if (control < 3) issues.push(`kontroll (aksent) mot bakgrunn: ${control.toFixed(2)}:1`);
    return { skin: skin.id, cover, issues };
  })
);

describe('kontrast over dynamisk bakgrunn (del 27 pkt. 12)', () => {
  it.each(results.map((r) => [r.skin, r.cover, r.issues] as const))('%s · %s', (_s, _c, issues) => {
    expect(issues).toEqual([]);
  });
});
