import { describe, expect, it } from 'vitest';
import type { AssetManifest } from '@gv/shared/web';
import { PAGE, searchCatalog, titleSimilarity } from '../src/lib/search';
import { parsePlayerRoute, playerUrl, viewFromParam } from '../src/lib/route';

/** Del 27 pkt. 6: søk med 0, 1, 30 og flere enn 30 treff. */
const a = (title: string, bpm = 124, camelot = '8A') => ({ manifest: { id: title, slug: title.toLowerCase().replace(/\W+/g, '-'), title, variant: null, variantLabel: null, artist: 'EG', venue: null, kind: 'track', bpm, key: { name: 'A minor', camelot }, createdAt: '2026-01-01', durationMs: 1000 } as unknown as AssetManifest });

const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => a(`${prefix} ${String(i + 1).padStart(2, '0')}`));

describe('searchCatalog', () => {
  const pool = [a('Blue Fire', 126, '5A'), a('Like The Sun', 122), a('Move Like That', 124), ...many(45, 'Groove Tool')];

  it('0 treff: forslag med nærmeste titler', () => {
    const r = searchCatalog(pool, 'blu fier');
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.suggestions[0]).toBe('Blue Fire');
  });
  it('0 treff uten noe som ligner: ingen forslag', () => {
    expect(searchCatalog(pool, 'zzqx').suggestions).toEqual([]);
  });
  it('1 treff', () => {
    const r = searchCatalog(pool, 'blue');
    expect(r.total).toBe(1);
    expect(r.results.map((x) => x.manifest.title)).toEqual(['Blue Fire']);
  });
  it('nøyaktig 30 treff: alle vises, ingen «Vis flere»', () => {
    const r = searchCatalog(many(30, 'Deep'), 'deep');
    expect(r.total).toBe(30);
    expect(r.results).toHaveLength(30);
  });
  it('flere enn 30: reelt antall, 30 vises, og «Vis flere» gir 30 til', () => {
    const r = searchCatalog(pool, 'groove');
    expect(r.total).toBe(45);
    expect(r.results).toHaveLength(PAGE);
    expect(searchCatalog(pool, 'groove', PAGE * 2).results).toHaveLength(45);
  });
  it('BPM og toneart virker som før', () => {
    expect(searchCatalog(pool, '126').results.map((x) => x.manifest.title)).toEqual(['Blue Fire']);
    expect(searchCatalog(pool, '5a').total).toBe(1);
  });
  it('titleSimilarity tåler stavefeil', () => {
    expect(titleSimilarity('like teh sun', 'Like The Sun')).toBeGreaterThan(0.6);
    expect(titleSimilarity('abc', 'xyz')).toBe(0);
  });
});

describe('adresser per visning (del 27 pkt. 5)', () => {
  it('/?vis=live-sett åpner Live-sett, også med mellomrom og store bokstaver', () => {
    expect(viewFromParam('live-sett')).toBe('sets');
    expect(viewFromParam('Live sett')).toBe('sets');
    expect(parsePlayerRoute('?vis=live-sett').view).toBe('sets');
  });
  it('liste og fane tas med, og adressen kan leses tilbake', () => {
    const r = { view: 'playlists' as const, listId: 'builtin:favorites', setsTab: null };
    expect(parsePlayerRoute(playerUrl(r).slice(1))).toEqual(r);
    const s = { view: 'sets' as const, listId: null, setsTab: 'build' as const };
    expect(playerUrl(s)).toBe('/?vis=live-sett&fane=lag');
    expect(parsePlayerRoute('?vis=live-sett&fane=lag')).toEqual(s);
  });
  it('Hjem er rotadressen, og ukjente verdier gir Hjem', () => {
    expect(playerUrl({ view: 'home', listId: null, setsTab: null })).toBe('/');
    expect(parsePlayerRoute('?vis=tull').view).toBe('home');
    expect(parsePlayerRoute('?vis=bibliotek&liste=x').listId).toBeNull();
  });
});
