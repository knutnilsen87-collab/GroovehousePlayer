import { sectionsOf } from '@gv/shared/web';
import { assetUrl, type LoadedAsset } from '../catalog';
import { gainOf, type EngineHandlers, type PlayerEngine } from './types';

/** Én låt slik Android-tjenesten (Media3) trenger den. Alle URL-er er absolutte (Vault over Tailscale). */
export interface NativeItem {
  id: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  durationMs: number;
  /** LUFS-demping 0..1, brukes også når tjenesten går videre i bakgrunnen. */
  gain: number;
  /** Start på hver seksjon (ms) – knappen «Neste seksjon» i varselet. */
  sections: number[];
  /** Nøkkel for fortsett-posisjon (live-sett), lagres også fra native-siden. */
  resumeKey: string | null;
}

export interface NativeState {
  playing: boolean;
  index: number;
  positionMs: number;
}

/** Kontrakten mot Kotlin-pluginen «NativePlayer» (apps/android). */
export interface NativePlayerPlugin {
  setQueue(o: { items: NativeItem[]; index: number; startMs: number; headers: Record<string, string> }): Promise<void>;
  updateQueue(o: { items: NativeItem[]; index: number }): Promise<void>;
  skipTo(o: { index: number; startMs: number }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(o: { ms: number }): Promise<void>;
  setVolume(o: { volume: number }): Promise<void>;
  getState(): Promise<NativeState & { savedPositions?: Record<string, number> }>;
  addListener(event: 'state', fn: (s: NativeState) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(event: 'error', fn: (e: { message: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

export const toNativeItem = (a: LoadedAsset): NativeItem => {
  const m = a.manifest;
  return {
    id: m.id,
    url: assetUrl(a, m.files.hls)!,
    title: m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title,
    artist: m.artist ?? 'Echo Groove',
    album: 'Groovehouse Vault',
    artworkUrl: assetUrl(a, m.files.cover),
    durationMs: m.durationMs,
    gain: gainOf(a),
    sections: sectionsOf(m.markers).map((s) => s.startMs),
    resumeKey: m.kind === 'set' ? `gv:pos:${m.slug}:${m.variant ?? 'main'}` : null
  };
};

export class NativeEngine implements PlayerEngine {
  readonly kind = 'native' as const;
  private h: EngineHandlers | null = null;
  private ids: string[] = [];
  private state: NativeState = { playing: false, index: 0, positionMs: 0 };
  private stateAt = 0;
  private loaded = false;
  /** Kall til pluginen går i rekkefølge (setQueue før play osv.). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private plugin: NativePlayerPlugin,
    private headers: () => Record<string, string>,
    private now: () => number = () => Date.now()
  ) {
    void plugin.addListener('state', (s) => this.onState(s));
    void plugin.addListener('error', (e) => this.h?.onError?.(e.message));
  }

  private call(fn: () => Promise<unknown>) {
    this.chain = this.chain.then(fn, fn).catch((err: unknown) => this.h?.onError?.(err instanceof Error ? err.message : String(err)));
    return this.chain;
  }

  /** Rapport fra tjenesten (hvert 250 ms i forgrunnen, sjeldnere i bakgrunnen, og ved hver endring). */
  onState(s: NativeState) {
    const prev = this.state;
    this.state = s;
    this.stateAt = this.now();
    if (s.index !== prev.index) this.h?.onIndex(s.index);
    if (s.playing && !prev.playing) this.h?.onPlay();
    if (!s.playing && prev.playing) this.h?.onPause();
    this.h?.onTime(s.positionMs);
  }

  setHandlers(h: EngineHandlers) {
    this.h = h;
  }

  load(queue: LoadedAsset[], index: number, startMs: number | null) {
    const ids = queue.map((a) => a.manifest.id);
    const same = this.loaded && ids.length === this.ids.length && ids.every((x, i) => x === this.ids[i]);
    this.ids = ids;
    this.loaded = true;
    this.state = { ...this.state, index, positionMs: startMs ?? 0 };
    this.stateAt = this.now();
    if (same) void this.call(() => this.plugin.skipTo({ index, startMs: startMs ?? 0 }));
    else void this.call(() => this.plugin.setQueue({ items: queue.map(toNativeItem), index, startMs: startMs ?? 0, headers: this.headers() }));
  }

  syncQueue(queue: LoadedAsset[], index: number) {
    this.ids = queue.map((a) => a.manifest.id);
    this.state = { ...this.state, index };
    void this.call(() => this.plugin.updateQueue({ items: queue.map(toNativeItem), index }));
  }

  play() {
    void this.call(() => this.plugin.play());
  }

  pause() {
    void this.call(() => this.plugin.pause());
  }

  seek(ms: number) {
    this.state = { ...this.state, positionMs: ms };
    this.stateAt = this.now();
    void this.call(() => this.plugin.seekTo({ ms }));
  }

  setUserVolume(v: number) {
    void this.call(() => this.plugin.setVolume({ volume: v }));
  }

  isPaused() {
    return !this.state.playing;
  }

  hasSource() {
    return this.loaded;
  }

  /** Interpolerer mellom rapportene, så bølgeform og sub-bass-puls går jevnt. */
  positionMs() {
    return this.state.playing ? this.state.positionMs + (this.now() - this.stateAt) : this.state.positionMs;
  }
}
