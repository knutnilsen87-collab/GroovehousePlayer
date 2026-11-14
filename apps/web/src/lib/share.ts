import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { shareFileName, shareText, type ShareKind } from '@gv/shared/web';
import type { LoadedAsset } from './catalog';
import { isApp } from './platform';

/**
 * Del 10: del en låt som fil. Felles for web og app:
 *  1. hent(): laster fila fra Vault som Blob med framdrift (eget steg – Web Share krever at
 *     navigator.share kalles direkte i et klikk, og det «utløper» hvis vi først laster ned 10+ MB)
 *  2. del(): i et nytt klikk. Web: navigator.share({ files }). App: Filesystem + @capacitor/share.
 *     Kan ikke enheten dele filer (f.eks. HTTP på Wi-Fi), lastes fila ned i stedet.
 * Teksten har aldri URL, vertsnavn eller IP.
 */
export interface Fetched {
  file: File;
  title: string;
  text: string;
}

const shareUrl = (a: LoadedAsset, kind: ShareKind) => `/api/share/${encodeURIComponent(a.manifest.slug)}/${encodeURIComponent(a.manifest.variant ?? 'main')}/${a.manifest.version}?kind=${kind}`;

export async function fetchShareFile(a: LoadedAsset, kind: ShareKind, onProgress: (loaded: number, total: number | null) => void, signal?: AbortSignal): Promise<Fetched> {
  const r = await fetch(shareUrl(a, kind), { signal, cache: 'no-store' });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `Feil ${r.status}`);
  }
  const total = Number(r.headers.get('content-length')) || null;
  const reader = r.body?.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } else chunks.push(new Uint8Array(await r.arrayBuffer()));
  const m = a.manifest;
  const name = shareFileName({ artist: m.artist, title: m.title, variantLabel: m.variantLabel, kind });
  const type = kind === 'wav' ? 'audio/wav' : 'audio/mp4';
  return { file: new File(chunks as BlobPart[], name, { type }), title: m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title, text: shareText({ artist: m.artist, title: m.title }) };
}

/** Kan denne enheten dele filer via delingsmenyen? (Krever sikker kontekst: HTTPS eller localhost.) */
export function canShareFiles(f?: File): boolean {
  if (isApp) return true;
  if (typeof navigator === 'undefined' || !window.isSecureContext || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [f ?? new File([new Uint8Array(1)], 'x.m4a', { type: 'audio/mp4' })] });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled';

/** Må kalles direkte i et klikk (Web Share-regelen). */
export async function shareFetched(f: Fetched): Promise<ShareOutcome> {
  if (isApp) {
    // WebView har ikke Web Share: skriv til appens cache og del med Android-delingsmenyen.
    const data = await blobToBase64(f.file);
    const w = await Filesystem.writeFile({ path: `shared/${f.file.name}`, data, directory: Directory.Cache, recursive: true });
    try {
      await Share.share({ title: f.title, text: f.text, files: [w.uri], dialogTitle: 'Del låt' });
      return 'shared';
    } catch (err) {
      if (/cancel/i.test(String(err))) return 'cancelled';
      throw err;
    }
  }
  if (canShareFiles(f.file)) {
    try {
      await navigator.share({ files: [f.file], title: f.title, text: f.text });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  download(f.file);
  return 'downloaded';
}

export function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Lokal logg (data/shares.json) – bare låt, versjon og type, aldri mottaker. */
export function logShare(a: LoadedAsset, kind: ShareKind) {
  void fetch('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: a.manifest.slug, variant: a.manifest.variant ?? 'main', version: a.manifest.version, kind })
  }).catch(() => {});
}

/** «Vis i Utforsker»: bare på PC-en selv (serveren sjekker også). */
export const canReveal = () => !isApp && typeof location !== 'undefined' && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
export async function revealInExplorer(a: LoadedAsset, kind: ShareKind) {
  const r = await fetch('/api/share/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: a.manifest.slug, variant: a.manifest.variant ?? 'main', version: a.manifest.version, kind })
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Feil ${r.status}`);
}
