import { describe, expect, it } from 'vitest';
import { BUILT_IN_PRESETS } from '@gv/shared/web';
import { nativeReminder, reminderText, type ReminderPlan } from '../src/lib/fxReminder';

/** Del 18 pkt. 9: påminnelsen 30 s før mikspunktet – samme tekst på skjermen og i Android-varselet. */
const echo = BUILT_IN_PRESETS.find((p) => p.id === 'echo-out') ?? BUILT_IN_PRESETS[0]!;
const plan: ReminderPlan = { outAtMs: 200_000, barMs: 2000, overlapBars: 8, preset: echo, steps: [{ atMs: 192_000, text: 'Echo på A' }, { atMs: 200_000, text: 'A ut' }], inAtMs: 16_000, inSteps: [] };

describe('påminnelse før mikspunktet', () => {
  it('ingenting før de siste 30 sekundene', () => {
    expect(reminderText(169_000, plan)).toBeNull();
  });
  it('takter igjen og steget som kommer', () => {
    expect(reminderText(184_000, plan)).toEqual({ head: `Neste: ${echo.name} – 8 takter igjen`, step: 'Echo på A' });
    expect(reminderText(195_000, plan)?.step).toBe('A ut');
  });
  it('«nå» under overgangen, og borte når den er ferdig', () => {
    expect(reminderText(205_000, plan)?.head).toBe(`Neste: ${echo.name} – nå`);
    expect(reminderText(200_000 + 8 * 2000 + 1, plan)).toBeNull();
  });
  it('det som sendes til Android er bare tall og tekst', () => {
    const n = nativeReminder(plan)!;
    expect(n).toEqual({ outAtMs: 200_000, barMs: 2000, overlapBars: 8, name: echo.name, steps: [{ atMs: 192_000, text: 'Echo på A' }, { atMs: 200_000, text: 'A ut' }] });
    expect(JSON.parse(JSON.stringify(n))).toEqual(n);
    expect(nativeReminder(null)).toBeNull();
  });
});
