import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedAsset } from '../src/lib/catalog';
import { NativeEngine, toNativeItem, type NativePlayerPlugin, type NativeState } from '../src/lib/engine/native';
import type { EngineHandlers, PlayerEngine } from '../src/lib/engine/types';

/** Minimal asset for testene (base er absolutt, som i appen). */
const asset = (slug: string, extra: Partial<{ kind: string; gainDb: number; variant: string | null }> = {}): LoadedAsset =>
  ({
    base: `https://vault.example/media/${slug}/main/v1/`,
    analysis: null,
    manifest: {
      id: `${slug}-v1`,
      slug,
      variant: extra.variant ?? null,
      variantLabel: extra.variant ? 'Extended' : null,
      version: 1,
      title: slug,
      artist: 'Echo Groove',
      kind: extra.kind ?? 'track',
      durationMs: 200_000,
      loudness: { playbackGainDb: extra.gainDb ?? -3, integratedLufs: -11 },
      markers: [
        { kind: 'chapter', label: 'Intro', startMs: 0, confirmed: false },
        { kind: 'chapter', label: 'Drop 1', startMs: 60_000, confirmed: false }
      ],
      files: { hls: 'hls/index.m3u8', cover: 'cover.jpg', coverThumb: 'cover_300.jpg', analysis: 'analysis.json', preview: 'preview.m4a' },
      createdAt: '2026-11-01T00:00:00Z'
    }
  }) as unknown as LoadedAsset;

// ---------------------------------------------------------------- NativeEngine mot en falsk plugin

function fakePlugin() {
  const calls: Array<[string, unknown]> = [];
  let stateListener: ((s: NativeState) => void) | null = null;
  const p: NativePlayerPlugin = {
    setQueue: async (o) => void calls.push(['setQueue', o]),
    updateQueue: async (o) => void calls.push(['updateQueue', o]),
    skipTo: async (o) => void calls.push(['skipTo', o]),
    play: async () => void calls.push(['play', null]),
    pause: async () => void calls.push(['pause', null]),
    seekTo: async (o) => void calls.push(['seekTo', o]),
    setVolume: async (o) => void calls.push(['setVolume', o]),
    getState: async () => ({ playing: false, index: 0, positionMs: 0 }),
    addListener: (async (event: string, fn: (s: NativeState) => void) => {
      if (event === 'state') stateListener = fn;
      return { remove: async () => {} };
    }) as NativePlayerPlugin['addListener']
  };
  return { p, calls, emit: (s: NativeState) => stateListener?.(s) };
}

