import type { View } from '../components/Nav';

/**
 * Del 27 pkt. 5: hver visning og fane i spilleren har sin egen adresse, så Tilbake, Frem, oppdatering og
 * delte lenker gir riktig visning:
 *   /                          Hjem
 *   /?vis=bibliotek            Bibliotek
 *   /?vis=spillelister&liste=… en bestemt liste
 *   /?vis=live-sett&fane=lag   Live-sett → Lag sett (fane: innspilte | planlagte | lag)
 *   /?vis=dj · /?vis=analyse
 * Gamle og alternative navn (/?vis=sett, /?vis=lister, «Live sett») virker fortsatt.
 */
export type SetsTab = 'recorded' | 'planned' | 'build';
export interface PlayerRoute {
  view: View;
  listId: string | null;
  setsTab: SetsTab | null;
}

const VIEW_PARAM: Record<string, View> = { hjem: 'home', bibliotek: 'library', lister: 'playlists', spillelister: 'playlists', sett: 'sets', 'live-sett': 'sets', livesett: 'sets', live: 'sets', dj: 'dj', 'dj-verktøy': 'dj', 'dj-verktoy': 'dj', analyse: 'stats', statistikk: 'stats' };
const VIEW_SLUG: Record<View, string | null> = { home: null, library: 'bibliotek', playlists: 'spillelister', sets: 'live-sett', dj: 'dj', stats: 'analyse' };
const TAB_PARAM: Record<string, SetsTab> = { innspilte: 'recorded', planlagte: 'planned', lag: 'build', 'lag-sett': 'build' };
const TAB_SLUG: Record<SetsTab, string> = { recorded: 'innspilte', planned: 'planlagte', build: 'lag' };

const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Leser ?vis=… uten å bry seg om store bokstaver eller mellomrom («Live sett»). */
export const viewFromParam = (v: string | null): View | undefined => (v ? VIEW_PARAM[norm(v)] : undefined);

export function parsePlayerRoute(search: string): PlayerRoute {
  const q = new URLSearchParams(search);
  const view = viewFromParam(q.get('vis')) ?? 'home';
  const liste = q.get('liste');
  const fane = q.get('fane');
  return {
    view,
    listId: view === 'playlists' && liste && /^[\w:-]{1,80}$/.test(liste) ? liste : null,
    setsTab: view === 'sets' && fane ? (TAB_PARAM[norm(fane)] ?? null) : null
  };
}

export function playerUrl(r: PlayerRoute): string {
  const q = new URLSearchParams();
  const slug = VIEW_SLUG[r.view];
  if (slug) q.set('vis', slug);
  if (r.view === 'playlists' && r.listId) q.set('liste', r.listId);
  if (r.view === 'sets' && r.setsTab) q.set('fane', TAB_SLUG[r.setsTab]);
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

export const sameRoute = (a: PlayerRoute, b: PlayerRoute) => playerUrl(a) === playerUrl(b);
