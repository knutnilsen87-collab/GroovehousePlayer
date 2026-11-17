import { create } from 'zustand';
import { notifyCatalogChanged } from './catalog';

/** Del 27: importstatus fra PC-en (/api/settings/import). Ingen hemmeligheter, bare mapper og status. */
export type FolderState = 'ok' | 'unset' | 'missing-drive' | 'missing' | 'not-dir' | 'locked' | 'denied' | 'error';
export interface WatchState {
  exportDir: string;
  queued: number;
  busy: boolean;
  lastEvent: { at: string; text: string } | null;
  scan: { total: number; done: number } | null;
  recent: Array<{ at: string; slug: string; variant: string | null; version: number; title: string }>;
}
export interface FolderStatus {
  dir: string | null;
  state: FolderState;
  reason: string | null;
  fix: string | null;
  watcher: WatchState | null;
}
export interface ImportStatus {
  export: FolderStatus;
  drafts: FolderStatus[];
  /** Del 25: mappene for utgitte låter (mangler hos eldre server). */
  released?: FolderStatus[];
  /** Del 24: mappa for LANDR-mastere. */
  landr?: FolderStatus;
  inbox: WatchState | null;
}

/** Alle watcherne samlet: jobber noen, og hvor langt har innhentingen kommet? */
export function progressOf(s: ImportStatus | null): { working: boolean; total: number; done: number; queued: number } {
  if (!s) return { working: false, total: 0, done: 0, queued: 0 };
  const ws = [s.export.watcher, ...s.drafts.map((d) => d.watcher), ...(s.released ?? []).map((d) => d.watcher), s.landr?.watcher, s.inbox].filter((w): w is WatchState => !!w);
  const total = ws.reduce((n, w) => n + (w.scan?.total ?? 0), 0);
  const done = ws.reduce((n, w) => n + (w.scan?.done ?? 0), 0);
  const queued = ws.reduce((n, w) => n + w.queued, 0);
  return { working: ws.some((w) => w.busy || !!w.scan), total, done, queued };
}

/** Siste import på tvers av mappene (nyeste først). */
export function recentImports(s: ImportStatus | null): WatchState['recent'] {
  if (!s) return [];
  return [s.export.watcher, ...s.drafts.map((d) => d.watcher), ...(s.released ?? []).map((d) => d.watcher), s.landr?.watcher, s.inbox]
    .flatMap((w) => w?.recent ?? [])
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Mapper med problem (valgt, men ikke lesbar). Ingen valgt eksportmappe telles også. */
export function folderProblems(s: ImportStatus | null): FolderStatus[] {
  if (!s) return [];
  return [s.export, ...s.drafts, ...(s.released ?? [])].filter((f) => f.state !== 'ok');
}

interface Store {
  status: ImportStatus | null;
  error: string | null;
  /** Antall komponenter som vil ha status (polling bare når noen ser). */
  users: number;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  acquire: () => () => void;
}

let timer: number | null = null;
let lastSeen: string | null = null;

export const useImportStatus = create<Store>((set, get) => ({
  status: null,
  error: null,
  users: 0,
  refresh: async () => {
    try {
      const r = await fetch('/api/settings/import', { cache: 'no-store' });
      if (!r.ok) throw new Error(`Feil ${r.status}`);
      const status = (await r.json()) as ImportStatus;
      // Ny låt importert: hent katalogen på nytt (billig med ETag)
      const newest = recentImports(status)[0];
      const key = newest ? `${newest.slug}:${newest.variant}:${newest.version}:${newest.at}` : null;
      if (lastSeen !== null && key && key !== lastSeen) notifyCatalogChanged();
      if (key) lastSeen = key;
      else if (lastSeen === null) lastSeen = '';
      set({ status, error: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  retry: async () => {
    await fetch('/api/settings/watcher/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ catchUp: true }) }).catch(() => null);
    await get().refresh();
  },
  acquire: () => {
    set((s) => ({ users: s.users + 1 }));
    if (timer == null) schedule(0);
    else if (!get().status) void get().refresh();
    return () => {
      set((s) => ({ users: Math.max(0, s.users - 1) }));
    };
  }
}));

function schedule(ms: number) {
  if (timer != null) return;
  timer = window.setTimeout(async () => {
    timer = null;
    const st = useImportStatus.getState();
    if (st.users <= 0) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await st.refresh();
    // Raskt mens noe jobber, ellers rolig
    schedule(progressOf(useImportStatus.getState().status).working ? 2500 : 20_000);
  }, ms);
}
