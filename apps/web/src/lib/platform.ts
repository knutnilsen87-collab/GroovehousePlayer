import { Capacitor, registerPlugin } from '@capacitor/core';
import { authHeaders, clientHeaders, serverBase, setConnection } from './connection';
import { HtmlAudioEngine } from './engine/html';
import { NativeEngine, type NativePlayerPlugin } from './engine/native';
import { mergeSavedPositions, setEngineFactory } from './player';
import { setNativeSkinHook } from './skin';

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

/** «Koble til Vault»: adresse + PIN → enhetstoken (lagres kryptert). */
export async function pairDevice(server: string, pin: string, name: string): Promise<void> {
  let r: Response;
  try {
    r = await fetch(`${server}/api/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin, name }) });
  } catch {
    throw new Error('Får ikke kontakt med Vault. Er Tailscale på, og står PC-en på?');
  }
  const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(j.error ?? `Feil ${r.status}`);
  await VaultAuth.save({ server, token: j.token });
  setConnection(server, j.token);
}

export async function forgetConnection() {
  await VaultAuth.clear().catch(() => {});
  setConnection('', '');
}
