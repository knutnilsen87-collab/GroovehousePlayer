import { setTargetLufs } from './engine/types';

/** Del 8: klient for /api/settings. Ingen hemmeligheter går denne veien (PIN sendes bare inn, aldri ut). */

export type Tier = 'partner' | 'inner_circle' | 'supporter' | 'teaser';
export interface IngestRule {
  pattern: string;
  kind?: 'set' | 'track';
  variant?: string;
}
export interface Editable {
  audio: { targetLufs: number };
  ingest: { setThresholdMinutes: number; rules: IngestRule[] };
  colors: { minContrast: number; colorFallback: boolean };
  drops: { tier: Tier; ttlDays: number; maxDevices: number; watermark: boolean };
  defaults: { artist: string | null; label: string | null; copyright: string | null };
  titleCleanup: { remove: string[] };
  exportDir: string | null;
}
export interface WatcherStatus {
  exportDir: string;
  queued: number;
  busy: boolean;
  lastEvent: { at: string; text: string } | null;
}
export interface SettingsState {
  settings: Editable;
  defaults: Editable;
  exportDirFromEnv: boolean;
  watcher: WatcherStatus | null;
  server: { port: number; pid: number; hls: string };
  lan: { enabled: boolean; pinSet: boolean; firewallRule: boolean | null };
  remote: { running: boolean; host: string | null; serve: boolean; funnel: boolean; url: string | null; qr: string | null };
  canChangeAccess: boolean;
  /** Prosjektmappa ligger i en synkronisert skymappe (Google Drive, OneDrive …). */
  cloudSync: { provider: string; syncRoot: string; warning: string } | null;
  /** Del 15: nyeste publiserte app (bunt og APK). */
  app: { bundle: { version: number; minNative: number; builtAt: string } | null; apk: { versionCode: number; versionName: string; builtAt: string } | null };
}
export interface PreviewRow {
  file: string;
  title: string;
  slug: string;
  variant: string | null;
  kind: 'set' | 'track' | 'etter lengde';
  removed: string[];
  rule: string | null;
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(j.error ?? `Feil (${r.status})`), { status: r.status, body: j });
  return j;
}

export const settingsApi = {
  get: () => call<SettingsState>('/api/settings'),
  save: (patch: Partial<Editable>) => call<{ settings: Editable; watcher: WatcherStatus | null; restarted: string[] }>('/api/settings', 'PUT', patch),
  checkDir: (dir: string) => call<{ ok: boolean; error?: string; audioFiles?: number; many?: boolean }>('/api/settings/check-dir', 'POST', { dir }),
  preview: (patch: Partial<Editable>) => call<{ rows: PreviewRow[]; total: number; copyright: string | null }>('/api/settings/preview', 'POST', patch),
  recolor: () => call<{ changed: number; skipped: number }>('/api/settings/recolor', 'POST', {}),
  restartWatcher: () => call<{ watcher: WatcherStatus | null }>('/api/settings/watcher/restart', 'POST', {}),
  restartServer: () => call<{ ok: true }>('/api/settings/server/restart', 'POST', {}),
  setLan: (enabled: boolean) => call<{ ok: true; restarting: boolean }>('/api/settings/lan', 'POST', { enabled }),
  setPin: (pin: string, repeat: string) => call<{ ok: true; restarting: boolean }>('/api/settings/lan/pin', 'POST', { pin, repeat })
};

let minContrast = 4.5;
export const getMinContrast = () => minContrast;

/** Henter LUFS-mål og kontrastkrav ved oppstart. Feiler stille (da gjelder det ingest regnet ut). */
export async function loadPlaybackSettings(): Promise<void> {
  try {
    const j = await call<{ targetLufs: number; minContrast: number }>('/api/settings/playback');
    setTargetLufs(j.targetLufs);
    if (Number.isFinite(j.minContrast)) minContrast = j.minContrast;
  } catch {
    /* eldre server eller lyttelenke */
  }
}

/** WCAG-kontrast mellom to #rrggbb-farger (uten culori i nettleseren). */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0;
    const n = parseInt(m[1]!, 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100;
}
