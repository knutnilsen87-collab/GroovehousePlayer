import { describe, expect, it } from 'vitest';
import { buildAlternatives, buildSet, curveAt, moreLikeThis, rng, seedIndex, simOf, songKey, type BuildOptions, type SbTrack } from '../src/setbuilder';
import { similarity, simParts } from '../src/similarity';

/** Syntetisk katalog med bass/transienter (likhetsmålet), deterministisk. */
function catalog(n = 300, seed = 11): SbTrack[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const bpm = Math.round((118 + r() * 14) * 10) / 10;
    return {
      id: `t${i}`,
      slug: `lat-${i}`,
      variant: null,
      title: `Låt ${i}`,
      durationMs: Math.round((240 + r() * 180) * 1000),
      bpm,
      camelot: `${1 + Math.floor(r() * 12)}${r() < 0.7 ? 'A' : 'B'}`,
      lufs: -9 - r() * 4,
      energy: Math.round((1 + r() * 9) * 10) / 10,
      draft: i % 7 === 0,
      extended: false,
      introMs: 32 * ((4 * 60_000) / bpm),
      outroMs: 32 * ((4 * 60_000) / bpm),
      bpmConfidence: 0.6,
      keyConfidence: 0.6,
      bass: r(),
      transients: r() * 0.3
    };
  });
}
const opts = (o: Partial<BuildOptions> = {}): BuildOptions => ({ durationMin: 60, curve: 'journey', seed: 3, includeDrafts: true, ...o });

describe('likhetsmål (felles for frølåt og albumbygger)', () => {
  const a = { bpm: 124, camelot: '8A', energy: 6, bass: 0.6, transients: 0.1, lufs: -9 };
  it('lik låt = 1, ulik lavere; halv/dobbel tempo regnes som nær', () => {
    expect(similarity(a, a)).toBeCloseTo(1, 5);
    expect(similarity(a, { ...a, camelot: '2B', energy: 1, bass: 0 })).toBeLessThan(0.6);
    expect(simParts(a, { ...a, bpm: 62 }).bpm).toBe(1);
  });
  it('groove og stil-tagger teller først når begge har dem (kobles på uten omskriving)', () => {
    expect(simParts(a, a).groove).toBeNull();
    expect(simParts(a, a).tags).toBeNull();
    const g = { ...a, groove: { swing: 0.0 }, tags: ['Deep'] };
    const h = { ...a, groove: { swing: 0.12 }, tags: ['Tech'] };
    expect(similarity(g, h)).toBeLessThan(similarity(a, a));
    expect(simParts(g, { ...g, tags: ['deep', 'Tech'] }).tags).toBeCloseTo(0.5);
  });
});

