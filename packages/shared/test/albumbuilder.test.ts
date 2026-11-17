import { describe, expect, it } from 'vitest';
import { ALBUM_FORMATS, albumCandidates, albumQuality, albumReplacements, buildAlbum, buildAlbumAlternatives, hookMs, vinylSplit, VINYL_SIDE_MAX_MS, type AlbumOptions, type AlbumTrack } from '../src/albumbuilder';
import { rng, songKey } from '../src/setbuilder';

/** Syntetisk bibliotek: 120 låter, noen favoritter, avspillinger, singel-kandidater og duplikatgrupper. */
function library(n = 120, seed = 5): AlbumTrack[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const bpm = Math.round((110 + r() * 25) * 10) / 10;
    return {
      id: `a${i}`,
      slug: `song-${i}`,
      variant: null,
      title: `Song ${i}`,
      durationMs: Math.round((180 + r() * 150) * 1000),
      bpm,
      camelot: `${1 + Math.floor(r() * 12)}${r() < 0.6 ? 'A' : 'B'}`,
      lufs: -9 - r() * 3,
      energy: Math.round((1 + r() * 9) * 10) / 10,
      draft: i % 3 === 0,
      extended: false,
      introMs: (r() < 0.5 ? 8 : 32) * ((4 * 60_000) / bpm),
      outroMs: 16 * ((4 * 60_000) / bpm),
      bpmConfidence: 0.4,
      keyConfidence: 0.5,
      bass: r(),
      transients: r() * 0.3,
      favorite: i % 9 === 0,
      plays: Math.floor(r() * 30),
      singleCandidate: i % 17 === 0,
      titleNeedsReview: false,
      hookMs: 60_000,
      group: i % 20 === 1 ? `g${i}` : null
    };
  });
}
const lib = library();
const opts = (o: Partial<AlbumOptions> = {}): AlbumOptions => ({ format: 'album', seed: 2, includeDrafts: true, ...o });

