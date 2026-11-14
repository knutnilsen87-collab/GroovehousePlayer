import type Hls from 'hls.js';
import { create } from 'zustand';
import { enqueue as qEnqueue, insertNext as qInsertNext, mapPositionBetweenVariants, moveAt as qMove, nextSectionStart, prevSectionStart, removeAt as qRemove, toStored, type ListenEventType, type StoredQueue } from '@gv/shared/web';
import { assetUrl, type LoadedAsset } from './catalog';

/**
 * Én <audio>-instans for hele appen. INGEN Web Audio API på mobil:
 * iOS stopper/demper Web Audio i bakgrunnen og AnalyserNode gir stillhet på HLS.
 * Safari spiller HLS native; andre nettlesere laster hls.js ved behov.
 * Volumnormalisering via audio.volume ut fra manifestets playbackGainDb (kun demping).
 * NB: iOS ignorerer audio.volume – der styres volumet bare med telefonens knapper.
 */
const isBrowser = typeof window !== 'undefined';
const audio = isBrowser ? new Audio() : (null as unknown as HTMLAudioElement);
if (isBrowser) {
  audio.preload = 'metadata';
  audio.crossOrigin = 'anonymous';
}
export const getAudio = () => audio;

let hls: Hls | null = null;
let loadSeq = 0;
let ready = false;
let wantPlay = false;
let pendingSeekMs: number | null = null;
const nativeHls = isBrowser && !!audio.canPlayType('application/vnd.apple.mpegurl');
const hlsModule = !nativeHls && isBrowser ? import('hls.js') : null;

export type ListenLogger = (e: { event: ListenEventType; assetId: string; positionMs: number; toMs?: number }) => void;
/** Fase 1: logger til konsollen. Fase 2: POST til Edge Function `log-event`. */
export let logListen: ListenLogger = (e) => console.debug('[listen]', e);
export function setListenLogger(fn: ListenLogger) {
  logListen = fn;
}

// ---------------------------------------------------------------- Fortsett-posisjon
// Fase 1: localStorage per enhet. Fase 2: tabellen playback_positions i Supabase, så den følger deg mellom PC og mobil.
const posKey = (a: LoadedAsset) => `gv:pos:${a.manifest.slug}:${a.manifest.variant ?? 'main'}`;
export function savedPosition(a: LoadedAsset): number | null {
  try {
    const v = Number(localStorage.getItem(posKey(a)));
    return Number.isFinite(v) && v > 10_000 && v < a.manifest.durationMs - 15_000 ? v : null;
  } catch {
    return null;
  }
}
function savePosition(a: LoadedAsset, ms: number) {
  try {
    if (ms > a.manifest.durationMs - 15_000) localStorage.removeItem(posKey(a));
    else localStorage.setItem(posKey(a), String(Math.round(ms)));
  } catch {
    /* privat modus o.l. */
  }
}

/** Spill når kilden er klar. hls.js lastes asynkront, så et tidlig trykk huskes. */
function requestPlay() {
  if (ready) void audio.play().catch(() => {});
  else wantPlay = true;
}

function load(a: LoadedAsset, startMs: number | null) {
  const src = assetUrl(a, a.manifest.files.hls)!;
  const seq = ++loadSeq;
  ready = false;
  pendingSeekMs = startMs;
  hls?.destroy();
  hls = null;
  const onReady = () => {
    ready = true;
    if (wantPlay) {
      wantPlay = false;
      requestPlay();
    }
  };
  if (nativeHls || !hlsModule) {
    audio.src = src;
    onReady();
  } else {
    void hlsModule.then(({ default: HlsCtor }) => {
      if (seq !== loadSeq) return;
      if (HlsCtor.isSupported()) {
        hls = new HlsCtor({ maxBufferLength: 30, startPosition: startMs != null ? startMs / 1000 : -1 });
        hls.loadSource(src);
        hls.attachMedia(audio);
      } else audio.src = src;
      onReady();
    });
  }
  applyVolume(a);
  setMediaSession(a);
}

function applyVolume(a: LoadedAsset | undefined) {
  const norm = a ? Math.min(1, Math.pow(10, a.manifest.loudness.playbackGainDb / 20)) : 1;
  audio.volume = Math.max(0, Math.min(1, norm * usePlayer.getState().volume));
}

function setMediaSession(a: LoadedAsset) {
  if (!('mediaSession' in navigator)) return;
  const cover = assetUrl(a, a.manifest.files.cover);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: a.manifest.variantLabel ? `${a.manifest.title} (${a.manifest.variantLabel})` : a.manifest.title,
    artist: a.manifest.artist ?? 'Groovehouse Records',
    album: 'Groovehouse Vault',
    artwork: cover ? [{ src: new URL(cover, location.href).href, sizes: '1200x1200', type: 'image/jpeg' }] : []
  });
}

