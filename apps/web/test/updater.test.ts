import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Del 15: oppdatereren i appen mot en falsk AppUpdater-plugin og et falskt Vault-API. */
const calls: string[] = [];
let info = { versionCode: 60, versionName: '0.1.0', activeBundle: 0, pendingBundle: 0, badBundle: 0, lastError: null, canInstall: true };
let playingNative = false;
let pending = 0;
const plugin = {
  getInfo: vi.fn(async () => ({ ...info, pendingBundle: pending })),
  notifyReady: vi.fn(async () => void calls.push('ready')),
  downloadBundle: vi.fn(async (o: { version: number; sha256: string }) => {
    calls.push(`download:${o.version}`);
    if (o.sha256 !== 'riktig') throw new Error('sha256 stemmer ikke');
    pending = o.version;
    return { staged: !playingNative && (calls.push(`staged:${o.version}`), true) };
  }),
  stage: vi.fn(async () => {
    if (playingNative || !pending) return { staged: false };
    calls.push(`staged:${pending}`);
    pending = 0;
    return { staged: true };
  }),
  downloadApk: vi.fn(async () => ({ ok: true })),
  installApk: vi.fn(async () => ({ needsPermission: false }))
};
vi.mock('@capacitor/core', () => ({ registerPlugin: () => plugin, Capacitor: { isNativePlatform: () => false } }));
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: async () => {} })) } }));

let api: { bundle: unknown; apk: unknown } = { bundle: null, apk: null };
const fetchMock = vi.fn(async (url: string) => {
  const u = String(url);
  if (u.endsWith('/gv-bundle.json')) return new Response(JSON.stringify({ version: 100 }));
  if (u === '/api/app/bundle') return api.bundle ? new Response(JSON.stringify(api.bundle)) : new Response('{}', { status: 404 });
  if (u === '/api/app/apk/latest') return api.apk ? new Response(JSON.stringify(api.apk)) : new Response('{}', { status: 404 });
  return new Response('{}', { status: 404 });
});

const flush = () => new Promise((r) => setTimeout(r, 20));
/** Ny modulinstans med tilkobling (som etter en oppstart). */
async function fresh() {
  vi.resetModules();
  calls.length = 0;
  const conn = await import('../src/lib/connection');
  conn.setConnection('https://vault.example', 'x'.repeat(43));
  return import('../src/lib/updater');
}

describe('oppdatering i appen (del 15)', () => {
  beforeEach(async () => {
    vi.resetModules();
    calls.length = 0;
    pending = 0;
    playingNative = false;
    info = { ...info, badBundle: 0, versionCode: 60 };
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'https://localhost' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const conn = await import('../src/lib/connection');
    conn.setConnection('https://vault.example', 'x'.repeat(43));
  });

  it('melder «klar», henter nyere bunt og setter den for neste oppstart når ingenting spilles', async () => {
    api = { bundle: { version: 200, sha256: 'riktig', size: 1, minNative: 60 }, apk: null };
    const { startUpdater, useUpdate } = await import('../src/lib/updater');
    await startUpdater();
    await flush();
    expect(calls).toEqual(['ready', 'download:200', 'staged:200']);
    expect(useUpdate.getState().staged).toBe(200);
  });

  it('bytter aldri mens musikken spiller – venter til den pauses', async () => {
    api = { bundle: { version: 200, sha256: 'riktig', size: 1, minNative: 60 }, apk: null };
    playingNative = true;
    const { usePlayer } = await import('../src/lib/player');
    usePlayer.setState({ playing: true });
    const { startUpdater } = await import('../src/lib/updater');
    await startUpdater();
    await flush();
    expect(calls).toEqual(['ready', 'download:200']);
    playingNative = false;
    usePlayer.setState({ playing: false });
    await flush();
    expect(calls).toContain('staged:200');
  });

  it('for gammel app (minNative) eller ødelagt bunt: ingen nedlasting; sha256-feil gir ingen bytte', async () => {
    api = { bundle: { version: 200, sha256: 'riktig', size: 1, minNative: 61 }, apk: null };
    let m = await fresh();
    await m.startUpdater();
    await flush();
    expect(calls).toEqual(['ready']);

    info = { ...info, badBundle: 200 };
    api = { bundle: { version: 200, sha256: 'riktig', size: 1, minNative: 1 }, apk: null };
    m = await fresh();
    await m.startUpdater();
    await flush();
    expect(calls).toEqual(['ready']);

    info = { ...info, badBundle: 0 };
    api = { bundle: { version: 300, sha256: 'feil', size: 1, minNative: 1 }, apk: null };
    m = await fresh();
    await m.startUpdater();
    await flush();
    expect(calls).toEqual(['ready', 'download:300']);
    expect(m.useUpdate.getState().staged).toBeNull();
  });

  it('«Oppdater»-banner bare for høyere versionCode', async () => {
    api = { bundle: null, apk: { versionCode: 61, versionName: '0.1.0', sha256: 'a', size: 9e6, notes: '' } };
    const { startUpdater, useUpdate } = await import('../src/lib/updater');
    await startUpdater();
    await flush();
    expect(useUpdate.getState().apk?.versionCode).toBe(61);
    info = { ...info, versionCode: 61 };
  });
});
