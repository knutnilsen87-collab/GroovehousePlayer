import type { LoadedAsset } from '../catalog';

/**
 * Avspillingsmotoren (del 12). Spiller-storen snakker bare med dette grensesnittet:
 *  - HtmlAudioEngine: ett <audio>-element (web/desktop, som før). Storen går videre ved «ended».
 *  - NativeEngine: Android-appens Media3-tjeneste. Den eier køen og går videre selv, også med
 *    skjermen av og JavaScript stoppet, og melder fra med onIndex.
 */
export interface EngineHandlers {
  onPlay(): void;
  onPause(): void;
  onTime(ms: number): void;
  /** Låta er ferdig og motoren går IKKE videre selv (HTML). */
  onEnded(): void;
  /** Motoren har gått videre selv (native: neste i køen, eller fra varsel/låseskjerm/Bluetooth). */
  onIndex(index: number): void;
  onError?(message: string): void;
}

export interface PlayerEngine {
  readonly kind: 'html' | 'native';
  setHandlers(h: EngineHandlers): void;
  /** Gjør klar låta på plass `index` (native: hele køen). Starter ikke avspilling. */
  load(queue: LoadedAsset[], index: number, startMs: number | null): void;
  /** Køen er endret (spill neste, flytt, fjern) uten at låta som spilles byttes. */
  syncQueue(queue: LoadedAsset[], index: number): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  /** Brukerens volum 0..1. Motoren ganger med låtas LUFS-demping (playbackGainDb). */
  setUserVolume(v: number): void;
  isPaused(): boolean;
  hasSource(): boolean;
  /** Posisjon nå (native interpolerer mellom rapportene). */
  positionMs(): number;
  /**
   * Del 14: A·B-løkke i låta som spilles (null = av). Native gjør løkken i tjenesten, så den virker
   * med skjermen av. Nullstilles av motoren ved ny låt (load).
   */
  setLoop(loop: { a: number; b: number } | null): void;
  /** Del 14: hastighet 0,90–1,10 med tonehøyden bevart. Gjelder til den endres (ikke per låt). */
  setRate(rate: number): void;
  /** Del 14: gjenta. HTML: storen gjør det ved «ended». Native: tjenesten (virker i bakgrunnen). */
  setRepeat(mode: RepeatMode): void;
}

export type RepeatMode = 'off' | 'all' | 'one';

/**
 * Del 8: målnivå fra innstillingene (null = bruk det ingest regnet ut, -14 LUFS).
 * Settes ved oppstart fra /api/settings/playback, så et nytt mål virker uten ny ingest.
 */
let targetLufs: number | null = null;
export const setTargetLufs = (v: number | null) => {
  targetLufs = v !== null && Number.isFinite(v) ? v : null;
};

/** LUFS-utjevning: bare demping, aldri løft. */
export const gainOf = (a: LoadedAsset | undefined) => {
  if (!a) return 1;
  const l = a.manifest.loudness;
  const db = targetLufs !== null && Number.isFinite(l.integratedLufs) ? targetLufs - l.integratedLufs : l.playbackGainDb;
  return Math.min(1, Math.pow(10, db / 20));
};
