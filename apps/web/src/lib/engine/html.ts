import type Hls from 'hls.js';
import { assetUrl, type LoadedAsset } from '../catalog';
import { gainOf, type EngineHandlers, type PlayerEngine } from './types';

/**
 * Én <audio>-instans for hele appen. INGEN Web Audio API på mobil:
 * iOS stopper/demper Web Audio i bakgrunnen og AnalyserNode gir stillhet på HLS.
 * Safari spiller HLS native; andre nettlesere laster hls.js ved behov.
 * Volumnormalisering via audio.volume ut fra manifestets playbackGainDb (kun demping).
 * NB: iOS ignorerer audio.volume – der styres volumet bare med telefonens knapper.
 */
export class HtmlAudioEngine implements PlayerEngine {
  readonly kind = 'html' as const;
  private audio = new Audio();
  private hls: Hls | null = null;
  private loadSeq = 0;
  private ready = false;
  private wantPlay = false;
  private pendingSeekMs: number | null = null;
  private current: LoadedAsset | undefined;
  private userVolume = 1;
  private h: EngineHandlers | null = null;
  private nativeHls: boolean;
  private hlsModule: Promise<typeof import('hls.js')> | null;

  constructor() {
    this.audio.preload = 'metadata';
    this.audio.crossOrigin = 'anonymous';
    this.nativeHls = !!this.audio.canPlayType('application/vnd.apple.mpegurl');
    this.hlsModule = this.nativeHls ? null : import('hls.js');
    const a = this.audio;
    const applyPendingSeek = () => {
      if (this.pendingSeekMs != null && a.readyState > 0) {
        a.currentTime = this.pendingSeekMs / 1000;
        this.pendingSeekMs = null;
      }
    };
    a.addEventListener('loadedmetadata', applyPendingSeek);
    a.addEventListener('canplay', applyPendingSeek);
    a.addEventListener('play', () => this.h?.onPlay());
    a.addEventListener('pause', () => {
      if (!a.ended) this.h?.onPause();
    });
    a.addEventListener('timeupdate', () => {
      if (this.pendingSeekMs != null) return; // ikke overskriv posisjonen før gjenoppta-hoppet er gjort
      this.h?.onTime(this.positionMs());
    });
    a.addEventListener('ended', () => this.h?.onEnded());
    a.addEventListener('error', () => this.h?.onError?.(a.error?.message ?? 'avspillingsfeil'));
  }

  setHandlers(h: EngineHandlers) {
    this.h = h;
  }

  load(queue: LoadedAsset[], index: number, startMs: number | null) {
    const asset = queue[index];
    if (!asset) return;
    const src = assetUrl(asset, asset.manifest.files.hls)!;
    const seq = ++this.loadSeq;
    this.current = asset;
    this.ready = false;
    this.pendingSeekMs = startMs;
    this.hls?.destroy();
    this.hls = null;
    const onReady = () => {
      this.ready = true;
      if (this.wantPlay) {
        this.wantPlay = false;
        this.play();
      }
    };
    if (!this.hlsModule) {
      this.audio.src = src;
      onReady();
    } else {
      void this.hlsModule.then(({ default: HlsCtor }) => {
        if (seq !== this.loadSeq) return;
        if (HlsCtor.isSupported()) {
          this.hls = new HlsCtor({ maxBufferLength: 30, startPosition: startMs != null ? startMs / 1000 : -1 });
          this.hls.loadSource(src);
          this.hls.attachMedia(this.audio);
        } else this.audio.src = src;
        onReady();
      });
    }
    this.applyVolume();
    setMediaSession(asset);
  }

  syncQueue() {
    /* HTML-motoren kjenner bare låta som spilles; storen går videre selv. */
  }

  /** Spill når kilden er klar. hls.js lastes asynkront, så et tidlig trykk huskes. */
  play() {
    if (this.ready) void this.audio.play().catch(() => {});
    else this.wantPlay = true;
  }

  pause() {
    this.wantPlay = false;
    this.audio.pause();
  }

  seek(ms: number) {
    if (this.ready && this.audio.readyState > 0) this.audio.currentTime = ms / 1000;
    else this.pendingSeekMs = ms;
  }

  setUserVolume(v: number) {
    this.userVolume = v;
    this.applyVolume();
  }

  private applyVolume() {
    this.audio.volume = Math.max(0, Math.min(1, gainOf(this.current) * this.userVolume));
  }

  isPaused() {
    return this.audio.paused;
  }

  hasSource() {
    return !!this.audio.src;
  }

  positionMs() {
    return Math.round(this.audio.currentTime * 1000);
  }
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