interface PlayerState {
  queue: LoadedAsset[];
  index: number;
  playing: boolean;
  positionMs: number;
  /** Har avspilling startet minst én gang? Styrer gull → coverfarger. */
  started: boolean;
  /** Brukerens volum 0..1 (ganges med normaliseringen). */
  volume: number;
  setQueue: (q: LoadedAsset[], startIndex?: number) => void;
  /** Spill et asset fra en liste. Live-sett fortsetter der du slapp. */
  playFrom: (list: LoadedAsset[], i: number, atMs?: number) => void;
  playIndex: (i: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (ms: number) => void;
  nextSection: () => void;
  prevSection: () => void;
  /** Bytt variant av låta som spilles, og land i samme del. */
  switchVariant: (to: LoadedAsset) => void;
  setVolume: (v: number) => void;
  /** Øker når køen byttes ut (playFrom/setQueue/restore), ikke når den endres (spill neste o.l.). */
  queueId: number;
  /** «Spill neste»: rett etter låta som spilles. */
  insertNext: (items: LoadedAsset[]) => void;
  /** «Legg til i køen»: bakerst. */
  enqueue: (items: LoadedAsset[]) => void;
  removeFromQueue: (i: number) => void;
  moveInQueue: (from: number, to: number) => void;
  /** Etter omstart: legg tilbake køen pauset på lagret posisjon. */
  restoreQueue: (queue: LoadedAsset[], index: number, positionMs: number) => void;
}

const sameQueue = (a: LoadedAsset[], b: LoadedAsset[]) => a.length === b.length && a.every((x, i) => x.manifest.id === b[i]?.manifest.id);

export const usePlayer = create<PlayerState>((set, get) => ({
  queue: [],
  index: 0,
  playing: false,
  positionMs: 0,
  started: false,
  volume: 1,
  queueId: 0,
  setQueue: (queue, startIndex = 0) => {
    if (sameQueue(queue, get().queue)) return;
    set({ queue, index: startIndex, positionMs: 0, playing: false, queueId: get().queueId + 1 });
    if (queue[startIndex]) load(queue[startIndex]!, null);
  },
  playFrom: (list, i, atMs) => {
    const a = list[i];
    if (!a) return;
    const cur = get().queue[get().index];
    const resume = atMs ?? (a.manifest.kind === 'set' ? savedPosition(a) : null);
    if (sameQueue(list, get().queue) && cur?.manifest.id === a.manifest.id && audio.src) {
      if (atMs != null) get().seek(atMs);
      requestPlay();
      return;
    }
    set({ queue: list, index: i, positionMs: resume ?? 0, started: true, queueId: get().queueId + 1 });
    load(a, resume);
    requestPlay();
  },
  playIndex: (i) => {
    const a = get().queue[i];
    if (!a) return;
    if (i !== get().index || !audio.src) {
      const resume = a.manifest.kind === 'set' ? savedPosition(a) : null;
      load(a, resume);
      set({ index: i, positionMs: resume ?? 0 });
    }
    requestPlay();
  },
  toggle: () => {
    if (audio.paused) requestPlay();
    else {
      wantPlay = false;
      audio.pause();
    }
  },
  next: () => {
    const { index, queue } = get();
    if (queue.length) get().playIndex((index + 1) % queue.length);
  },
  prev: () => {
    const { index, queue } = get();
    if (audio.currentTime > 3 || queue.length < 2) {
      get().seek(0);
      return;
    }
    get().playIndex((index - 1 + queue.length) % queue.length);
  },
  seek: (ms) => {
    const cur = get().queue[get().index];
    if (cur) logListen({ event: 'seek', assetId: cur.manifest.id, positionMs: Math.round(audio.currentTime * 1000), toMs: Math.round(ms) });
    if (ready && audio.readyState > 0) audio.currentTime = ms / 1000;
    else pendingSeekMs = ms;
    set({ positionMs: ms, started: true });
  },
  nextSection: () => {
    const cur = get().queue[get().index];
    if (!cur) return;
    const t = nextSectionStart(cur.manifest.markers, get().positionMs);
    if (t != null) get().seek(t);
  },
  prevSection: () => {
    const cur = get().queue[get().index];
    if (cur) get().seek(prevSectionStart(cur.manifest.markers, get().positionMs));
  },
  switchVariant: (to) => {
    const { queue, index, positionMs, playing } = get();
    const from = queue[index];
    if (!from || from.manifest.id === to.manifest.id) return;
    const at = mapPositionBetweenVariants(from.manifest, to.manifest, positionMs);
    const q = [...queue];
    q[index] = to;
    set({ queue: q, positionMs: at });
    load(to, at);
    if (playing) requestPlay();
  },
  setVolume: (v) => {
    set({ volume: v });
    applyVolume(get().queue[get().index]);
  },
  insertNext: (items) => {
    if (!items.length) return;
    const wasEmpty = !get().queue.length;
    set(qInsertNext(get(), items));
    if (wasEmpty) load(get().queue[0]!, null);
  },
  enqueue: (items) => {
    if (!items.length) return;
    const wasEmpty = !get().queue.length;
    set(qEnqueue(get(), items));
    if (wasEmpty) load(get().queue[0]!, null);
  },
  removeFromQueue: (i) => set(qRemove(get(), i)),
  moveInQueue: (from, to) => set(qMove(get(), from, to)),
  restoreQueue: (queue, index, positionMs) => {
    const a = queue[index];
    if (!a || get().queue.length) return; // spiller allerede noe – ikke overstyr
    set({ queue, index, positionMs, playing: false, queueId: get().queueId + 1 });
    load(a, positionMs > 0 ? positionMs : null);
  }
}));

// ---------------------------------------------------------------- Køen overlever omstart (localStorage)
const QUEUE_KEY = 'gv:queue';
export function storedQueue(): StoredQueue | null {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? 'null') as StoredQueue | null;
  } catch {
    return null;
  }
}
function saveQueue() {
  const { queue, index, positionMs } = usePlayer.getState();
  try {
    if (queue.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(toStored(queue, index, positionMs)));
  } catch {
    /* privat modus */
  }
}

