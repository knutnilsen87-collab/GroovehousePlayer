import { describe, expect, it } from 'vitest';
import { estimateKeyEdma, estimateTempoHouse, foldHpcp, tempoPerChapter } from '../src/music';
import { bpmOk, keyNear, keyOk, summarize, synthExpr, SYNTH_CASES, type Row } from '../src/eval';

const hopRate = 22050 / 128;
/** Pulser: `every` = hvert slag (1) eller annethvert (2, halvtempo-kick). */
const pulses = (bpm: number, seconds: number, every = 1) => {
  const n = Math.round(seconds * hopRate);
  const a = new Float32Array(n);
  const period = ((60 * every) / bpm) * hopRate;
  for (let t = 0; t < n; t += period) a[Math.round(t)] = 1;
  return a;
};
/** HPCP (240 per oktav) for en treklang, forskjøvet `cents`. */
const triad = (pcs: number[], cents = 0, bins = 240) => {
  const h = new Array(bins).fill(0.01);
  const per = bins / 12;
  pcs.forEach((pc, i) => {
    const idx = Math.round(pc * per + (cents / 100) * per);
    h[((idx % bins) + bins) % bins] += [1, 0.8, 0.9][i] ?? 0.5;
  });
  return h;
};

describe('del 3: tempo med kam og house-regel', () => {
  it.each([121, 124, 125.5, 128, 131])('presist innenfor ±0,3 BPM (%s)', (bpm) => {
    const r = estimateTempoHouse(pulses(bpm, 60), hopRate)!;
    expect(Math.abs(r.bpm - bpm)).toBeLessThanOrEqual(0.3);
    expect(r.house).toBe(true);
  });
  it('halvtempo-kick (annethvert slag) havner i house-området', () => {
    const r = estimateTempoHouse(pulses(126, 60, 2), hopRate)!;
    expect(Math.abs(r.bpm - 126)).toBeLessThanOrEqual(0.5);
  });
  it('tempo utenfor house (100 BPM) beholdes', () => {
    const r = estimateTempoHouse(pulses(100, 60), hopRate)!;
    expect(Math.abs(r.bpm - 100)).toBeLessThanOrEqual(0.5);
    expect(r.house).toBe(false);
  });
  it('tempo per kapittel i et sett (124 → 128), korte kapitler hoppes over', () => {
    const a = pulses(124, 60);
    const b = pulses(128, 60);
    const all = new Float32Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    const per = tempoPerChapter(all, hopRate, [{ startMs: 0, endMs: 60_000 }, { startMs: 60_000, endMs: 120_000 }, { startMs: 119_000 }], 120_000);
    expect(Math.abs(per[0]! - 124)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(per[1]! - 128)).toBeLessThanOrEqual(0.5);
    expect(per[2]).toBeNull();
  });
});

describe('del 3: toneart med tuning og EDMA', () => {
  it('finner tuning og folder riktig – også nær en halv halvtone (+45 c)', () => {
    expect(foldHpcp(triad([9, 0, 4], 0)).tuningCents).toBe(0);
    expect(foldHpcp(triad([9, 0, 4], 30)).tuningCents).toBe(30);
    expect(foldHpcp(triad([9, 0, 4], -45)).tuningCents).toBe(-45);
    expect(estimateKeyEdma(triad([11, 2, 6], 45))!.camelot).toBe('10A'); // h-moll 45 cent høy
  });
  it('A-moll og C-dur', () => {
    expect(estimateKeyEdma(triad([9, 0, 4]))!.camelot).toBe('8A');
    expect(estimateKeyEdma(triad([0, 4, 7]))!.camelot).toBe('8B');
    expect(estimateKeyEdma(new Array(240).fill(0))).toBeNull();
  });
});

describe('del 3: evaluering', () => {
  it('poengregler: BPM ±0,5, eksakt Camelot, «nær» = nabo/relativ', () => {
    expect(bpmOk(124.4, 124)).toBe(true);
    expect(bpmOk(124.6, 124)).toBe(false);
    expect(bpmOk(62, 124)).toBe(false);
    expect(keyOk('8a', '8A')).toBe(true);
    expect(keyNear('8B', '8A')).toBe(true);
    expect(keyNear('9A', '8A')).toBe(true);
    expect(keyNear('3A', '8A')).toBe(false);
    const rows: Row[] = [
      { slug: 'a', truth: { bpm: 124, camelot: '8A' }, old: { bpm: 62, camelot: '8B' }, next: { bpm: 124.2, camelot: '8A' }, harmonicShare: 1, tuningCents: 0 },
      { slug: 'b', truth: { bpm: null, camelot: '5A' }, old: { bpm: 1, camelot: '5A' }, next: { bpm: 1, camelot: '5A' }, harmonicShare: 1, tuningCents: 0 }
    ];
    expect(summarize(rows)).toEqual({ nBpm: 1, nKey: 2, old: { bpm: 0, key: 1, near: 1 }, next: { bpm: 1, key: 2, near: 0 } });
  });
  it('syntetiske signaler er gyldige ffmpeg-uttrykk uten kanal-skilletegn', () => {
    for (const c of SYNTH_CASES) {
      const e = synthExpr(c);
      expect(e).not.toContain('|');
      expect(e.split('(').length).toBe(e.split(')').length);
    }
  });
});
