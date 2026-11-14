/**
 * Hvor Vault er (del 12). På web/desktop: samme opprinnelse (tom streng). I Android-appen: Tailscale-
 * adressen som ble lagt inn ved «Koble til Vault», og et enhetstoken. Ingen av delene ligger i koden
 * eller i git – de lagres bare kryptert i appen (Android Keystore).
 */
const conn = { server: '', token: '' };

export const serverBase = () => conn.server;
export const authHeaders = (): Record<string, string> => (conn.token ? { Authorization: `Bearer ${conn.token}` } : {});
export function setConnection(server: string, token: string) {
  conn.server = server.replace(/\/+$/, '');
  conn.token = token;
}
export const hasConnection = () => conn.server !== '';

/** Del 15: appens APK- og bunt-versjon, sendt med hvert kall så Studio kan vise hva hver enhet kjører. */
const client: Record<string, string> = {};
export function setClientVersion(versionCode: number, bundle: number) {
  client['X-GV-App'] = String(versionCode);
  if (bundle) client['X-GV-Bundle'] = String(bundle);
}
export const clientHeaders = (): Record<string, string> => ({ ...client });

/** «pc.tailXXXX.ts.net», «https://pc.tailXXXX.ts.net/» → «https://pc.tailXXXX.ts.net». Bare HTTPS. */
export function normalizeServer(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' || !u.hostname.includes('.')) return null;
    return `https://${u.host}`;
  } catch {
    return null;
  }
}
