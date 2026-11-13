import { NEON_GLOW_CSS, PLAYLIST_COLORS, type PlaylistColor } from './playlistColors';
export * from './playlistColors';

/**
 * Spillelister (del 9). Lagres av serveren på PC-en (data/playlists.json) og deles av mobil og desktop.
 * Oppføringer peker på slug + variant, aldri på asset-id eller versjon: en ny bounce (_v4) av en låt
 * dukker derfor opp i alle lister av seg selv.
 */

export interface PlaylistEntry {
  /** Unik per oppføring (samme låt kan stå flere ganger). */
  id: string;
  slug: string;
  /** null = følg hovedvarianten. Ellers låst til en variant («spill alltid Extended»). */
  variant: string | null;
  /** null = følg nyeste versjon (standard). Et tall låser oppføringen til den versjonen (f.eks. v3 Demo). */
  version: number | null;
  addedAt: string;
}

export type PlaylistKind = 'manual' | 'smart';

export interface Playlist {
  id: string;
  name: string;
  kind: PlaylistKind;
  /** Bare manuelle lister. */
  entries: PlaylistEntry[];
  /** Bare smarte lister: søket som lagres (samme syntaks som Ctrl+K). */
  query: string | null;
  /** Fargen til lista (id i PLAYLIST_COLORS). */
  color: string;
  /** Eget cover (filnavn i data/playlist-covers/), ellers null = mosaikk. */
  cover: string | null;
  createdAt: string;
  /** Optimistisk låsing: klienten sender denne med, serveren svarer 409 hvis lista er endret i mellomtiden. */
  updatedAt: string;
  /** Sist en låt ble lagt til – styrer «sist brukte» øverst i arket og Ctrl+Shift+P. */
  usedAt: string | null;
}

export interface PlaylistsFile {
  schema: 1;
  playlists: Playlist[];
}

export const PLAYLIST_LIMITS = { name: 80, query: 200, entries: 2000, playlists: 500 } as const;

// ---------------------------------------------------------------- Søk (Ctrl+K og smarte lister)

export interface SearchableManifest {
  title: string;
  slug: string;
  variantLabel?: string | null;
  artist?: string | null;
  venue?: string | null;
  key?: { name?: string | null; camelot: string } | null;
  bpm?: number | null;
  kind: string;
}

/**
 * Alle ord må treffe:
 *  - 2–3 sifre (evt. med desimal) = BPM ± 1,5
 *  - 1–12 + A/B = Camelot-toneart
 *  - sett/set/live = bare live-sett, låt/track = bare låter
 *  - ellers: del av tittel, slug, variant, artist, sted eller tonenavn
 */
export function matchesQuery(m: SearchableManifest, query: string): boolean {
  const hay = [m.title, m.slug, m.variantLabel, m.artist, m.venue, m.key?.name].filter(Boolean).join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => {
      if (/^\d{2,3}([.,]\d)?$/.test(tok)) return m.bpm != null && Math.abs(m.bpm - Number(tok.replace(',', '.'))) <= 1.5;
      if (/^(1[0-2]|[1-9])[ab]$/.test(tok)) return m.key?.camelot.toLowerCase() === tok;
      if (['sett', 'set', 'live'].includes(tok)) return m.kind === 'set';
      if (['låt', 'lat', 'track', 'låter'].includes(tok)) return m.kind === 'track';
      return hay.includes(tok);
    });
}

// ---------------------------------------------------------------- Oppslag mot katalogen

interface HasManifest {
  manifest: SearchableManifest & { variant: string | null; createdAt: string; durationMs: number; bpm?: number | null };
}
export interface TrackLike<A> {
  slug: string;
  main: A;
  variants: A[];
}

/** Innebygde smarte lister. Lagres ikke; finnes alltid. */
export const BUILTIN_SMART = [
  { id: 'builtin:recent', name: 'Nylig lagt til', days: 14 },
  { id: 'builtin:sets', name: 'Live-sett', query: 'sett' }
] as const;
export type BuiltinId = (typeof BUILTIN_SMART)[number]['id'];
export const isBuiltin = (id: string): id is BuiltinId => BUILTIN_SMART.some((b) => b.id === id);

export interface ResolvedEntry<A> {
  entry: PlaylistEntry;
  /** null = utilgjengelig (se reason). Raden vises da med forklaring i stedet for å forsvinne. */
  asset: A | null;
  track: TrackLike<A> | null;
  reason: string | null;
}

/**
 * Oppføring → asset. Låst versjon hvis den finnes (via `findVersion`), ellers låst variant i nyeste
 * versjon, ellers hovedvarianten. Det som ikke finnes lenger, kommer med som utilgjengelig.
 */
