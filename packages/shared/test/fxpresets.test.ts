import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS, cueName, mostUsed, placeSteps, presetById, presetFor, reminderBarsLeft, snapToPhrase, suggestPreset, validatePreset, type FxIdea } from '../src/fxpresets';

/** Del 18: overgangs-presets. */
const mix = (bars: 0 | 8 | 16 | 32) => ({ outAtMs: 180_000, inAtMs: 30_000, bars });
const info = (relation: 'same' | 'adjacent' | 'clash' | 'boost2', tempoPct: number | null, bars: 0 | 8 | 16 | 32) => ({ relation, tempoPct, mix: mix(bars) });
const idea = (from: string, to: string | null, preset: string, at = '2026-11-16T10:00:00Z'): FxIdea => ({ id: `${from}-${to}-${preset}-${at}`, from, to, preset, at });

describe('ferdige presets', () => {
  it('har de 12 fra oppdraget, med 2–4 steg og gyldig farge', () => {
    expect(BUILT_IN_PRESETS).toHaveLength(12);
    for (const p of BUILT_IN_PRESETS) {
      expect(p.steps.length).toBeGreaterThanOrEqual(2);
      expect(p.steps.length).toBeLessThanOrEqual(4);
      expect(p.color).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(presetById(BUILT_IN_PRESETS, 'bass-swap-16')!.steps.map((s) => s.bar)).toEqual([-16, 0, 8]);
  });
});

describe('automatisk forslag (pkt. 3)', () => {
  it('følger reglene', () => {
    expect(suggestPreset({ info: info('same', 0.5, 32) }).id).toBe('long-blend-32');
    expect(suggestPreset({ info: info('adjacent', 1, 16) }).id).toBe('bass-swap-16');
    expect(suggestPreset({ info: info('clash', 0, 32) }).id).toBe('echo-out');
    expect(suggestPreset({ info: info('clash', 0, 32), energyA: 4, energyB: 7 }).id).toBe('cut-on-drop');
    expect(suggestPreset({ info: info('same', 4.2, 32) }).id).toBe('echo-out');
    expect(suggestPreset({ info: info('same', 4.2, 32), energyA: 4, energyB: 7 }).id).toBe('loop-build');
    expect(suggestPreset({ info: info('same', 0, 32), energyA: 3, energyB: 7 }).id).toBe('loop-build');
    expect(suggestPreset({ info: info('same', 0, 16), energyA: 8, energyB: 5 }).id).toBe('filter-fade');
    expect(suggestPreset({ info: info('same', 0, 8), energyA: 8, energyB: 5 }).id).toBe('reverb-wash');
    expect(suggestPreset({ info: info('same', 0, 32), last: true }).id).toBe('slow-fade');
  });
});

describe('festing til takter (pkt. 4)', () => {
  it('lange steg havner på frasegrenser, korte står', () => {
    expect(snapToPhrase(-16)).toBe(-16);
    expect(snapToPhrase(13)).toBe(16);
    expect(snapToPhrase(-4)).toBe(-4);
    expect(snapToPhrase(1)).toBe(1);
  });
  it('takt 0 er A sitt mikspunkt og B sitt cue', () => {
    const p = presetById(BUILT_IN_PRESETS, 'bass-swap-16')!;
    const steps = placeSteps(p, mix(16), 120, 120); // 1 takt = 2 s
    expect(steps.find((s) => s.text === 'A ut med HPF')).toMatchObject({ track: 'A', atMs: 180_000 + 8 * 2000 });
    expect(steps.find((s) => s.text === 'B inn, bass av')).toMatchObject({ track: 'B', atMs: 0 }); // 30 s − 16 takter → klemt til 0
    expect(steps.find((s) => s.text === 'Bytt bass A→B')).toMatchObject({ track: 'B', atMs: 30_000 });
  });
});

describe('læring og idéer (pkt. 5–7)', () => {
  const rule = { id: 'bass-swap-16', reason: 'regel' };
  it('regelen gjelder uten idéer', () => {
    expect(presetFor([], 'blue-fire', 'night-drive', rule)).toMatchObject({ id: 'bass-swap-16', learned: false });
  });
  it('etter to like valg ut av samme låt foreslås presetet automatisk', () => {
    const one = [idea('blue-fire', 'a', 'echo-out')];
    expect(presetFor(one, 'blue-fire', 'night-drive', rule).id).toBe('bass-swap-16');
    const two = [...one, idea('blue-fire', 'b', 'echo-out')];
    expect(presetFor(two, 'blue-fire', 'night-drive', rule)).toMatchObject({ id: 'echo-out', learned: true });
  });
  it('idé for akkurat paret, og «ut av denne», vinner', () => {
    expect(presetFor([idea('blue-fire', null, 'reverb-wash')], 'blue-fire', 'x', rule).id).toBe('reverb-wash');
    const ideas = [idea('blue-fire', null, 'reverb-wash'), idea('blue-fire', 'x', 'backspin')];
    expect(presetFor(ideas, 'blue-fire', 'x', rule).id).toBe('backspin');
  });
  it('raden viser de mest brukte først', () => {
    const top = mostUsed([idea('a', null, 'backspin'), idea('b', null, 'backspin'), idea('c', null, 'echo-out')], BUILT_IN_PRESETS, 6);
    expect(top.map((p) => p.id).slice(0, 2)).toEqual(['backspin', 'echo-out']);
    expect(top).toHaveLength(6);
  });
});

describe('påminnelse (pkt. 9)', () => {
  it('kommer 30 s før mikspunktet, og teller ned i takter', () => {
    expect(reminderBarsLeft(100_000, 131_000, 2000, 16)).toBeNull();
    expect(reminderBarsLeft(101_000, 131_000, 2000, 16)).toBe(15);
    expect(reminderBarsLeft(131_000, 131_000, 2000, 16)).toBe(0);
    expect(reminderBarsLeft(131_000 + 20 * 2000, 131_000, 2000, 16)).toBeNull();
  });
});

describe('eksport og egne presets', () => {
  it('cue-navn er maks 32 tegn', () => {
    expect(cueName('Echo out', 'A ut')).toBe('Echo out · A ut');
    expect(cueName('Et veldig langt presetnavn', 'og et langt steg').length).toBeLessThanOrEqual(32);
  });
  it('egne presets valideres', () => {
    const p = validatePreset({ id: 'min-echo', name: 'Min echo', color: '#ff00aa', bars: 8, steps: [{ bar: -4, deck: 'A', text: 'Echo' }] });
    expect(p).toMatchObject({ id: 'min-echo', color: '#FF00AA', builtIn: false });
    expect(() => validatePreset({ id: 'x!', name: 'a', steps: [] })).toThrow();
    expect(() => validatePreset({ id: 'tom', name: 'Tom', steps: [] })).toThrow(/minst ett steg/);
  });
});
