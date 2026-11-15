import { formatTime } from './naming';

/**
 * Del 5: «fortsett der du slapp» mellom PC og mobil.
 * Nyeste tidsstempel vinner. Supabase-tabellen playback_positions har samme felt,
 * men Vault-serveren er synkflaten så lenge telefonen allerede når PC-en.
 */
export interface PlaybackPoint {
  slug: string;
  /** «main» når låta ikke har en navngitt variant. */
  variant: string;
  positionMs: number;
  updatedAt: string;
  deviceId: string;
  deviceLabel: string;
}

export interface PlaybackClaim {
  deviceId: string;
  slug: string;
  variant: string;
  at: string;
}

export const pointKey = (p: { slug: string; variant: string }) => `${p.slug}::${p.variant}`;

/** Nyeste tidsstempel vinner. Lik tid: den innkommende, så et nytt skriv ikke blir forkastet ved klokkeskjevhet på samme millisekund. */
export function mergePoint(current: PlaybackPoint | null, incoming: PlaybackPoint): PlaybackPoint {
  if (!current) return incoming;
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
}

/**
 * Banner når en annen enhet har en nyere posisjon.
 * Samme låt teller bare når avstanden er over 15 sekunder, så små avvik ikke spør hver gang.
 */
export function resumeOffer(local: PlaybackPoint | null, remote: PlaybackPoint | null, thisDeviceId: string): PlaybackPoint | null {
  if (!remote || remote.deviceId === thisDeviceId) return null;
  if (remote.positionMs < 10_000) return null;
  if (!local) return remote;
  if (Date.parse(remote.updatedAt) <= Date.parse(local.updatedAt)) return null;
  const same = local.slug === remote.slug && local.variant === remote.variant;
  if (!same || Math.abs(remote.positionMs - local.positionMs) > 15_000) return remote;
  return null;
}

/** «Spilte på PC-en – Live-sett 1:02:14. Fortsett her?» */
export function resumeText(title: string, point: PlaybackPoint): string {
  return `Spilte på ${point.deviceLabel} – ${title} ${formatTime(point.positionMs)}. Fortsett her?`;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

export function validPoint(b: Partial<PlaybackPoint>): b is PlaybackPoint {
  return !!b.slug && SLUG.test(b.slug)
    && !!b.variant && SLUG.test(b.variant)
    && typeof b.positionMs === 'number' && Number.isFinite(b.positionMs) && b.positionMs >= 0 && b.positionMs < 24 * 60 * 60 * 1000
    && typeof b.updatedAt === 'string' && Number.isFinite(Date.parse(b.updatedAt))
    && typeof b.deviceId === 'string' && /^[0-9a-f-]{8,40}$/i.test(b.deviceId)
    && typeof b.deviceLabel === 'string' && b.deviceLabel.trim().length > 0 && b.deviceLabel.length <= 40;
}
