import { describe, expect, it } from 'vitest';
import { cleanRelease, isMastered, isReleased, matchesStatus, parseReleaseLink, planStats, preferredVersion, versionName } from '../src/index';

/** Del 25: status Utgitt, «Utgitt master» som foretrukket versjon, og lenker. */
describe('status Utgitt', () => {
  it('utgitt master vinner over nyere release og utkast', () => {
    const v = [
      { version: 1, status: 'release' as const },
      { version: 2, status: 'released' as const },
      { version: 3, status: 'release' as const },
      { version: 1002, status: 'draft' as const }
    ];
    expect(preferredVersion(v)?.version).toBe(2);
    expect(preferredVersion(v.filter((x) => x.status !== 'released'))?.version).toBe(3);
  });
  it('regnes som mastret, ikke som utkast, og har eget filter', () => {
    const m = { version: 2, status: 'released' as const };
    expect(isReleased(m)).toBe(true);
    expect(isMastered(m)).toBe(true);
    expect(matchesStatus(m, 'released')).toBe(true);
    expect(matchesStatus(m, 'release')).toBe(false);
    expect(matchesStatus(m, 'all')).toBe(true);
    expect(versionName(m)).toBe('Utgitt master');
    expect(planStats([{ status: 'released', durationMs: 1, bpm: null, camelot: null }]).mastered).toBe(1);
  });
});

describe('lenker til utgivelsen', () => {
  it('Spotify: låt og album, uten sporingsparametre', () => {
    expect(parseReleaseLink('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123')).toEqual({ platform: 'spotify', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', kind: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });
    expect(parseReleaseLink('https://open.spotify.com/intl-no/album/1abc?si=x')?.kind).toBe('album');
  });
  it('Apple Music, YouTube, Tidal og Beatport', () => {
    expect(parseReleaseLink('https://music.apple.com/no/album/blue-fire-single/1700000000?i=1700000001')).toMatchObject({ platform: 'apple', kind: 'track', id: '1700000001' });
    expect(parseReleaseLink('https://youtu.be/dQw4w9WgXcQ?si=z')).toMatchObject({ platform: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(parseReleaseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share')?.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(parseReleaseLink('https://tidal.com/browse/track/123')?.platform).toBe('tidal');
    expect(parseReleaseLink('https://www.beatport.com/track/blue-fire/999')).toMatchObject({ platform: 'beatport', kind: 'track', id: '999' });
  });
  it('ukjente adresser og tull gir null', () => {
    expect(parseReleaseLink('https://example.com/track/1')).toBeNull();
    expect(parseReleaseLink('ikke en lenke')).toBeNull();
    expect(parseReleaseLink('javascript:alert(1)')).toBeNull();
  });
  it('cleanRelease validerer ISRC, UPC, dato og at lenken hører til riktig tjeneste', () => {
    expect(cleanRelease({ isrc: 'no-abc-26-00001', upc: '123456789012', date: '2026-11-17', links: { spotify: 'https://open.spotify.com/track/x?si=1' } })).toMatchObject({ isrc: 'NOABC2600001', upc: '123456789012', links: { spotify: 'https://open.spotify.com/track/x' } });
    expect(() => cleanRelease({ isrc: '123' })).toThrow(/ISRC/);
    expect(() => cleanRelease({ date: '17.11.2026' })).toThrow(/ÅÅÅÅ-MM-DD/);
    expect(() => cleanRelease({ links: { spotify: 'https://youtu.be/x' } })).toThrow(/Spotify/);
  });
});
