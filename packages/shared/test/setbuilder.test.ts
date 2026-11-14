import { describe, expect, it } from 'vitest';
import {
  adjustWeights,
  buildAlternatives,
  buildSet,
  camelotRelation,
  candidates,
  curveAt,
  explainTransition,
  mixPoint,
  phraseBars,
  replacementsFor,
  rng,
  tempoDiff,
  type BuildOptions,
  type SbTrack
} from '../src/setbuilder';

/** Syntetisk katalog: 200 låter, deterministisk. */
function catalog(n = 200, seed = 42): SbTrack[] {
  const r = rng(seed);
  const out: SbTrack[] = [];
  for (let i = 0; i < n; i++) {
    const num = 1 + Math.floor(r() * 12);
    const minor = r() < 0.7;
    const bpm = Math.round((118 + r() * 14) * 10) / 10;
    out.push({
      id: `t${i}`,
      slug: `lat-${i}`,
      variant: null,
      title: `Låt ${i}`,
      durationMs: Math.round((240 + r() * 180) * 1000),
      bpm,
      camelot: `${num}${minor ? 'A' : 'B'}`,
      lufs: -9 - r() * 4,
      energy: Math.round((1 + r() * 9) * 10) / 10,
      draft: i % 10 === 0,
      extended: false,
      introMs: (16 + Math.floor(r() * 3) * 16) * ((4 * 60_000) / bpm),
      outroMs: (16 + Math.floor(r() * 3) * 16) * ((4 * 60_000) / bpm),
      bpmConfidence: 0.6,
      keyConfidence: 0.6
    });
  }
  return out;
}
const opts = (o: Partial<BuildOptions> = {}): BuildOptions => ({ durationMin: 60, curve: 'journey', seed: 7, ...o });

describe('Camelot-relasjoner (alle 24 nøkler)', () => {
  it('samme, ±1, relativ, +2, +7 og brudd – med omløp 12 → 1', () => {
    for (let n = 1; n <= 12; n++) {
      for (const L of ['A', 'B']) {
        const k = `${n}${L}`;
        const w = (d: number) => `${((((n - 1 + d) % 12) + 12) % 12) + 1}${L}`;
        expect(camelotRelation(k, k)).toBe('same');
        expect(camelotRelation(k, w(1))).toBe('adjacent');
        expect(camelotRelation(k, w(-1))).toBe('adjacent');
        expect(camelotRelation(k, `${n}${L === 'A' ? 'B' : 'A'}`)).toBe('relative');
        expect(camelotRelation(k, w(2))).toBe('boost2');
        expect(camelotRelation(k, w(7))).toBe('boost7');
        expect(camelotRelation(k, w(4))).toBe('clash');
        expect(camelotRelation(k, `${w(3).slice(0, -1)}${L === 'A' ? 'B' : 'A'}`)).toBe('clash');
      }
    }
    expect(camelotRelation(null, '8A')).toBe('unknown');
    expect(explainTransition({ ...catalog(1)[0]!, camelot: '8A' }, { ...catalog(1)[0]!, camelot: '9A' }).label).toBe('8A → 9A');
  });
});

describe('tempo og mikspunkter', () => {
  it('halv og dobbel tempo regnes som match', () => {
    expect(tempoDiff(124, 124)).toBe(0);
    expect(Math.abs(tempoDiff(124, 62)!)).toBeLessThan(1e-9);
    expect(Math.abs(tempoDiff(124, 248)!)).toBeLessThan(1e-9);
    expect(tempoDiff(124, 127.72)!).toBeCloseTo(0.03, 3);
    expect(tempoDiff(null, 124)).toBeNull();
  });
  it('mikspunkt på frasegrenser (8/16/32 takter)', () => {
    expect([phraseBars(40), phraseBars(20), phraseBars(9), phraseBars(4)]).toEqual([32, 16, 8, 0]);
    const t = catalog(1)[0]!;
    const bar = (4 * 60_000) / t.bpm!;
    const mp = mixPoint({ ...t, outroMs: 32 * bar, durationMs: 300_000 }, { ...t, introMs: 16 * bar });
    expect(mp.bars).toBe(16);
    expect(Math.abs(mp.outAtMs / (16 * bar) - Math.round(mp.outAtMs / (16 * bar)))).toBeLessThan(1e-3); // hele ms
  });
});