export function resolveEntries<A extends HasManifest>(
  entries: PlaylistEntry[],
  tracks: Array<TrackLike<A>>,
  findVersion?: (slug: string, variant: string | null, version: number) => A | undefined
): Array<ResolvedEntry<A>> {
  const bySlug = new Map(tracks.map((t) => [t.slug, t]));
  return entries.map((entry) => {
    const track = bySlug.get(entry.slug) ?? null;
    if (!track) return { entry, asset: null, track: null, reason: 'Låta finnes ikke lenger i hvelvet' };
    if (entry.version != null) {
      const v = findVersion?.(entry.slug, entry.variant, entry.version);
      return v ? { entry, asset: v, track, reason: null } : { entry, asset: null, track, reason: `Versjon ${entry.version} finnes ikke lenger i media/` };
    }
    const asset = (entry.variant !== null && track.variants.find((v) => v.manifest.variant === entry.variant)) || track.main;
    return { entry, asset, track, reason: null };
  });
}

/** Bare det som kan spilles, i rekkefølge. */
export const playableEntries = <A>(rows: Array<ResolvedEntry<A>>) => rows.filter((r): r is ResolvedEntry<A> & { asset: A; track: TrackLike<A> } => r.asset !== null);

/** Treffene i en smart liste, i samme rekkefølge som katalogen (nyeste først). Samme regler som søket. */
export function smartListAssets<A extends HasManifest>(tracks: Array<TrackLike<A>>, spec: { query?: string | null; days?: number }, nowMs = Date.now()): A[] {
  if (spec.days != null) {
    const since = nowMs - spec.days * 86_400_000;
    return tracks.filter((t) => Date.parse(t.main.manifest.createdAt) >= since).map((t) => t.main);
  }
  const q = (spec.query ?? '').trim();
  if (!q) return [];
  // Søket ser på hver variant; en låt teller én gang, med varianten som traff (hovedvarianten foretrekkes).
  const out: A[] = [];
  for (const t of tracks) {
    const hits = [t.main, ...t.variants.filter((v) => v !== t.main)].filter((a) => matchesQuery(a.manifest, q));
    if (hits[0]) out.push(hits[0]);
  }
  return out;
}

export interface PlaylistStats {
  count: number;
  totalMs: number;
  bpmMin: number | null;
  bpmMax: number | null;
}

export function playlistStats(assets: HasManifest[]): PlaylistStats {
  const bpms = assets.map((a) => a.manifest.bpm).filter((b): b is number => typeof b === 'number');
  return {
    count: assets.length,
    totalMs: assets.reduce((s, a) => s + a.manifest.durationMs, 0),
    bpmMin: bpms.length ? Math.min(...bpms) : null,
    bpmMax: bpms.length ? Math.max(...bpms) : null
  };
}

/** «38 min», «1 t 12 min». */
export function formatListDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} t ${min % 60} min` : `${min} min`;
}

/** Flytt ett element (ny liste, originalen røres ikke). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list.slice();
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
  return out;
}

/** Fisher–Yates. `rand` kan byttes ut i tester. */
export function shuffled<T>(list: T[], rand: () => number = Math.random): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Listene sortert for «Legg til»-arket: de 3 sist brukte manuelle øverst, så resten alfabetisk. */
export function addTargets(playlists: Playlist[]): { recent: Playlist[]; rest: Playlist[] } {
  const manual = playlists.filter((p) => p.kind === 'manual');
  const recent = manual
    .filter((p) => p.usedAt)
    .sort((a, b) => b.usedAt!.localeCompare(a.usedAt!))
    .slice(0, 3);
  const rest = manual.filter((p) => !recent.includes(p)).sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  return { recent, rest };
}

// ---------------------------------------------------------------- Farger (pkt. 15)


export const colorById = (id: string | null | undefined): PlaylistColor => PLAYLIST_COLORS.find((c) => c.id === id) ?? PLAYLIST_COLORS[0]!;
export const isPlaylistColor = (id: unknown): id is string => typeof id === 'string' && PLAYLIST_COLORS.some((c) => c.id === id);

/** Ny liste: tilfeldig farge som ingen annen liste bruker, om mulig. */
export function pickColor(used: Iterable<string>, rand: () => number = Math.random): string {
  const taken = new Set(used);
  const free = PLAYLIST_COLORS.filter((c) => !taken.has(c.id));
  const pool = free.length ? free : PLAYLIST_COLORS;
  return pool[Math.floor(rand() * pool.length)]!.id;
}

/** Neon-gløden fra designfila: «0 0 6px #hex, 0 0 18px #hex99, 0 0 36px #hex55». */
export const neonGlow = (primary: string) => NEON_GLOW_CSS.replace(/{primary}/g, primary);

/** Lys kjerne i prikken: primary blandet 60 % mot hvitt (neonrør). */
export function neonCore(primary: string): string {
  const n = parseInt(primary.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.6);
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
}
