/**
 * Del 25 pkt. 5–6: utgivelsesinfo per låt (lagres i data/releases.json på PC-en, ikke i manifestet).
 * Lenker gjenkjennes lokalt fra adressen – ingen oppslag mot Spotify eller andre tjenester.
 */
export type ReleasePlatform = 'spotify' | 'apple' | 'youtube' | 'tidal' | 'beatport';
export const RELEASE_PLATFORMS: Array<[ReleasePlatform, string]> = [
  ['spotify', 'Spotify'],
  ['apple', 'Apple Music'],
  ['youtube', 'YouTube'],
  ['tidal', 'Tidal'],
  ['beatport', 'Beatport']
];

export interface ReleaseInfo {
  /** ÅÅÅÅ-MM-DD */
  date: string | null;
  distributor: string | null;
  upc: string | null;
  isrc: string | null;
  /** Tittelen på utgivelsen (singel, EP eller album). */
  releaseTitle: string | null;
  releaseType: 'single' | 'ep' | 'album' | null;
  links: Partial<Record<ReleasePlatform, string>>;
  /** Del 25 pkt. 4: utgitt låt uten lyd i Vault – vises med «Mangler lyd» og kan ikke spilles. */
  noAudio?: boolean;
  /** Tittel (brukes når låta ikke finnes i Vault). */
  title?: string | null;
  updatedAt?: string;
}

export const EMPTY_RELEASE: ReleaseInfo = { date: null, distributor: null, upc: null, isrc: null, releaseTitle: null, releaseType: null, links: {} };

const HOSTS: Array<[ReleasePlatform, RegExp]> = [
  ['spotify', /(^|\.)spotify\.com$|^spotify\.link$/],
  ['apple', /(^|\.)music\.apple\.com$|(^|\.)itunes\.apple\.com$/],
  ['youtube', /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)music\.youtube\.com$/],
  ['tidal', /(^|\.)tidal\.com$/],
  ['beatport', /(^|\.)beatport\.com$/]
];

/**
 * «Lim inn en lenke»: hvilken tjeneste, ren adresse (uten sporingsparametre) og hva som kan leses av adressen.
 * Spotify: type (track/album) og id. Apple Music: land og album-id. null = ikke en kjent tjeneste.
 */
export function parseReleaseLink(input: string): { platform: ReleasePlatform; url: string; kind: 'track' | 'album' | 'video' | null; id: string | null } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const platform = HOSTS.find(([, re]) => re.test(host))?.[0];
  if (!platform) return null;
  u.protocol = 'https:';
  // Sporingsparametre fjernes (si=, utm_…); YouTube beholder v=
  const keep = platform === 'youtube' ? ['v', 'list'] : platform === 'apple' ? ['i'] : [];
  for (const k of [...u.searchParams.keys()]) if (!keep.includes(k)) u.searchParams.delete(k);
  u.hash = '';
  let kind: 'track' | 'album' | 'video' | null = null;
  let id: string | null = null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (platform === 'spotify') {
    const i = parts.findIndex((p) => p === 'track' || p === 'album');
    if (i >= 0) {
      kind = parts[i] as 'track' | 'album';
      id = parts[i + 1] ?? null;
    }
  } else if (platform === 'apple') {
    const i = parts.findIndex((p) => p === 'album' || p === 'song');
    if (i >= 0) {
      kind = u.searchParams.get('i') || parts[i] === 'song' ? 'track' : 'album';
      id = u.searchParams.get('i') ?? parts[parts.length - 1] ?? null;
    }
  } else if (platform === 'youtube') {
    kind = 'video';
    id = host === 'youtu.be' ? (parts[0] ?? null) : u.searchParams.get('v');
  } else if (platform === 'beatport' || platform === 'tidal') {
    const i = parts.findIndex((p) => p === 'track' || p === 'album' || p === 'release');
    if (i >= 0) {
      kind = parts[i] === 'track' ? 'track' : 'album';
      id = parts[parts.length - 1] ?? null;
    }
  }
  return { platform, url: u.toString(), kind, id };
}

/** Validerer og renser en utgivelse fra klienten. Kaster med norsk melding ved feil. */
export function cleanRelease(x: unknown): ReleaseInfo {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const date = str(o.date, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Utgivelsesdato må være ÅÅÅÅ-MM-DD');
  const isrc = str(o.isrc, 15)?.toUpperCase().replace(/-/g, '') ?? null;
  if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) throw new Error('ISRC har formen CC-XXX-ÅÅ-NNNNN (12 tegn)');
  const upc = str(o.upc, 14);
  if (upc && !/^\d{12,13}$/.test(upc)) throw new Error('UPC/EAN er 12 eller 13 sifre');
  const type = o.releaseType === 'single' || o.releaseType === 'ep' || o.releaseType === 'album' ? o.releaseType : null;
  const links: ReleaseInfo['links'] = {};
  const raw = (o.links && typeof o.links === 'object' ? o.links : {}) as Record<string, unknown>;
  for (const [p] of RELEASE_PLATFORMS) {
    const v = str(raw[p], 500);
    if (!v) continue;
    const parsed = parseReleaseLink(v);
    if (!parsed || parsed.platform !== p) throw new Error(`Lenken for ${RELEASE_PLATFORMS.find(([k]) => k === p)![1]} ser ikke ut som en ${RELEASE_PLATFORMS.find(([k]) => k === p)![1]}-lenke`);
    links[p] = parsed.url;
  }
  return { date, distributor: str(o.distributor, 60), upc, isrc, releaseTitle: str(o.releaseTitle, 120), releaseType: type, links, ...(o.noAudio === true ? { noAudio: true, title: str(o.title, 120) } : {}) };
}
