/**
 * Del 15: oppdatering av Android-appen. Rene regler, brukt av server, release-skript og appen.
 *
 * Bunt-versjon = byggetidspunkt som tall (ÅÅÅÅMMDDttmmss), så nyere alltid er større.
 * versionCode (APK) går aldri ned: maks av lagret teller + 1 og antall commits.
 */

export interface BundleInfo {
  version: number;
  sha256: string;
  size: number;
  /** Laveste APK-versionCode bunten virker med (native kode den kaller). */
  minNative: number;
  file: string;
  builtAt: string;
}
export interface ApkInfo {
  versionCode: number;
  versionName: string;
  sha256: string;
  size: number;
  notes: string;
  file: string;
  /** Hash av den native koden APK-en ble bygget fra. */
  nativeHash: string;
  builtAt: string;
}
export interface AppReleaseManifest {
  schema: 1;
  bundle: BundleInfo | null;
  apk: ApkInfo | null;
}

/** Bunt-versjon fra et tidspunkt (lokal tid er uviktig, bare at den øker). */
export function bundleVersionAt(d: Date): number {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return Number(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`);
}

/**
 * Skal appen hente denne bunten? Bare hvis den er nyere enn den som kjører, ikke er markert ødelagt,
 * og appens native del er ny nok (minNative ≤ versionCode).
 */
export function shouldTakeBundle(b: Pick<BundleInfo, 'version' | 'minNative'> | null | undefined, app: { bundleVersion: number; versionCode: number; badBundle?: number }): boolean {
  if (!b || !Number.isFinite(b.version)) return false;
  if (b.version <= app.bundleVersion) return false;
  if (app.badBundle && b.version === app.badBundle) return false;
  return b.minNative <= app.versionCode;
}

/** «Ny app-versjon – Oppdater» når det finnes en APK med høyere versionCode. */
export function shouldOfferApk(a: Pick<ApkInfo, 'versionCode'> | null | undefined, versionCode: number): boolean {
  return !!a && Number.isInteger(a.versionCode) && a.versionCode > versionCode;
}

/** Neste versionCode: aldri lavere enn forrige (bygg fra en annen gren kan ha færre commits). */
export function nextVersionCode(counter: number | null | undefined, commits: number): number {
  const c = Number.isInteger(counter) && (counter as number) > 0 ? (counter as number) : 0;
  return Math.max(c + 1, Math.max(1, Math.floor(commits || 0)));
}

/**
 * minNative for en ny bunt: siste APK sin versionCode hvis den native koden er den samme som da APK-en
 * ble bygget; ellers (native endret, ny APK ikke laget ennå) én høyere, så ingen gammel app tar bunten.
 */
export function minNativeFor(apk: Pick<ApkInfo, 'versionCode' | 'nativeHash'> | null | undefined, nativeHash: string): number {
  if (!apk) return 1;
  return apk.nativeHash === nativeHash ? apk.versionCode : apk.versionCode + 1;
}