describe('«Lag sett fra denne» (del 20 E)', () => {
  const pool = catalog();
  it('frølåta er alltid med, på valgt plass', () => {
    for (const id of ['t5', 't42', 't133']) {
      const start = buildSet(pool, opts({ seedTrack: { id, place: 'start' } }))!;
      expect(start.tracks[0]!.id).toBe(id);
      const end = buildSet(pool, opts({ seedTrack: { id, place: 'end' } }))!;
      expect(end.tracks[end.tracks.length - 1]!.id).toBe(id);
      const peak = buildSet(pool, opts({ seedTrack: { id, place: 'peak' } }))!;
      const pi = peak.tracks.findIndex((t) => t.id === id);
      const n = peak.tracks.length;
      // Toppen av «Reise»-kurven
      const top = seedIndex(n, 'peak', 0, 'journey');
      expect(Math.abs(pi - top)).toBeLessThanOrEqual(1);
    }
  });

  it('«der den passer»: lav energi havner tidlig, høy energi nær toppen', () => {
    const low = pool.find((t) => t.energy <= 2)!;
    const high = pool.find((t) => t.energy >= 9.5)!;
    const rl = buildSet(pool, opts({ seedTrack: { id: low.id } }))!;
    const rh = buildSet(pool, opts({ seedTrack: { id: high.id } }))!;
    const fl = rl.tracks.findIndex((t) => t.id === low.id) / (rl.tracks.length - 1);
    const fh = rh.tracks.findIndex((t) => t.id === high.id) / (rh.tracks.length - 1);
    expect(Math.abs(curveAt('journey', fl) - low.energy)).toBeLessThan(Math.abs(curveAt('journey', fh) - low.energy));
    expect(fh).toBeGreaterThan(fl);
  });

  it('låtene nær frølåta ligner mer på den enn uten frølåt-vekting', () => {
    let withSeed = 0;
    let without = 0;
    for (const id of ['t5', 't42', 't133', 't200', 't250']) {
      const seed = pool.find((t) => t.id === id)!;
      const a = buildSet(pool, opts({ seedTrack: { id } }))!;
      const at = a.tracks.findIndex((t) => t.id === id);
      const b = buildSet(pool, opts({ seedTrack: { id, affinity: 0 } }))!;
      const bt = b.tracks.findIndex((t) => t.id === id);
      const near = (seq: SbTrack[], i: number) => seq.filter((_, j) => j !== i && Math.abs(j - i) <= 2).map((t) => similarity(simOf(t), simOf(seed)));
      const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      withSeed += avg(near(a.tracks, at));
      without += avg(near(b.tracks, bt));
    }
    expect(withSeed).toBeGreaterThan(without);
  });

  it('aldri to versjoner av samme låt, heller ikke av frølåta', () => {
    const dup = pool.map((t, i) => (i % 5 === 0 ? { ...t, group: `g${Math.floor(i / 10)}` } : t));
    const extra = { ...dup[10]!, id: 'kopi-av-t10', slug: 'kopi-av-t10', group: dup[10]!.group };
    const all = [...dup, extra];
    for (const alt of buildAlternatives(all, opts({ seedTrack: { id: 't10' } }))) {
      const keys = alt.tracks.map(songKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(alt.tracks.some((t) => t.id === 't10')).toBe(true);
      expect(alt.tracks.some((t) => t.id === 'kopi-av-t10')).toBe(false);
    }
  });

  it('deterministisk, og tre forslag på 300 låter godt under 5 s', () => {
    const t0 = performance.now();
    const a = buildAlternatives(pool, opts({ seedTrack: { id: 't42' } }));
    const ms = performance.now() - t0;
    const b = buildAlternatives(pool, opts({ seedTrack: { id: 't42' } }));
    expect(a.map((x) => x.tracks.map((t) => t.id))).toEqual(b.map((x) => x.tracks.map((t) => t.id)));
    expect(a).toHaveLength(3);
    expect(ms).toBeLessThan(5000);
  });
});

describe('«Mer som denne»', () => {
  const pool = catalog();
  it('10–20 låter, frølåta først, ingen samme låt to ganger, deterministisk', () => {
    const dup = pool.map((t) => (t.id === 't7' || t.id === 't8' ? { ...t, group: 'g-sju' } : t));
    const q = moreLikeThis(dup, 't7');
    expect(q[0]!.id).toBe('t7');
    expect(q.length).toBeGreaterThanOrEqual(10);
    expect(q.length).toBeLessThanOrEqual(20);
    expect(q.some((t) => t.id === 't8')).toBe(false);
    expect(new Set(q.map(songKey)).size).toBe(q.length);
    expect(moreLikeThis(dup, 't7').map((t) => t.id)).toEqual(q.map((t) => t.id));
  });
  it('ligner mer på frølåta enn tilfeldige låter', () => {
    const seed = pool.find((t) => t.id === 't42')!;
    const q = moreLikeThis(pool, 't42').slice(1);
    const avg = (xs: SbTrack[]) => xs.reduce((s, t) => s + similarity(simOf(t), simOf(seed)), 0) / xs.length;
    expect(avg(q)).toBeGreaterThan(avg(pool.filter((t) => t.id !== 't42')) + 0.1);
  });
});
