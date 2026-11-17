import { describe, expect, it } from 'vitest';
import { homeNews } from '../src/lib/home';

/** Del 27 pkt. 9: siste eksport og uhørte nye versjoner først, etter versjonens importtid. */
const t = (slug: string, createdAt: string, version = 1) => ({ slug, main: { manifest: { createdAt, version } } });
const NOW = Date.parse('2026-11-17T12:00:00Z');

describe('homeNews', () => {
  const tracks = [
    t('gammel', '2026-01-01T00:00:00Z', 1),
    t('ny-versjon', '2026-11-16T10:00:00Z', 3), // v3 importert i går
    t('siste', '2026-11-17T09:00:00Z', 1),
    t('umastret', '2026-11-17T11:00:00Z', 1002),
    t('hort', '2026-11-15T10:00:00Z', 2)
  ];
  const played: Record<string, string> = {
    'ny-versjon': '2026-11-10T00:00:00Z', // hørt før v3 kom → uhørt
    hort: '2026-11-16T00:00:00Z' // hørt etter v2 → ikke uhørt
  };

  it('siste eksport er den nyeste release-klare (ikke umastret)', () => {
    expect(homeNews(tracks, (s) => played[s], { now: NOW }).latest?.slug).toBe('siste');
  });
  it('uhørte: ny versjon etter siste avspilling teller, gamle og hørte gjør ikke', () => {
    const r = homeNews(tracks, (s) => played[s], { now: NOW });
    expect(r.unheard.map((x) => x.slug)).toEqual(['umastret', 'ny-versjon']);
  });
  it('tomt bibliotek', () => {
    expect(homeNews([], () => undefined)).toEqual({ latest: null, unheard: [] });
  });
});
