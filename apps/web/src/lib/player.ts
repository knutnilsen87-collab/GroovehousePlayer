import { create } from 'zustand';
import { clampRate, makeLoop, type Loop } from '@gv/shared/web';
import { enqueue as qEnqueue, insertNext as qInsertNext, mapPositionBetweenVariants, moveAt as qMove, nextSectionStart, prevSectionStart, removeAt as qRemove, toStored, type ListenEventType, type StoredQueue } from '@gv/shared/web';
import type { LoadedAsset } from './catalog';
import type { PlayerEngine, RepeatMode } from './engine/types';

/**
 * Spiller-storen. Selve avspillingen gjøres av en motor (del 12): <audio> på web/desktop,
 * Media3-tjenesten i Android-appen. Storen vet ikke hvilken, se engine/types.ts.
 */
const isBrowser = typeof window !== 'undefined';

let engine: PlayerEngine | null = null;
let engineFactory: (() => PlayerEngine) | null = null;
/** Settes av platform.ts ved oppstart (native i appen); ellers HTML-motoren. */
export function setEngineFactory(f: () => PlayerEngine) {
  engineFactory = f;
}
/** For tester: bytt motor direkte. */
export function setEngine(e: PlayerEngine) {
  engine = e;
  wire(e);
}
function getEngine(): PlayerEngine {
  if (!engine) {
    if (!engineFactory) throw new Error('Ingen avspillingsmotor er satt opp');
    engine = engineFactory();
    wire(engine);
  }
  return engine;
}
/** Posisjon nå (sub-bass-pulsen leser denne i hver frame). */
export const getPositionMs = () => (engine ? engine.positionMs() : 0);
export const engineKind = () => engine?.kind ?? null;

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
/** Posisjoner native-tjenesten lagret mens JavaScript sov (appen i bakgrunnen). */
export function mergeSavedPositions(positions: Record<string, number> | undefined) {
  if (!positions) return;
  try {
    for (const [k, v] of Object.entries(positions)) if (k.startsWith('gv:pos:') && Number.isFinite(v)) localStorage.setItem(k, String(Math.round(v)));
  } catch {
    /* privat modus */
  }
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
  /** Del 14: A·B-løkke i låta som spilles (nullstilles ved ny låt). */
  loop: Loop | null;
  /** Del 14: hastighet 0,90–1,10 (tonehøyden bevart). Lagres ikke per låt. */
  rate: number;
  /** Sett løkke fra to punkter (ms). Festes til takter med mindre `snap` er false (Shift). null = av. */
  setLoop: (x: number | null, y?: number, snap?: boolean) => void;
  setRate: (r: number) => void;
  /** Del 14: gjenta av → hele køen → én låt. */
  repeat: RepeatMode;
  cycleRepeat: () => void;
  /** Del 14: bland resten av køen (det som spilles nå blir stående). */
  shuffleUpcoming: () => void;
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
  loop: null,
  rate: 1,
  repeat: 'off',
  queueId: 0,
  setQueue: (queue, startIndex = 0) => {
    if (sameQueue(queue, get().queue)) return;
    set({ queue, index: startIndex, positionMs: 0, playing: false, loop: null, queueId: get().queueId + 1 });
    if (queue[startIndex]) getEngine().load(queue, startIndex, null);
  },
  playFrom: (list, i, atMs) => {
    const a = list[i];
    if (!a) return;
    const e = getEngine();
    const cur = get().queue[get().index];
    const resume = atMs ?? (a.manifest.kind === 'set' ? savedPosition(a) : null);
    if (sameQueue(list, get().queue) && cur?.manifest.id === a.manifest.id && e.hasSource()) {
      if (atMs != null) get().seek(atMs);
      e.play();
      return;
    }
    set({ queue: list, index: i, positionMs: resume ?? 0, started: true, loop: null, queueId: get().queueId + 1 });
    e.load(list, i, resume);
    e.play();
  },
  playIndex: (i) => {
    const a = get().queue[i];
    if (!a) return;
    const e = getEngine();
    if (i !== get().index || !e.hasSource()) {
      const resume = a.manifest.kind === 'set' ? savedPosition(a) : null;
      e.load(get().queue, i, resume);
      set({ index: i, positionMs: resume ?? 0, loop: null });
    }
    e.play();
  },
  toggle: () => {
    const e = getEngine();
    if (e.isPaused()) e.play();
    else e.pause();
  },
  next: () => {
    const { index, queue } = get();
    if (queue.length) get().playIndex((index + 1) % queue.length);
  },
  prev: () => {
    const { index, queue } = get();
    if (getEngine().positionMs() > 3000 || queue.length < 2) {
      get().seek(0);
      return;
    }
    get().playIndex((index - 1 + queue.length) % queue.length);
  },
  seek: (ms) => {
    const cur = get().queue[get().index];
    if (cur) logListen({ event: 'seek', assetId: cur.manifest.id, positionMs: getEngine().positionMs(), toMs: Math.round(ms) });
    getEngine().seek(ms);
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
    set({ queue: q, positionMs: at, loop: null });
    const e = getEngine();
    e.load(q, index, at);
    if (playing) e.play();
  },
  setVolume: (v) => {
    set({ volume: v });
    getEngine().setUserVolume(v);
  },
  setLoop: (x, y, snap = true) => {
    const cur = get().queue[get().index];
    const loop = cur && x != null && y != null ? makeLoop(x, y, cur.manifest.durationMs, cur.manifest.bpm, snap) : null;
    set({ loop });
    const e = getEngine();
    e.setLoop(loop);
    // Står spillehodet utenfor løkka, hopp til A
    if (loop && (get().positionMs < loop.a || get().positionMs > loop.b)) get().seek(loop.a);
  },
  cycleRepeat: () => {
    const repeat: RepeatMode = get().repeat === 'off' ? 'all' : get().repeat === 'all' ? 'one' : 'off';
    set({ repeat });
    getEngine().setRepeat(repeat);
  },
  shuffleUpcoming: () => {
    const { queue, index } = get();
    const rest = queue.slice(index + 1);
    if (rest.length < 2) return;
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j]!, rest[i]!];
    }
    set({ queue: [...queue.slice(0, index + 1), ...rest] });
    getEngine().syncQueue(get().queue, index);
  },
  setRate: (r) => {
    const rate = clampRate(r);
    set({ rate });
    getEngine().setRate(rate);
  },
  insertNext: (items) => {
    if (!items.length) return;
    const wasEmpty = !get().queue.length;
    set(qInsertNext(get(), items));
    if (wasEmpty) getEngine().load(get().queue, 0, null);
    else getEngine().syncQueue(get().queue, get().index);
  },
  enqueue: (items) => {
    if (!items.length) return;
    const wasEmpty = !get().queue.length;
    set(qEnqueue(get(), items));
    if (wasEmpty) getEngine().load(get().queue, 0, null);
    else getEngine().syncQueue(get().queue, get().index);
  },
  removeFromQueue: (i) => {
    set(qRemove(get(), i));
    getEngine().syncQueue(get().queue, get().index);
  },
  moveInQueue: (from, to) => {
    set(qMove(get(), from, to));
    getEngine().syncQueue(get().queue, get().index);
  },
  restoreQueue: (queue, index, positionMs) => {
    const a = queue[index];
    if (!a || get().queue.length) return; // spiller allerede noe – ikke overstyr
    set({ queue, index, positionMs, playing: false, loop: null, queueId: get().queueId + 1 });
    getEngine().load(queue, index, positionMs > 0 ? positionMs : null);
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

// ---------------------------------------------------------------- Motorhendelser → store og logg
let lastBeat = 0;
let lastSave = 0;
const current = () => usePlayer.getState().queue[usePlayer.getState().index];

function wire(e: PlayerEngine) {
  e.setUserVolume(usePlayer.getState().volume);
  if (usePlayer.getState().rate !== 1) e.setRate(usePlayer.getState().rate);
  e.setHandlers({
    onPlay: () => {
      usePlayer.setState({ playing: true, started: true });
      const a = current();
      if (a) logListen({ event: 'play', assetId: a.manifest.id, positionMs: e.positionMs() });
    },
    onPause: () => {
      usePlayer.setState({ playing: false });
      const a = current();
      if (a) {
        logListen({ event: 'pause', assetId: a.manifest.id, positionMs: e.positionMs() });
        savePosition(a, e.positionMs());
      }
      saveQueue();
    },
    onTime: (ms) => {
      usePlayer.setState({ positionMs: ms });
      const now = Date.now();
      const a = current();
      if (!a || e.isPaused()) return;
      if (now - lastBeat > 15000) {
        lastBeat = now;
        logListen({ event: 'heartbeat', assetId: a.manifest.id, positionMs: ms });
      }
      if (now - lastSave > 5000) {
        lastSave = now;
        savePosition(a, ms);
      }
    },
    onEnded: () => {
      const a = current();
      if (a) {
        logListen({ event: 'ended', assetId: a.manifest.id, positionMs: a.manifest.durationMs });
        savePosition(a, a.manifest.durationMs);
      }
      const { index, queue, repeat } = usePlayer.getState();
      if (repeat === 'one') {
        usePlayer.getState().seek(0);
        e.play();
      } else if (index < queue.length - 1) usePlayer.getState().playIndex(index + 1);
      else if (repeat === 'all' && queue.length) usePlayer.getState().playIndex(0);
      else usePlayer.setState({ playing: false });
    },
    onIndex: (i) => {
      // Motoren har gått videre selv (native): bare oppdater storen, ikke last på nytt.
      const prev = current();
      if (prev) logListen({ event: 'ended', assetId: prev.manifest.id, positionMs: prev.manifest.durationMs });
      if (i >= 0 && i < usePlayer.getState().queue.length) usePlayer.setState({ index: i, positionMs: 0, loop: null });
    },
    onError: (msg) => console.warn('[spiller]', msg)
  });
}

if (isBrowser) {
  // Lagre køen ved endring av køen/plassen med en gang, posisjonen høyst hvert 5. sekund.
  let lastQueueSave = 0;
  usePlayer.subscribe((s, prev) => {
    if (s.queue !== prev.queue || s.index !== prev.index) saveQueue();
    else if (s.positionMs !== prev.positionMs && Date.now() - lastQueueSave > 5000) {
      lastQueueSave = Date.now();
      saveQueue();
    }
  });
  window.addEventListener('pagehide', () => {
    saveQueue();
    const a = current();
    if (a && engine && !engine.isPaused()) savePosition(a, engine.positionMs());
  });

  // Web: låseskjermkontroller via Media Session. I appen gjør Media3-tjenesten dette selv.
  if ('mediaSession' in navigator) {
    const p = () => usePlayer.getState();
    navigator.mediaSession.setActionHandler('play', () => getEngine().play());
    navigator.mediaSession.setActionHandler('pause', () => getEngine().pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => p().next());
    navigator.mediaSession.setActionHandler('previoustrack', () => p().prev());
    navigator.mediaSession.setActionHandler('seekto', (d) => d.seekTime != null && p().seek(d.seekTime * 1000));
    // Låseskjermens ±-knapper hopper mellom deler (Drop, Break …) i stedet for 10 s
    navigator.mediaSession.setActionHandler('seekforward', () => p().nextSection());
    navigator.mediaSession.setActionHandler('seekbackward', () => p().prevSection());
  }
}