describe('settbyggeren (del 17)', () => {
  const all = catalog();

  it('ingen duplikater og ingen to varianter av samme låt; utkast utelatt som standard', () => {
    const withVariants = [...all, { ...all[1]!, id: 'ext1', variant: 'extended', extended: true }];
    const r = buildSet(withVariants, opts())!;
    const slugs = r.tracks.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(r.tracks.some((t) => t.draft)).toBe(false);
    expect(buildSet(all, opts({ includeDrafts: true }))!.tracks.length).toBeGreaterThan(5);
  });

  it('Extended foretrekkes i sett ≥ 30 min, originalen i korte', () => {
    const vs = [{ ...all[1]!, id: 'o' }, { ...all[1]!, id: 'x', variant: 'extended', extended: true }];
    expect(candidates(vs, opts({ durationMin: 60 }))[0]!.id).toBe('x');
    expect(candidates(vs, opts({ durationMin: 20 }))[0]!.id).toBe('o');
  });

  it('varigheten treffes, og energikurven følger målet innen toleranse', () => {
    for (const curve of ['warmup', 'closing', 'journey'] as const) {
      const r = buildSet(all, opts({ curve }))!;
      expect(Math.abs(r.totalMs - 60 * 60_000) / (60 * 60_000)).toBeLessThan(0.1);
      let at = 0;
      const dev: number[] = [];
      for (const t of r.tracks) {
        dev.push(Math.abs(t.energy - curveAt(curve, (at + t.durationMs / 2) / r.totalMs)));
        at += t.durationMs;
      }
      expect(dev.reduce((a, b) => a + b, 0) / dev.length).toBeLessThan(1.5);
    }
    // Oppvarming stiger, avslutning faller
    const up = buildSet(all, opts({ curve: 'warmup' }))!.tracks;
    expect(up[up.length - 1]!.energy).toBeGreaterThan(up[0]!.energy);
    const down = buildSet(all, opts({ curve: 'closing' }))!.tracks;
    expect(down[0]!.energy).toBeGreaterThan(down[down.length - 1]!.energy);
  });

  it('harmonisk: de fleste overganger er samme, ±1 eller relativ', () => {
    const r = buildSet(all, opts({ weights: { harmonic: 2.5 } }))!;
    const good = r.tracks.slice(1).filter((t, i) => ['same', 'adjacent', 'relative'].includes(camelotRelation(r.tracks[i]!.camelot, t.camelot))).length;
    expect(good / (r.tracks.length - 1)).toBeGreaterThan(0.7);
  });

  it('låste plasser respekteres; festede uten plass blir med', () => {
    const r = buildSet(all, opts({ mustInclude: [{ id: 't5', position: 0 }, { id: 't77', position: 3 }, { id: 't123' }] }))!;
    expect(r.tracks[0]!.id).toBe('t5');
    expect(r.tracks[3]!.id).toBe('t77');
    expect(r.tracks.some((t) => t.id === 't123')).toBe(true);
  });

  it('utelatte låter og BPM-spenn', () => {
    const r = buildSet(all, opts({ exclude: ['lat-3', 'lat-4'], bpmMin: 122, bpmMax: 128 }))!;
    expect(r.tracks.some((t) => t.slug === 'lat-3' || t.slug === 'lat-4')).toBe(false);
    expect(r.tracks.every((t) => t.bpm! >= 122 && t.bpm! <= 128)).toBe(true);
  });

  it('deterministisk med frø', () => {
    const a = buildSet(all, opts({ seed: 3 }))!.tracks.map((t) => t.id);
    const b = buildSet(all, opts({ seed: 3 }))!.tracks.map((t) => t.id);
    expect(a).toEqual(b);
  });

  it('tre ulike alternativer på under 3 s med 200 låter', () => {
    const t0 = performance.now();
    const alts = buildAlternatives(all, opts());
    const ms = performance.now() - t0;
    expect(alts.map((a) => a.character)).toEqual(['harmonic', 'energy', 'variety']);
    expect(ms).toBeLessThan(3000);
    const [x, y] = [new Set(alts[0]!.tracks.map((t) => t.slug)), alts[1]!.tracks.map((t) => t.slug)];
    expect(y.filter((s) => x.has(s)).length / y.length).toBeLessThan(0.8);
    for (const a of alts) expect(a.score).toBeGreaterThan(0);
  });

  it('«Bytt ut» gir 5 alternativer som ikke er i settet', () => {
    const r = buildSet(all, opts())!;
    const alts = replacementsFor(r.tracks, 2, all, opts());
    expect(alts).toHaveLength(5);
    const used = new Set(r.tracks.map((t) => t.slug));
    expect(alts.every((a) => !used.has(a.track.slug))).toBe(true);
    expect(alts[0]!.cost).toBeLessThanOrEqual(alts[4]!.cost);
  });

  it('læring: bytter som bedrer harmonien gir harmoni litt mer vekt, innenfor grensene', () => {
    const ev = Array.from({ length: 30 }, () => ({ type: 'replace' as const, before: { harmonic: 1, tempo: 0.2, mix: 0, lufs: 0 }, after: { harmonic: 0.1, tempo: 0.2, mix: 0, lufs: 0 } }));
    const w = adjustWeights(ev);
    expect(w.harmonic).toBeGreaterThan(1.5);
    expect(w.harmonic).toBeLessThanOrEqual(2);
    expect(w.tempo).toBe(1);
  });
});
