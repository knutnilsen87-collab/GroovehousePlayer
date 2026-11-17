import { Capacitor, registerPlugin } from '@capacitor/core';
import { authHeaders, clientHeaders, serverBase, setConnection } from './connection';
import { HtmlAudioEngine } from './engine/html';
import { NativeEngine, type NativePlayerPlugin } from './engine/native';
import { mergeSavedPositions, setEngineFactory } from './player';
import { setNativeSkinHook } from './skin';
import { explainPair, type ConnectHelp, type HealthOutcome } from './connectErrors';

/**
 * Web/desktop eller Android-appen (Capacitor, del 12). Importeres først i main.tsx.
 * I appen: Media3-motoren, tilkobling fra Keystore, og /api + /media mot Vault over Tailscale.
 */
export const isApp = Capacitor.isNativePlatform();

/** Kotlin-plugin: adresse + enhetstoken kryptert med Android Keystore. */
export interface VaultAuthPlugin {
  load(): Promise<{ server: string | null; token: string | null }>;
  save(o: { server: string; token: string }): Promise<void>;
  clear(): Promise<void>;
}
export const VaultAuth = registerPlugin<VaultAuthPlugin>('VaultAuth');
export const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer');
/** Del 19: statuslinje, navigasjonslinje og oppstartsskjerm etter skinnet (krever APK med SystemBarsPlugin). */
const SystemBars = registerPlugin<{ set(o: { background: string; splash: string }): Promise<void> }>('SystemBars');
if (isApp) setNativeSkinHook((background, splash) => void SystemBars.set({ background, splash }).catch(() => undefined));

setEngineFactory(() => (isApp ? new NativeEngine(NativePlayer, authHeaders) : new HtmlAudioEngine()));

if (isApp && typeof window !== 'undefined') {
  // Relative /api- og /media-kall går til Vault (Tailscale) med enhetstokenet.
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && (input.startsWith('/api/') || input.startsWith('/media/'))) {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries({ ...authHeaders(), ...clientHeaders() })) if (!headers.has(k)) headers.set(k, v);
      return original(serverBase() + input, { ...init, headers });
    }
    return original(input, init);
  };
}

/** Leser lagret tilkobling (appen). På web: alltid «tilkoblet» (samme opprinnelse). */
export async function loadConnection(): Promise<boolean> {
  if (!isApp) return true;
  try {
    const r = await VaultAuth.load();
    if (r.server && r.token) {
      setConnection(r.server, r.token);
      // Fortsett-posisjoner som native-tjenesten lagret mens appen var i bakgrunnen (ikke blokker oppstarten)
      void NativePlayer.getState()
        .then((st) => mergeSavedPositions(st?.savedPositions))
        .catch(() => null);
      return true;
    }
  } catch {
    /* ingen lagret tilkobling */
  }
  return false;
}

const online = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

/** Del 27, steg 4 «Test forbindelsen»: svarer Vault på adressen? (Ingen PIN eller token sendes.) */
export async function probeVault(server: string, timeoutMs = 10_000): Promise<HealthOutcome> {
  try {
    const r = await fetch(`${server}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.json().catch(() => null);
    return { kind: 'response', status: r.status, body };
  } catch (err) {
    return { kind: 'network-error', online: online(), timedOut: err instanceof DOMException && err.name === 'TimeoutError' };
  }
}

/** «Koble til Vault»: adresse + PIN → enhetstoken (lagres kryptert). Gir forklaringen ved feil, null når det gikk. */
export async function pairDevice(server: string, pin: string, name: string): Promise<ConnectHelp | null> {
  let r: Response;
  try {
    r = await fetch(`${server}/api/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, name }), signal: AbortSignal.timeout(15_000) });
  } catch {
    return explainPair({ kind: 'network-error', online: online() });
  }
  const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !j.token) return explainPair({ kind: 'response', status: r.status, error: j.error });
  await VaultAuth.save({ server, token: j.token });
  setConnection(server, j.token);
  return null;
}

export async function forgetConnection() {
  await VaultAuth.clear().catch(() => {});
  setConnection('', '');
}