describe('albumbygger (del 26)', () => {
  it('formatlengder: single 1–3, EP 4–6, album 8–14', () => {
    expect(buildAlbum(lib, opts({ format: 'single' }))!.tracks.length).toBe(ALBUM_FORMATS.single.dflt);
    for (const count of [4, 6]) expect(buildAlbum(lib, opts({ format: 'ep', count }))!.tracks.length).toBe(count);
    for (const count of [8, 10, 14]) expect(buildAlbum(lib, opts({ count }))!.tracks.length).toBe(count);
    expect(buildAlbum(lib, opts({ count: 30 }))!.tracks.length).toBe(14);
    const ep = buildAlbum(lib, opts({ format: 'ep', count: 5 }))!;
    expect(ep.totalMs).toBeGreaterThanOrEqual(ALBUM_FORMATS.ep.minMs);
    expect(ep.totalMs).toBeLessThanOrEqual(ALBUM_FORMATS.ep.maxMs);
  });

  it('vinyl: to sider på maks 22 min', () => {
    const a = buildAlbum(lib, opts({ count: 10, vinyl: true }))!;
    expect(a.sideB).not.toBeNull();
    const A = a.tracks.slice(0, a.sideB!).reduce((s, t) => s + t.durationMs, 0);
    const B = a.tracks.slice(a.sideB!).reduce((s, t) => s + t.durationMs, 0);
    expect(A).toBeLessThanOrEqual(VINYL_SIDE_MAX_MS);
    expect(B).toBeLessThanOrEqual(VINYL_SIDE_MAX_MS);
    expect(vinylSplit([{ durationMs: 30 * 60_000 }, { durationMs: 1 }])).toBeNull();
  });

  it('sterk åpning: den sterkeste låta eller en singel blant de tre første', () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const r of buildAlbumAlternatives(lib, opts({ seed }))) {
        // Samme kvalitetsmål som byggeren (hjerter, avspillinger, mastret, singel), regnet over hele poolen
        const maxPlays = Math.max(...lib.map((t) => t.plays));
        const best = Math.max(...r.tracks.map((t) => albumQuality(t, maxPlays)));
        expect(r.tracks.slice(0, 3).some((t) => t.singleCandidate || albumQuality(t, maxPlays) >= best - 1e-9)).toBe(true);
      }
    }
  });

  it('variasjon: aldri samme toneart tre på rad, aldri tre rolige eller tre harde på rad, ingen nabosingler', () => {
    for (const seed of [1, 2, 3]) {
      for (const r of buildAlbumAlternatives(lib, opts({ seed, count: 12 }))) {
        const t = r.tracks;
        for (let i = 2; i < t.length; i++) {
          expect(t[i]!.camelot === t[i - 1]!.camelot && t[i - 1]!.camelot === t[i - 2]!.camelot).toBe(false);
          expect([t[i - 2]!, t[i - 1]!, t[i]!].every((x) => x.energy <= 4)).toBe(false);
          expect([t[i - 2]!, t[i - 1]!, t[i]!].every((x) => x.energy >= 8)).toBe(false);
        }
        for (let i = 1; i < t.length; i++) expect(t[i]!.singleCandidate && t[i - 1]!.singleCandidate).toBe(false);
      }
    }
  });

  it('aldri to versjoner av samme låt', () => {
    const dup = [...lib, { ...lib[1]!, id: 'kopi', slug: 'song-1-landr', group: lib[1]!.group }];
    for (const r of buildAlbumAlternatives(dup, opts({ count: 14 }))) {
      const keys = r.tracks.map(songKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('låste plasser respekteres, og «Bygg på nytt» beholder dem', () => {
    const r = buildAlbum(lib, opts({ locked: [{ id: 'a40', position: 0 }, { id: 'a77', position: 5 }, { id: 'a90' }] }))!;
    expect(r.tracks[0]!.id).toBe('a40');
    expect(r.tracks[5]!.id).toBe('a77');
    expect(r.tracks.some((t) => t.id === 'a90')).toBe(true);
  });

  it('utelatte låter er aldri med (det som allerede er gitt ut)', () => {
    const exclude = lib.slice(0, 60).map((t) => t.slug);
    for (const r of buildAlbumAlternatives(lib, opts({ exclude }))) expect(r.tracks.some((t) => exclude.includes(t.slug))).toBe(false);
    expect(albumCandidates(lib, opts({ exclude })).length).toBe(lib.length - 60 - 0);
  });

  it('frølåt («album rundt denne») er alltid med', () => {
    for (const r of buildAlbumAlternatives(lib, opts({ seedId: 'a33' }))) expect(r.tracks.some((t) => t.id === 'a33')).toBe(true);
  });

  it('deterministisk med frø, og raskt', () => {
    const t0 = performance.now();
    const a = buildAlbumAlternatives(lib, opts({ seed: 9 }));
    const ms = performance.now() - t0;
    const b = buildAlbumAlternatives(lib, opts({ seed: 9 }));
    expect(a.map((r) => r.tracks.map((t) => t.id))).toEqual(b.map((r) => r.tracks.map((t) => t.id)));
    expect(a.map((r) => r.character)).toEqual(['strongest', 'arc', 'coherence']);
    expect(ms).toBeLessThan(5000);
  });

  it('«Bytt ut» gir fem alternativer som ikke allerede er på albumet', () => {
    const r = buildAlbum(lib, opts())!;
    const alts = albumReplacements(r, 3, lib, opts());
    expect(alts).toHaveLength(5);
    for (const t of alts) expect(r.tracks.some((x) => songKey(x) === songKey(t))).toBe(false);
  });

  it('forhåndslytting: 20 s fra første drop, ellers refreng/hook, ellers 30 % inn', () => {
    const base = { durationMs: 200_000 };
    expect(hookMs({ ...base, markers: [{ kind: 'drop', startMs: 64_000, source: 'auto', confirmed: true }] as never })).toBe(64_000);
    expect(hookMs({ ...base, markers: [{ kind: 'chapter', label: 'Intro', startMs: 0, source: 'auto', confirmed: true }, { kind: 'chapter', label: 'Refreng', startMs: 48_000, source: 'auto', confirmed: true }] as never })).toBe(48_000);
    expect(hookMs({ ...base, markers: [] })).toBe(60_000);
    expect(hookMs({ durationMs: 30_000, markers: [{ kind: 'drop', startMs: 25_000, source: 'auto', confirmed: true }] as never })).toBe(10_000);
  });
});