const handlers = () => {
  const h: EngineHandlers & { log: string[] } = {
    log: [],
    onPlay: () => h.log.push('play'),
    onPause: () => h.log.push('pause'),
    onTime: (ms) => h.log.push(`time:${ms}`),
    onEnded: () => h.log.push('ended'),
    onIndex: (i) => h.log.push(`index:${i}`)
  };
  return h;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('NativeEngine (Android/Media3)', () => {
  let now = 1_000;
  beforeEach(() => {
    now = 1_000;
  });

  it('sender hele køen med absolutte URL-er, LUFS-demping, seksjoner og enhetstoken', async () => {
    const f = fakePlugin();
    const e = new NativeEngine(f.p, () => ({ Authorization: 'Bearer abc' }), () => now);
    e.load([asset('a'), asset('b', { kind: 'set' })], 1, 30_000);
    e.play();
    await flush();
    const [name, o] = f.calls[0] as [string, { items: ReturnType<typeof toNativeItem>[]; index: number; startMs: number; headers: Record<string, string> }];
    expect(name).toBe('setQueue');
    expect(o.index).toBe(1);
    expect(o.startMs).toBe(30_000);
    expect(o.headers).toEqual({ Authorization: 'Bearer abc' });
    expect(o.items[0]!.url).toBe('https://vault.example/media/a/main/v1/hls/index.m3u8');
    expect(o.items[0]!.artworkUrl).toBe('https://vault.example/media/a/main/v1/cover.jpg');
    expect(o.items[0]!.gain).toBeCloseTo(Math.pow(10, -3 / 20));
    expect(o.items[0]!.sections).toEqual([0, 60_000]);
    expect(o.items[0]!.resumeKey).toBeNull();
    expect(o.items[1]!.resumeKey).toBe('gv:pos:b:main');
    expect(f.calls[1]![0]).toBe('play');
  });

  it('samme kø → skipTo (ikke ny kø); endret kø uten låtbytte → updateQueue', async () => {
    const f = fakePlugin();
    const e = new NativeEngine(f.p, () => ({}), () => now);
    const q = [asset('a'), asset('b')];
    e.load(q, 0, null);
    e.load(q, 1, null);
    e.syncQueue([...q, asset('c')], 1);
    await flush();
    expect(f.calls.map((c) => c[0])).toEqual(['setQueue', 'skipTo', 'updateQueue']);
    expect(f.calls[1]![1]).toEqual({ index: 1, startMs: 0 });
  });

  it('tjenesten går videre selv: onIndex (ikke onEnded), play/pause og interpolert posisjon', async () => {
    const f = fakePlugin();
    const e = new NativeEngine(f.p, () => ({}), () => now);
    const h = handlers();
    e.setHandlers(h);
    e.load([asset('a'), asset('b')], 0, null);
    f.emit({ playing: true, index: 0, positionMs: 5_000 });
    now += 250;
    expect(e.positionMs()).toBe(5_250);
    f.emit({ playing: true, index: 1, positionMs: 0 });
    f.emit({ playing: false, index: 1, positionMs: 1_000 });
    now += 5_000;
    expect(e.positionMs()).toBe(1_000); // pauset: ingen interpolering
    expect(h.log).toEqual(['play', 'time:5000', 'index:1', 'time:0', 'pause', 'time:1000']);
    expect(h.log).not.toContain('ended');
    expect(e.isPaused()).toBe(true);
  });
});

// ---------------------------------------------------------------- Storen mot en falsk motor (samme kontrakt for begge)

class FakeEngine implements PlayerEngine {
  kind: 'html' | 'native';
  h: EngineHandlers | null = null;
  calls: string[] = [];
  paused = true;
  pos = 0;
  constructor(kind: 'html' | 'native') {
    this.kind = kind;
  }
  setHandlers(h: EngineHandlers) {
    this.h = h;
  }
  load(q: LoadedAsset[], i: number, startMs: number | null) {
    this.calls.push(`load:${q[i]!.manifest.slug}@${startMs ?? 0}`);
  }
  syncQueue(q: LoadedAsset[], i: number) {
    this.calls.push(`sync:${q.map((a) => a.manifest.slug).join(',')}@${i}`);
  }
  play() {
    this.paused = false;
    this.calls.push('play');
  }
  pause() {
    this.paused = true;
    this.calls.push('pause');
  }
  seek(ms: number) {
    this.pos = ms;
    this.calls.push(`seek:${ms}`);
  }
  setUserVolume(v: number) {
    this.calls.push(`vol:${v}`);
  }
  isPaused() {
    return this.paused;
  }
  hasSource() {
    return this.calls.some((c) => c.startsWith('load'));
  }
  positionMs() {
    return this.pos;
  }
}

describe('spiller-storen mot motor-kontrakten', () => {
  beforeEach(() => {
    vi.resetModules();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] });
  });

  it('HTML: «ended» → storen laster neste selv', async () => {
    const { usePlayer, setEngine } = await import('../src/lib/player');
    const e = new FakeEngine('html');
    setEngine(e);
    usePlayer.getState().playFrom([asset('a'), asset('b')], 0);
    e.h!.onEnded();
    expect(e.calls).toEqual(['vol:1', 'load:a@0', 'play', 'load:b@0', 'play']);
    expect(usePlayer.getState().index).toBe(1);
  });

  it('native: onIndex oppdaterer bare storen (tjenesten har allerede byttet låt)', async () => {
    const { usePlayer, setEngine } = await import('../src/lib/player');
    const e = new FakeEngine('native');
    setEngine(e);
    usePlayer.getState().playFrom([asset('a'), asset('b'), asset('c')], 0);
    e.h!.onPlay();
    e.h!.onIndex(2);
    expect(usePlayer.getState().index).toBe(2);
    expect(usePlayer.getState().playing).toBe(true);
    expect(e.calls.filter((c) => c.startsWith('load'))).toEqual(['load:a@0']);
  });

  it('spill neste / legg i kø / flytt / fjern sendes som syncQueue, uten å bytte låt', async () => {
    const { usePlayer, setEngine } = await import('../src/lib/player');
    const e = new FakeEngine('native');
    setEngine(e);
    const p = () => usePlayer.getState();
    p().playFrom([asset('a'), asset('b')], 0);
    p().insertNext([asset('x')]);
    p().enqueue([asset('z')]);
    p().moveInQueue(3, 1);
    p().removeFromQueue(2);
    expect(e.calls.filter((c) => c.startsWith('sync'))).toEqual(['sync:a,x,b@0', 'sync:a,x,b,z@0', 'sync:a,z,x,b@0', 'sync:a,z,b@0']);
    expect(e.calls.filter((c) => c.startsWith('load'))).toEqual(['load:a@0']);
  });

  it('live-sett fortsetter fra lagret posisjon; volum går til motoren', async () => {
    const { usePlayer, setEngine } = await import('../src/lib/player');
    localStorage.setItem('gv:pos:sett:main', '61000');
    const e = new FakeEngine('html');
    setEngine(e);
    usePlayer.getState().playFrom([asset('sett', { kind: 'set' })], 0);
    usePlayer.getState().setVolume(0.5);
    expect(e.calls).toEqual(['vol:1', 'load:sett@61000', 'play', 'vol:0.5']);
  });
});
