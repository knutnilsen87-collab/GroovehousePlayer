import { registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { create } from 'zustand';
import { shouldOfferApk, shouldTakeBundle } from '@gv/shared/web';
import { authHeaders, serverBase, setClientVersion } from './connection';
import { usePlayer } from './player';

/**
 * Del 15: appen oppdaterer seg selv fra Vault.
 *  - Web-bunt: sjekkes ved oppstart og når appen kommer i forgrunnen. Lastes ned, sjekkes (sha256) og
 *    tas i bruk ved neste oppstart – aldri mens musikken spiller. Den nye bunten må melde «klar»
 *    (notifyReady) innen 10 s, ellers ruller appen tilbake.
 *  - APK: banneret «Ny app-versjon – Oppdater» når Vault har en APK med høyere versionCode.
 */
export interface AppUpdaterPlugin {
  getInfo(): Promise<{ versionCode: number; versionName: string; activeBundle: number; pendingBundle: number; badBundle: number; lastError: string | null; canInstall: boolean }>;
  notifyReady(): Promise<void>;
  downloadBundle(o: { url: string; version: number; sha256: string; headers: Record<string, string> }): Promise<{ staged: boolean }>;
  stage(): Promise<{ staged: boolean }>;
  downloadApk(o: { url: string; sha256: string; headers: Record<string, string> }): Promise<{ ok: boolean }>;
  installApk(): Promise<{ needsPermission: boolean }>;
}
export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

interface ApkOffer {
  versionCode: number;
  versionName: string;
  sha256: string;
  size: number;
  notes: string;
}
interface UpdateState {
  versionCode: number;
  bundle: number;
  apk: ApkOffer | null;
  canInstall: boolean;
  busy: 'idle' | 'downloading' | 'installing';
  error: string | null;
  /** Ny bunt ligger klar til neste oppstart. */
  staged: number | null;
  dismissed: boolean;
}
export const useUpdate = create<UpdateState>(() => ({ versionCode: 0, bundle: 0, apk: null, canInstall: true, busy: 'idle', error: null, staged: null, dismissed: false }));

/** Bunt-versjonen som kjører nå (skrevet inn av bunt-steget). 0 = ukjent (eldre bygg). */
async function runningBundle(): Promise<number> {
  try {
    const r = await fetch(new URL('/gv-bundle.json', location.origin).href, { cache: 'no-store' });
    return r.ok ? Number(((await r.json()) as { version?: number }).version) || 0 : 0;
  } catch {
    return 0;
  }
}

let checking = false;
async function check() {
  if (checking || !serverBase()) return;
  checking = true;
  try {
    const info = await AppUpdater.getInfo();
    useUpdate.setState({ versionCode: info.versionCode, canInstall: info.canInstall });
    const st = useUpdate.getState();
    // Web-bunt
    const b = await fetch('/api/app/bundle', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ version: number; sha256: string; size: number; minNative: number }>) : null))
      .catch(() => null);
    const pending = Math.max(info.pendingBundle, st.staged ?? 0);
    if (b && b.version !== pending && shouldTakeBundle(b, { bundleVersion: st.bundle, versionCode: info.versionCode, badBundle: info.badBundle })) {
      const r = await AppUpdater.downloadBundle({ url: `${serverBase()}/api/app/bundle/${b.version}.zip`, version: b.version, sha256: b.sha256, headers: authHeaders() });
      useUpdate.setState({ staged: r.staged ? b.version : null });
      if (!r.staged) stageWhenPaused();
    } else if (info.pendingBundle) stageWhenPaused();
    // APK
    const a = await fetch('/api/app/apk/latest', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<ApkOffer>) : null))
      .catch(() => null);
    useUpdate.setState({ apk: a && shouldOfferApk(a, info.versionCode) ? a : null });
  } catch (err) {
    console.warn('[oppdatering]', err);
  } finally {
    checking = false;
  }
}

/** Musikken spiller: vent til den er pauset før bunten settes for neste oppstart. */
let waiting: (() => void) | null = null;
function stageWhenPaused() {
  if (waiting) return;
  const tryStage = async () => {
    if (usePlayer.getState().playing) return;
    const r = await AppUpdater.stage().catch(() => ({ staged: false }));
    if (r.staged) {
      waiting?.();
      waiting = null;
      void AppUpdater.getInfo().then((i) => useUpdate.setState({ staged: i.pendingBundle || useUpdate.getState().staged }));
    }
  };
  waiting = usePlayer.subscribe((s, prev) => {
    if (prev.playing && !s.playing) void tryStage();
  });
  void tryStage();
}

/** Kalles én gang når appen har startet (kun i Android-appen). */
export async function startUpdater() {
  const bundle = await runningBundle();
  useUpdate.setState({ bundle });
  // Appen kom opp: denne bunten virker (ellers ruller tjenesten tilbake etter 10 s).
  await AppUpdater.notifyReady().catch(() => {});
  const info = await AppUpdater.getInfo().catch(() => null);
  if (info) {
    useUpdate.setState({ versionCode: info.versionCode, canInstall: info.canInstall });
    setClientVersion(info.versionCode, bundle);
  }
  void check();
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return;
    void AppUpdater.getInfo()
      .then((i) => useUpdate.setState({ canInstall: i.canInstall }))
      .catch(() => {});
    void check();
  });
}

/** «Oppdater»: last ned APK-en, sjekk sha256 og åpne Androids installasjonsdialog. */
export async function installApk(): Promise<'installing' | 'permission' | 'error'> {
  const a = useUpdate.getState().apk;
  if (!a) return 'error';
  useUpdate.setState({ busy: 'downloading', error: null });
  try {
    await AppUpdater.downloadApk({ url: `${serverBase()}/api/app/apk/groovehouse-vault-${a.versionCode}.apk`, sha256: a.sha256, headers: authHeaders() });
    useUpdate.setState({ busy: 'installing' });
    const r = await AppUpdater.installApk();
    useUpdate.setState({ busy: 'idle' });
    return r.needsPermission ? 'permission' : 'installing';
  } catch (err) {
    useUpdate.setState({ busy: 'idle', error: err instanceof Error ? err.message : String(err) });
    return 'error';
  }
}
