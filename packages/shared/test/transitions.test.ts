import { describe, expect, it } from 'vitest';
import { explainTransition, transitionScore, type SbTrack } from '../src/setbuilder';
import { suggestPreset } from '../src/fxpresets';

/** Del 20 B: overgangsscoren – lengde etter ren intro/outro, vokalkollisjon, toneart, swing og bass. */
const bar = 240_000 / 124;
const t = (o: Partial<SbTrack> = {}): SbTrack => ({
  id: Math.random().toString(36).slice(2),
  slug: 's',
  variant: null,
  title: 'T',
  durationMs: 128 * bar,
  bpm: 124,
  camelot: '8A',
  lufs: -9,
  energy: 6,
  draft: false,
  extended: false,
  introMs: 32 * bar,
  outroMs: 32 * bar,
  bpmConfidence: 0.4,
  keyConfidence: 0.8,
  introBars: 32,
  outroBars: 32,
  firstDownbeatMs: 0,
  vocals: [],
  ...o
});

describe('transitionScore', () => {
  it('alt passer: lang blend 32 takter, inni de rene områdene', () => {
    const s = transitionScore(t(), t({ camelot: '9A' }));
    expect(s.bars).toBe(32);
    expect(s.kind).toBe('blend');
    expect(s.outAtMs + 32 * bar).toBeLessThanOrEqual(128 * bar + 1);
    expect(s.inAtMs).toBe(0);
  });
  it('kort ren intro: overlappen kortes ned så den holder seg inni introen', () => {
    expect(transitionScore(t(), t({ introBars: 16 })).bars).toBe(16);
    expect(transitionScore(t(), t({ introBars: 9 })).bars).toBe(8);
    expect(transitionScore(t(), t({ introBars: 4 })).kind).toBe('short');
  });
  it('vokal oppå vokal gir aldri lang blend (kort overgang)', () => {
    // A synger helt til slutten, B synger fra start
    const a = t({ vocals: [[0, 128 * bar]], outroBars: 32 });
    const b = t({ vocals: [[0, 60 * bar]], introBars: 32 });
    const s = transitionScore(a, b);
    expect(s.bars).toBe(0);
    expect(s.kind).toBe('short');
    expect(s.vocalClash).toBe(true);
    expect(suggestPreset({ info: explainTransition(a, b), energyA: 6, energyB: 6 }).reason).toBe('Vokal oppå vokal');
  });
  it('vokal bare i den ene låta er ikke kollisjon', () => {
    const s = transitionScore(t({ vocals: [[90 * bar, 128 * bar]] }), t({ vocals: [] }));
    expect(s.vocalClash).toBe(false);
    expect(s.bars).toBe(32);
  });
  it('toneartskollisjon: kort overgang', () => {
    const s = transitionScore(t({ camelot: '8A' }), t({ camelot: '2B' }));
    expect(s.kind).toBe('short');
    expect(s.reasons).toContain('Toneartskollisjon');
  });
  it('ulik swing (> 4 %): ikke 32 takter, men 16 går', () => {
    const s = transitionScore(t({ groove: { swing: 0.02 } }), t({ groove: { swing: 0.12 } }));
    expect(s.bars).toBe(16);
    expect(s.swingDiff).toBe(10);
  });
  it('bass i begge: bass swap foreslås, og litt straff', () => {
    const a = t({ bassOutro: true, outroNoBass: 0 });
    const b = t({ bassIntro: true, introNoBass: 0 });
    const s = transitionScore(a, b);
    expect(s.bassClash).toBe(true);
    expect(s.cost).toBeGreaterThan(transitionScore(t(), t()).cost);
  });
  it('mikspunktene følger takt-rutenettet (første downbeat)', () => {
    const s = transitionScore(t({ firstDownbeatMs: 250 }), t({ firstDownbeatMs: 480, introBars: 32 }));
    const barsFromDown = (s.outAtMs - 250) / bar;
    expect(Math.abs(barsFromDown - Math.round(barsFromDown))).toBeLessThan(0.01);
    expect(s.inAtMs).toBe(480);
  });
});

import { buildSet } from '../src/setbuilder';
describe('Vibe Shifter i settbyggeren: «slutt mer Tech»', () => {
  it('flere Tech-låter i siste halvdel med valget på', () => {
    const pool = Array.from({ length: 40 }, (_, i) =>
      t({ id: `t${i}`, slug: `s${i}`, title: `S${i}`, durationMs: 300_000, energy: 3 + (i % 7), camelot: `${(i % 3) + 7}A`, tags: i % 4 === 0 ? ['Tech'] : null })
    );
    const opts = { durationMin: 60, curve: 'journey' as const, includeDrafts: true, seed: 3 };
    const techShare = (r: ReturnType<typeof buildSet>) => {
      const back = r!.tracks.slice(Math.floor(r!.tracks.length / 2));
      return back.filter((x) => x.tags?.includes('Tech')).length / back.length;
    };
    expect(techShare(buildSet(pool, { ...opts, styleEnd: 'Tech' }))).toBeGreaterThan(techShare(buildSet(pool, opts)));
  });
});