// ---------------------------------------------------------------- <audio>-hendelser → butikk og logg
if (isBrowser) {
  // Lagre ved endring av køen/plassen med en gang, posisjonen høyst hvert 5. sekund.
  let lastQueueSave = 0;
  usePlayer.subscribe((s, prev) => {
    if (s.queue !== prev.queue || s.index !== prev.index) saveQueue();
    else if (s.positionMs !== prev.positionMs && Date.now() - lastQueueSave > 5000) {
      lastQueueSave = Date.now();
      saveQueue();
    }
  });
  window.addEventListener('pagehide', saveQueue);
  audio.addEventListener('pause', saveQueue);
  const current = () => usePlayer.getState().queue[usePlayer.getState().index];
  const pos = () => Math.round(audio.currentTime * 1000);
  let lastBeat = 0;
  let lastSave = 0;

  const applyPendingSeek = () => {
    if (pendingSeekMs != null && audio.readyState > 0) {
      audio.currentTime = pendingSeekMs / 1000;
      pendingSeekMs = null;
    }
  };
  audio.addEventListener('loadedmetadata', applyPendingSeek);
  audio.addEventListener('canplay', applyPendingSeek);

  audio.addEventListener('play', () => {
    usePlayer.setState({ playing: true, started: true });
    const a = current();
    if (a) logListen({ event: 'play', assetId: a.manifest.id, positionMs: pos() });
  });
  audio.addEventListener('pause', () => {
    usePlayer.setState({ playing: false });
    const a = current();
    if (a && !audio.ended) {
      logListen({ event: 'pause', assetId: a.manifest.id, positionMs: pos() });
      savePosition(a, pos());
    }
  });
  audio.addEventListener('timeupdate', () => {
    if (pendingSeekMs != null) return; // ikke overskriv posisjonen før gjenoppta-hoppet er gjort
    usePlayer.setState({ positionMs: pos() });
    const now = Date.now();
    const a = current();
    if (!a || audio.paused) return;
    if (now - lastBeat > 15000) {
      lastBeat = now;
      logListen({ event: 'heartbeat', assetId: a.manifest.id, positionMs: pos() });
    }
    if (now - lastSave > 5000) {
      lastSave = now;
      savePosition(a, pos());
    }
  });
  audio.addEventListener('ended', () => {
    const a = current();
    if (a) {
      logListen({ event: 'ended', assetId: a.manifest.id, positionMs: a.manifest.durationMs });
      savePosition(a, a.manifest.durationMs);
    }
    const { index, queue } = usePlayer.getState();
    if (index < queue.length - 1) usePlayer.getState().playIndex(index + 1);
    else usePlayer.setState({ playing: false });
  });
  window.addEventListener('pagehide', () => {
    const a = current();
    if (a && !audio.paused) savePosition(a, pos());
  });

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => requestPlay());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => usePlayer.getState().next());
    navigator.mediaSession.setActionHandler('previoustrack', () => usePlayer.getState().prev());
    navigator.mediaSession.setActionHandler('seekto', (d) => d.seekTime != null && usePlayer.getState().seek(d.seekTime * 1000));
    // Låseskjermens ±-knapper hopper mellom deler (Drop, Break …) i stedet for 10 s
    navigator.mediaSession.setActionHandler('seekforward', () => usePlayer.getState().nextSection());
    navigator.mediaSession.setActionHandler('seekbackward', () => usePlayer.getState().prevSection());
  }
}
