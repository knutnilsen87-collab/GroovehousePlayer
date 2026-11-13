import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addTargets, colorById, moveItem, neonCore, neonGlow, pickColor, PLAYLIST_COLORS, playlistStats, shuffled, type Playlist } from '../src/playlists';

const design = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'design', 'playlist-colors.json'), 'utf8')) as {
  neonGlow: { css: string };
  colors: Array<{ id: string; name: string; group: string; primary: string; secondary: string; onPrimary: string }>;
};

describe('spillelistefarger', () => {
  it('er nøyaktig paletten i docs/design/playlist-colors.json: 40 farger, 22 Neon og 18 Candy, uten gull', () => {
    expect(PLAYLIST_COLORS).toEqual(design.colors.map(({ id, name, group, primary, secondary, onPrimary }) => ({ id, name, group, primary, secondary, onPrimary })));
    expect(PLAYLIST_COLORS).toHaveLength(40);
    expect(PLAYLIST_COLORS.filter((c) => c.group === 'neon')).toHaveLength(22);
    expect(PLAYLIST_COLORS.filter((c) => c.group === 'candy')).toHaveLength(18);
    expect(PLAYLIST_COLORS.map((c) => c.primary.toUpperCase())).not.toContain('#F0C030');
    expect(new Set(PLAYLIST_COLORS.map((c) => c.id)).size).toBe(40);
  });

  it('ny liste får en ledig farge så lenge det finnes en', () => {
    const used = PLAYLIST_COLORS.slice(0, 39).map((c) => c.id);
    expect(pickColor(used, () => 0.99)).toBe(PLAYLIST_COLORS[39]!.id);
    expect(PLAYLIST_COLORS.map((c) => c.id)).toContain(pickColor(PLAYLIST_COLORS.map((c) => c.id)));
    expect(colorById('finnes-ikke')).toBe(PLAYLIST_COLORS[0]);
  });

  it('neon-glød etter oppskriften, og lys kjerne 60 % mot hvitt', () => {
    expect(neonGlow('#2FE6FF')).toBe(design.neonGlow.css.replace(/\{primary\}/g, '#2FE6FF'));
    expect(neonCore('#000000')).toBe('#999999');
    expect(neonCore('#FFFFFF')).toBe('#FFFFFF');
  });
});

describe('hjelpere', () => {
  it('flytter, blander og regner ut statistikk', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    const s = shuffled([1, 2, 3, 4, 5], () => 0);
    expect([...s].sort()).toEqual([1, 2, 3, 4, 5]);
    const a = (bpm: number | null, ms: number) => ({ manifest: { bpm, durationMs: ms, title: '', slug: '', kind: 'track', variant: null, createdAt: '' } });
    expect(playlistStats([a(124, 60_000), a(null, 30_000), a(128, 90_000)])).toEqual({ count: 3, totalMs: 180_000, bpmMin: 124, bpmMax: 128 });
  });

  it('«Legg til»-arket: de 3 sist brukte manuelle listene øverst, resten alfabetisk', () => {
    const p = (name: string, usedAt: string | null, kind: 'manual' | 'smart' = 'manual') => ({ id: name, name, kind, usedAt }) as Playlist;
    const { recent, rest } = addTargets([p('Åtte', null), p('B', '2026-11-03'), p('C', '2026-11-04'), p('D', '2026-11-01'), p('E', '2026-11-02'), p('Smart', '2026-11-05', 'smart'), p('A', null)]);
    expect(recent.map((x) => x.name)).toEqual(['C', 'B', 'E']);
    expect(rest.map((x) => x.name)).toEqual(['A', 'D', 'Åtte']);
  });
});
