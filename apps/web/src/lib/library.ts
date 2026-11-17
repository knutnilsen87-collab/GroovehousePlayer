import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { parseLyrics, type ParsedLyrics } from '@gv/shared/web';
import { assetUrl, type LoadedAsset } from './catalog';
import { setListenLogger, usePlayer } from './player';
import { toastError } from './playlists';

/**
 * Del 14: favoritter, sangtekst, egne avspillinger og spektrum. Data ligger på PC-en (data/),
 * så mobil, app og desktop ser det samme. Samme tilgangsregler som spillelistene.
 */

const json = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------- Favoritter

interface FavState {
  slugs: string[];
  loaded: boolean;
  load: () => Promise<void>;
  toggle: (slug: string) => Promise<void>;
}

const FAV_CACHE_KEY = 'gv:favorites:v1';
function readFavCache(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FAV_CACHE_KEY) : null;
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
function writeFavCache(slugs: string[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(FAV_CACHE_KEY, JSON.stringify(slugs));
  } catch {
    /* privat modus */
  }
}

export const useFavorites = create<FavState>((set, get) => ({
  slugs: readFavCache(),
  loaded: false,
  load: async () => {
    try {
      const r = await fetch('/api/favorites', { cache: 'no-store' });
      if (r.ok) {
        const slugs = ((await r.json()) as { slugs: string[] }).slugs;
        writeFavCache(slugs);
        set({ slugs, loaded: true });
      }
    } catch {
      /* frakoblet – prøv igjen ved neste visning */
    }
  },
  /** Optimistisk: hjertet fylles med en gang, rulles tilbake hvis serveren sier nei. */
  toggle: async (slug) => {
    const before = get().slugs;
    const on = !before.includes(slug);
    const optimistic = on ? [slug, ...before] : before.filter((s) => s !== slug);
    set({ slugs: optimistic });
    writeFavCache(optimistic);
    try {
      const r = await fetch(`/api/favorites/${encodeURIComponent(slug)}`, { method: on ? 'PUT' : 'DELETE', headers: json, body: '{}' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      const slugs = ((await r.json()) as { slugs: string[] }).slugs;
      writeFavCache(slugs);
      set({ slugs });
    } catch (err) {
      writeFavCache(before);
      set({ slugs: before });
      toastError(err);
    }
  }
}));
export const useIsFavorite = (slug: string | undefined) => useFavorites((s) => !!slug && s.slugs.includes(slug));

// ---------------------------------------------------------------- Sangtekst

export interface LyricsData {
  format: 'lrc' | 'txt';
  text: string;
  parsed: ParsedLyrics;
  /** auto = transkribert fra lyden; vises som «Auto – sjekk teksten» til den er godkjent. */
  meta?: LyricsMeta | null;
}
export interface LyricsMeta {
  source: 'auto' | 'aligned' | 'manual' | 'instrumental';
  approved: boolean;
  at: string;
}
/** Teksten er transkribert automatisk og ikke godkjent ennå. */
export const needsCheck = (d: LyricsData | null | undefined) => d?.meta?.source === 'auto' && !d.meta.approved;
const lyricsCache = new Map<string, Promise<LyricsData | null>>();
const lyricsListeners = new Set<(slug: string) => void>();

function notifyLyrics(slug: string) {
  for (const fn of lyricsListeners) fn(slug);
}

export function fetchLyrics(slug: string, fresh = false): Promise<LyricsData | null> {
  if (fresh) lyricsCache.delete(slug);
  let p = lyricsCache.get(slug);
  if (!p) {
    p = fetch(`/api/lyrics/${encodeURIComponent(slug)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { format: 'lrc' | 'txt'; text: string; meta?: LyricsMeta | null };
        return { ...j, parsed: parseLyrics(j.text) };
      })
      .catch(() => {
        lyricsCache.delete(slug);
        return null;
      });
    lyricsCache.set(slug, p);
  }
  return p;
}

export async function saveLyrics(slug: string, format: 'lrc' | 'txt', text: string): Promise<LyricsData | null> {
  const r = await fetch(`/api/lyrics/${encodeURIComponent(slug)}`, { method: 'PUT', headers: json, body: JSON.stringify({ format, text }) });
  const j = (await r.json().catch(() => ({}))) as { lyrics?: { format: 'lrc' | 'txt'; text: string; meta?: LyricsMeta | null } | null; error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  const data = j.lyrics ? { ...j.lyrics, parsed: parseLyrics(j.lyrics.text) } : null;
  lyricsCache.set(slug, Promise.resolve(data));
  notifyLyrics(slug);
  return data;
}

/** Kjører Demucs + WhisperX på serveren og lagrer ord-synkronisert tekst. */
export async function transcribeLyrics(slug: string): Promise<{ data: LyricsData; wordCount: number; mode: 'auto' | 'aligned'; ms: number }> {
  const r = await fetch(`/api/lyrics/${encodeURIComponent(slug)}/transcribe`, {
    method: 'POST',
    headers: json,
    body: '{}'
  });
  const j = (await r.json().catch(() => ({}))) as { lyrics?: { format: 'lrc' | 'txt'; text: string; meta?: LyricsMeta | null }; wordCount?: number; mode?: 'auto' | 'aligned'; ms?: number; error?: string };
  if (!r.ok || !j.lyrics) throw new Error(j.error ?? `HTTP ${r.status}`);
  const data: LyricsData = { format: j.lyrics.format, text: j.lyrics.text, parsed: parseLyrics(j.lyrics.text), meta: j.lyrics.meta ?? null };
  lyricsCache.set(slug, Promise.resolve(data));
  notifyLyrics(slug);
  return { data, wordCount: j.wordCount ?? 0, mode: j.mode ?? 'auto', ms: j.ms ?? 0 };
}

/** Knut har sjekket en automatisk transkribert tekst. */
export async function approveLyrics(slug: string): Promise<void> {
  const r = await fetch(`/api/lyrics/${encodeURIComponent(slug)}/approve`, { method: 'POST', headers: json, body: '{}' });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
  await fetchLyrics(slug, true);
  notifyLyrics(slug);
}

export interface LyricsJob {
  slug: string;
  title: string;
  status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
  stage: 'start' | 'demucs' | 'language' | 'transcribe' | 'align' | 'write' | null;
  mode: 'auto' | 'aligned' | 'instrumental' | null;
  reason: 'ingest' | 'studio' | 'pasted' | 'batch';
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ms: number | null;
  words: number | null;
  note: string | null;
}
export interface LyricsQueueStatus {
  enabled: boolean;
  python: string | null;
  jobs: LyricsJob[];
  batch: { total: number; done: number; paused: boolean; inWindow: boolean; window: { from: number; to: number }; next: string | null } | null;
}
/** Tekstkøen (Studio): hentes hvert 2. sekund mens noe står i kø eller kjører, ellers hvert 15. */
export function useLyricsQueue(): LyricsQueueStatus | null {
  const [q, setQ] = useState<LyricsQueueStatus | null>(null);
  useEffect(() => {
    let stop = false;
    let t = 0;
    const tick = async () => {
      const r = await fetch('/api/lyrics-queue', { cache: 'no-store' }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as LyricsQueueStatus | null) : null;
      if (stop) return;
      setQ(j);
      const active = j?.jobs.some((x) => x.status === 'waiting' || x.status === 'running');
      t = window.setTimeout(tick, active ? 2000 : 15000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, []);
  return q;
}

/** undefined = laster, null = ingen tekst. */
export function useLyrics(slug: string | undefined): LyricsData | null | undefined {
  const [state, setState] = useState<{ slug?: string; data: LyricsData | null | undefined }>({ data: undefined });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!slug) return;
    const onUpdate = (updatedSlug: string) => {
      if (updatedSlug === slug) setTick((t) => t + 1);
    };
    lyricsListeners.add(onUpdate);
    return () => {
      lyricsListeners.delete(onUpdate);
    };
  }, [slug]);
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setState({ slug, data: undefined });
    void fetchLyrics(slug).then((d) => alive && setState({ slug, data: d }));
    return () => {
      alive = false;
    };
  }, [slug, tick]);
  return state.slug === slug ? state.data : undefined;
}

// ---------------------------------------------------------------- Spektrum (spectrum48.bin)

export interface Spectrum48 {
  bands: number;
  fps: number;
  frames: number;
  data: Uint8Array;
}
const specCache = new Map<string, Promise<Spectrum48 | null>>();

/** Hentes først når panelet vises. null = mangler (eldre analyse) → «Analyserer…». */
export function loadSpectrum(a: LoadedAsset): Promise<Spectrum48 | null> {
  const info = a.analysis?.spectrum48;
  if (!info) return Promise.resolve(null);
  let p = specCache.get(a.manifest.id);
  if (!p) {
    p = fetch(assetUrl(a, info.file)!)
      .then(async (r) => (r.ok ? { bands: info.bands, fps: info.fps, frames: info.frames, data: new Uint8Array(await r.arrayBuffer()) } : null))
      .catch(() => {
        specCache.delete(a.manifest.id);
        return null;
      });
    specCache.set(a.manifest.id, p);
  }
  return p;
}

export function useSpectrum(a: LoadedAsset | undefined, enabled = true): Spectrum48 | null | undefined {
  const [s, setS] = useState<{ id?: string; v: Spectrum48 | null | undefined }>({ v: undefined });
  useEffect(() => {
    if (!a || !enabled) return;
    let alive = true;
    void loadSpectrum(a).then((v) => alive && setS({ id: a.manifest.id, v }));
    return () => {
      alive = false;
    };
  }, [a, enabled]);
  return a && s.id === a.manifest.id ? s.v : undefined;
}

// ---------------------------------------------------------------- Egne avspillinger (Analyse, Hjem)

export interface ListenLog {
  bySlug: Record<string, { plays: number; ms: number; lastAt: string }>;
  recent: Array<{ slug: string; at: string }>;
  byDay: Record<string, number>;
}
export async function fetchListens(): Promise<ListenLog | null> {
  try {
    const r = await fetch('/api/listens', { cache: 'no-store' });
    return r.ok ? ((await r.json()) as ListenLog) : null;
  } catch {
    return null;
  }
}

/**
 * Kobler spillerens lyttehendelser til PC-ens logg: «play» teller én avspilling (høyst én per låt
 * per 30 s), tid lyttet summeres fra hjerteslag/pause/slutt. Sendes samlet hvert 15. sekund.
 */
export function startListenReporting() {
  let pending: Array<{ slug: string; play?: boolean; ms?: number }> = [];
  let lastPlay: { slug: string; at: number } | null = null;
  let since: { assetId: string; slug: string; pos: number; at: number } | null = null;
  const slugOf = (assetId: string) => usePlayer.getState().queue.find((a) => a.manifest.id === assetId)?.manifest.slug ?? null;
  const flushSpan = (assetId: string) => {
    if (!since || since.assetId !== assetId) return;
    const ms = Date.now() - since.at;
    if (ms > 500) pending.push({ slug: since.slug, ms: Math.min(ms, 300_000) });
    since = null;
  };
  const send = () => {
    if (!pending.length) return;
    const events = pending;
    pending = [];
    void fetch('/api/listens', { method: 'POST', headers: json, body: JSON.stringify({ events }), keepalive: true }).catch(() => {
      pending = [...events, ...pending].slice(-200);
    });
  };
  setListenLogger((e) => {
    const slug = slugOf(e.assetId);
    if (!slug) return;
    if (e.event === 'play') {
      if (!lastPlay || lastPlay.slug !== slug || Date.now() - lastPlay.at > 30_000) pending.push({ slug, play: true });
      lastPlay = { slug, at: Date.now() };
      since = { assetId: e.assetId, slug, pos: e.positionMs, at: Date.now() };
    } else if (e.event === 'heartbeat') {
      flushSpan(e.assetId);
      since = { assetId: e.assetId, slug, pos: e.positionMs, at: Date.now() };
    } else if (e.event === 'pause' || e.event === 'ended') flushSpan(e.assetId);
  });
  const t = window.setInterval(send, 15_000);
  window.addEventListener('pagehide', send);
  return () => {
    window.clearInterval(t);
    window.removeEventListener('pagehide', send);
  };
}
