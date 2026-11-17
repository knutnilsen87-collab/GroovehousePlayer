import { describe, expect, it } from 'vitest';
import type { SbTrack } from '@gv/shared/web';
import { rankMatches } from '../src/lib/vibe';
import { suggestTags } from '../src/lib/tags';

/** Del 20 D: Vibe Shifter, Match groove og forslag til stil-tagger. */
const t = (slug: string, o: Partial<SbTrack> = {}): SbTrack => ({ id: slug, slug, variant: null, title: slug, durationMs: 300_000, bpm: 124, camelot: '8A', lufs: -9, energy: 6, draft: false, extended: false, introMs: 30_000, outroMs: 30_000, bpmConfidence: 0.4, keyConfidence: 0.8, ...o });
const base = { tight: 'normal' as const, energy: null, style: null, styleStep: 0, matchGroove: false };

describe('Vibe Shifter', () => {
  const ref = t('ref');
  const cands = [t('samme'), t('nabo', { camelot: '9A' }), t('to-unna', { camelot: '10A' }), t('relativ', { camelot: '8B' }), t('fort', { bpm: 130 }), t('litt-fort', { bpm: 127 }), t('opp', { energy: 8 }), t('ned', { energy: 3 })];
  const slugs = (v: Partial<typeof base>) => rankMatches(ref, cands, { ...base, ...v }).map((r) => r.t.slug).sort();
  it('Strammere: samme toneart (og relativ), BPM ±2 %', () => {
    expect(slugs({ tight: 'tight' })).toEqual(['ned', 'opp', 'relativ', 'samme']);
  });
  it('Normal: Camelot ±1, BPM ±3 %; Bredere: ±2 og ±6 %', () => {
    expect(slugs({ tight: 'normal' })).toEqual(['litt-fort', 'nabo', 'ned', 'opp', 'relativ', 'samme']);
    expect(slugs({ tight: 'wide' })).toContain('to-unna');
    expect(slugs({ tight: 'wide' })).toContain('fort');
  });
  it('Energi ↑ og ↓ filtrerer på retning', () => {
    expect(slugs({ energy: 'up' })).toEqual(['opp']);
    expect(slugs({ energy: 'down' })).toEqual(['ned']);
  });
  it('Skift mot Tech glir inn over 2–3 låter', () => {
    const c = [t('a', { tags: ['Deep'] }), t('b', { tags: ['Tech'], energy: 6.8 })];
    const top = (step: number) => rankMatches(ref, c, { ...base, style: 'Tech', styleStep: step })[0]!.t.slug;
    const scoreB = (step: number) => rankMatches(ref, c, { ...base, style: 'Tech', styleStep: step }).find((r) => r.t.slug === 'b')!.score;
    expect(scoreB(2)).toBeGreaterThan(scoreB(0));
    expect(top(2)).toBe('b');
  });
  it('Match groove: lik groove rangeres foran, og groove-likhet vises i %', () => {
    const c = [t('ulik', { groove: { swing: 0.2, density: 0.2, fourOnFloor: false, hats: 0.1 } }), t('lik', { groove: { swing: 0.05, density: 0.6, fourOnFloor: true, hats: 0.5 } })];
    const r = rankMatches({ ...ref, groove: { swing: 0.05, density: 0.62, fourOnFloor: true, hats: 0.48 } }, c, { ...base, matchGroove: true });
    expect(r[0]!.t.slug).toBe('lik');
    expect(r[0]!.groovePct).toBeGreaterThan(90);
    expect(r[1]!.groovePct).toBeLessThan(50);
  });
});

describe('forslag til stil-tagger', () => {
  const sim = (bpm: number, energy: number, swing: number) => ({ bpm, camelot: '8A', energy, groove: { swing, density: 0.5, fourOnFloor: true, hats: 0.4 } });
  it('foreslår taggen de mest like taggede låtene har', () => {
    const tagged = [
      { sim: sim(124, 6, 0.1), tags: ['Deep'] },
      { sim: sim(124, 6.2, 0.11), tags: ['Deep'] },
      { sim: sim(125, 5.8, 0.09), tags: ['Deep', 'Cyber-Soul'] },
      { sim: sim(132, 9, 0.0), tags: ['Tech'] }
    ];
    expect(suggestTags(sim(124, 6.1, 0.1), tagged)).toEqual(['Deep']);
  });
  it('ingen forslag når ingenting ligner nok', () => {
    expect(suggestTags(sim(90, 2, 0.3), [{ sim: sim(132, 9, 0), tags: ['Tech'] }])).toEqual([]);
  });
});
