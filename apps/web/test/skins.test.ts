import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_SKIN_IDS, DEFAULT_SKIN_ID, contrastRatio, skinAccentVars, skinContrastIssues, skinPalette, validateSkin, type Palette, type Skin } from '@gv/shared/web';

/** Del 19: skins. */
const DIR = path.resolve(__dirname, '../src/skins');
const load = (id: string): Skin => validateSkin(JSON.parse(readFileSync(path.join(DIR, `${id}.json`), 'utf8')));
const cover: Palette = { primary: '#3CB4FF', secondary: '#7A5CFF', onPrimary: '#07080B', source: 'cover' };
const manual: Palette = { primary: '#FF8800', secondary: '#FFAA44', onPrimary: '#07080B', source: 'manual' };

describe('ferdige skins', () => {
  it('filene og lista i shared stemmer, og Kameleon er standard', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    expect(files).toEqual([...BUILT_IN_SKIN_IDS].sort());
    expect(DEFAULT_SKIN_ID).toBe('kameleon');
    expect(load('kameleon').mode).toBe('chameleon');
    for (const id of files) expect(load(id).id).toBe(id);
  });

  it.each([...BUILT_IN_SKIN_IDS])('%s holder kontrastlåsen (≥ 4.5:1 mot bakgrunnen)', (id) => {
    expect(skinContrastIssues(load(id))).toEqual([]);
  });

  it('Grønn Neon er Antigravitys grønne, ikke standard', () => {
    const g = load('gronn-neon');
    expect(g.mode).toBe('fixed');
    expect([g.accent, g.accent2]).toEqual(['#06B211', '#14E177']);
  });

  it('OLED Svart har ren svart bakgrunn og minimal glød', () => {
    const o = load('oled-svart');
    expect(o.background.base).toBe('#000000');
    expect(o.glow).toBeLessThanOrEqual(10);
  });

  it('Echo Groove Nights: rosa/fiolett, måne, gradient-bølgeform, eget ordmerke og hjerteslag', () => {
    const e = load('echo-groove-nights');
    expect(e.mode).toBe('fixed');
    expect(e.background.moon).toBeTruthy();
    expect(e.waveform).toBe('gradient');
    expect(e.logo).toBe('echo-groove');
    expect(e.brand?.motif).toBe('heartbeat');
    expect(e.glow).toBeGreaterThan(load('kameleon').glow);
    expect(contrastRatio(e.accent!, e.background.base)).toBeGreaterThanOrEqual(4.5);
  });

  it('bare Gull klassisk har gull i rammene', () => {
    expect(BUILT_IN_SKIN_IDS.filter((id) => load(id).goldFrame)).toEqual(['gull-klassisk']);
  });
});

describe('palett per skin (pkt. 3)', () => {
  it('Kameleon bruker coveret og manuell farge; uten låt standardfargen', () => {
    const k = load('kameleon');
    expect(skinPalette(k, cover).primary).toBe('#3CB4FF');
    expect(skinPalette(k, manual).primary).toBe('#FF8800');
    expect(skinPalette(k, null).primary).toBe('#06B211');
  });
  it('faste skins overstyrer både cover og manuell farge', () => {
    const c = load('cyan-studio');
    expect(skinPalette(c, cover).primary).toBe('#01E6FC');
    expect(skinPalette(c, manual).primary).toBe('#01E6FC');
  });
  it('umastrede låter får halv glød, og glød 0 slukker gløden', () => {
    const k = load('kameleon');
    expect(skinAccentVars(k, cover)['--glow']).not.toBe(skinAccentVars(k, cover, true)['--glow']);
    expect(skinAccentVars({ ...k, glow: 0 }, cover)['--glow']).toMatch(/, 0\)$/);
  });
});

describe('egne skins: validering', () => {
  it('avviser ugyldige farger og id-er, og varsler om lav kontrast', () => {
    expect(() => validateSkin({ id: 'X', name: 'a', mode: 'fixed', accent: '#fff', background: { base: '#000000' } })).toThrow();
    const s = validateSkin({ id: 'mitt', name: 'Mitt', mode: 'fixed', accent: '#202020', background: { base: '#000000' } });
    expect(skinContrastIssues(s).length).toBeGreaterThan(0);
  });
});

describe('valget lagres per enhet (localStorage), og byttet skjer uten omstart', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  });

  it('standard er Kameleon; valg huskes på enheten og påvirker ikke en annen enhet', async () => {
    const pc = await import('../src/lib/skin');
    expect(pc.useSkin.getState().skin.id).toBe('kameleon');
    pc.useSkin.getState().choose('gronn-neon');
    expect(pc.useSkin.getState().skin.id).toBe('gronn-neon');
    expect(JSON.parse(store.get('gv:skin')!).id).toBe('gronn-neon');
    vi.resetModules();
    expect((await import('../src/lib/skin')).useSkin.getState().skin.id).toBe('gronn-neon');
    store.clear();
    vi.resetModules();
    expect((await import('../src/lib/skin')).useSkin.getState().skin.id).toBe('kameleon');
  });

  it('trackVars følger skinnet med en gang', async () => {
    const { useSkin, skinTrackVars } = await import('../src/lib/skin');
    expect(skinTrackVars(cover)['--accent']).toBe('#3CB4FF');
    useSkin.getState().choose('magenta-club');
    expect(skinTrackVars(cover)['--accent']).toBe('#FF3EA5');
    useSkin.getState().choose('kameleon');
    expect(skinTrackVars(manual)['--accent']).toBe('#FF8800');
  });
});
