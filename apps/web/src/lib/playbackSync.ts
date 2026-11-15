import { useEffect, useState } from 'react';
import { resumeOffer, type PlaybackClaim, type PlaybackPoint } from '@gv/shared/web';
import type { LoadedAsset } from './catalog';
import { setPositionHook, usePlayer } from './player';

/**
 * Del 5: posisjonen følger med til mobilen via Vault-serveren (samme vei som katalogen).
 * Lagres høyst hvert 10. sekund, og med en gang ved pause eller lukking.
 * «Fortsett her» pauser den andre enheten – ikke et sømløst bytte på taktslaget.
 */
const DEVICE_KEY = 'gv:device';

export function thisDevice(): { id: string; label: string } {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id || !/^[0-9a-f-]{8,40}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  const label = /Android|iPhone|Mobile/i.test(navigator.userAgent) ? 'Mobilen' : 'PC-en';
  return { id, label };
}

function variantOf(a: LoadedAsset) {
  return a.manifest.variant ?? 'main';
}

let offer: PlaybackPoint | null = null;
let dismissedKey = '';
const listeners = new Set<() => void>();
function setOffer(next: PlaybackPoint | null) {
  offer = next;
  for (const fn of listeners) fn();
}
export function useResumeOffer(): PlaybackPoint | null {
  const [v, setV] = useState(offer);
  useEffect(() => {
    const fn = () => setV(offer);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return v;
}

let lastPush = 0;
let lastClaimAt = '';

async function push(a: LoadedAsset, ms: number, claim = false) {
  const device = thisDevice();
  const point: PlaybackPoint & { claim?: boolean } = {
    slug: a.manifest.slug,
    variant: variantOf(a),
    positionMs: Math.round(ms),
    updatedAt: new Date().toISOString(),
    deviceId: device.id,
    deviceLabel: device.label,
    claim
  };
  await fetch('/api/playback', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(point) });
}

async function pull() {
  const r = await fetch('/api/playback', { cache: 'no-store' });
  if (!r.ok) return;
  const data = (await r.json()) as { points?: PlaybackPoint[]; claim?: PlaybackClaim | null };
  const device = thisDevice();
  const cur = usePlayer.getState().queue[usePlayer.getState().index];
  const claim = data.claim;
  if (claim && claim.deviceId !== device.id && claim.at !== lastClaimAt && Date.now() - Date.parse(claim.at) < 20_000) {
    lastClaimAt = claim.at;
    if (cur && cur.manifest.slug === claim.slug && variantOf(cur) === claim.variant && usePlayer.getState().playing) usePlayer.getState().toggle();
  }
  const latest = [...(data.points ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
  if (!latest) return;
  const local = cur && cur.manifest.slug === latest.slug ? { slug: cur.manifest.slug, variant: variantOf(cur), positionMs: usePlayer.getState().positionMs, updatedAt: new Date(0).toISOString(), deviceId: device.id, deviceLabel: device.label } : null;
  const next = resumeOffer(local, latest, device.id);
  if (next && `${next.slug}::${next.updatedAt}` !== dismissedKey) setOffer(next);
}

export function startPlaybackSync(): () => void {
  const device = thisDevice();
  setPositionHook((a, ms, force) => {
    const now = Date.now();
    if (!force && now - lastPush < 10_000) return;
    lastPush = now;
    void push(a, ms).catch(() => undefined);
  });
  const timer = window.setInterval(() => void pull().catch(() => undefined), 2000);
  void pull().catch(() => undefined);
  const onHide = () => {
    const a = usePlayer.getState().queue[usePlayer.getState().index];
    if (a) void push(a, usePlayer.getState().positionMs).catch(() => undefined);
  };
  window.addEventListener('pagehide', onHide);
  void device;
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('pagehide', onHide);
    setPositionHook(null);
  };
}

export async function claimResume(point: PlaybackPoint) {
  dismissedKey = `${point.slug}::${point.updatedAt}`;
  setOffer(null);
  const device = thisDevice();
  await fetch('/api/playback', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...point, deviceId: device.id, deviceLabel: device.label, updatedAt: new Date().toISOString(), claim: true })
  });
}

export function dismissResume() {
  if (offer) dismissedKey = `${offer.slug}::${offer.updatedAt}`;
  setOffer(null);
}
