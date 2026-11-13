import { useEffect } from 'react';
import { create } from 'zustand';
import { addTargets, type Playlist, type PlaylistEntry } from '@gv/shared/web';
import type { LoadedAsset } from './catalog';
import { usePlayer } from './player';

/**
 * Spillelistene ligger på serveren (PC-en). Mobil og desktop snakker med samme server, så de er like.
 * Hver endring sendes med updatedAt. Svarer serveren 409 (endret et annet sted), kjøres operasjonen
 * på nytt mot den ferske lista – aldri stille overskriving av det den andre enheten gjorde.
 */

export interface AddItem {
  slug: string;
  variant: string | null;
  /** null = følg nyeste versjon. */
  version?: number | null;
}

type PatchBody = { name?: string; entries?: PlaylistEntry[]; add?: AddItem[]; query?: string; color?: string };

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public current?: Playlist
  ) {
    super(message);
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  if (r.status === 204) return undefined as T;
  const j = (await r.json().catch(() => ({}))) as { error?: string; playlist?: Playlist };
  if (!r.ok) throw new ApiError(r.status, j.error ?? `Feil ${r.status}`, j.playlist);
  return j as T;
}

interface State {
  playlists: Playlist[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (name: string, items?: AddItem[]) => Promise<Playlist>;
  createSmart: (name: string, query: string) => Promise<Playlist>;
  /** Kopi av en liste (manuell eller smart) med «(kopi)» i navnet. */
  duplicate: (p: Playlist) => Promise<Playlist>;
  /** Gjenoppretter en slettet liste (angre). Får ny id. */
  restore: (p: Playlist) => Promise<Playlist>;
  add: (id: string, items: AddItem[]) => Promise<Playlist>;
  rename: (id: string, name: string) => Promise<Playlist>;
  /** Flytt oppføringen til posisjonen der `beforeId` står (null = sist). */
  move: (id: string, entryId: string, beforeId: string | null) => Promise<Playlist>;
  removeEntries: (id: string, entryIds: string[]) => Promise<Playlist>;
  /** Angre fjerning: legger oppføringene tilbake på sine gamle plasser. */
  restoreEntries: (id: string, removed: Array<{ entry: PlaylistEntry; index: number }>) => Promise<Playlist>;
  setVariant: (id: string, entryId: string, variant: string | null) => Promise<Playlist>;
  setColor: (id: string, color: string) => Promise<Playlist>;
  remove: (id: string) => Promise<void>;
}

export const usePlaylists = create<State>((set, get) => {
  const replace = (p: Playlist) => set({ playlists: get().playlists.some((x) => x.id === p.id) ? get().playlists.map((x) => (x.id === p.id ? p : x)) : [...get().playlists, p] });

  /**
   * Kjør en endring som funksjon av gjeldende liste. Viser resultatet med en gang (optimistisk),
   * og ved 409 regnes endringen ut på nytt fra lista serveren sendte tilbake (maks 3 forsøk).
   */
  async function mutate(id: string, fn: (p: Playlist) => PatchBody | null, optimistic?: (p: Playlist) => Playlist): Promise<Playlist> {
    let cur = get().playlists.find((p) => p.id === id);
    if (!cur) throw new Error('Fant ikke spillelista');
    if (optimistic) replace(optimistic(cur));
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = fn(cur);
      if (!body) return cur;
      try {
        const { playlist } = await api<{ playlist: Playlist }>('PATCH', `/api/playlists/${encodeURIComponent(id)}`, { ...body, updatedAt: cur.updatedAt });
        replace(playlist);
        return playlist;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.current) {
          cur = err.current;
          replace(cur);
          continue;
        }
        await get().load(); // vis det serveren faktisk har
        throw err;
      }
    }
    await get().load();
    throw new Error('Lista endres et annet sted akkurat nå – prøv igjen');
  }

  return {
    playlists: [],
    loaded: false,
    error: null,
    load: async () => {
      try {
        const { playlists } = await api<{ playlists: Playlist[] }>('GET', '/api/playlists');
        set({ playlists, loaded: true, error: null });
      } catch (err) {
        set({ loaded: true, error: err instanceof Error ? err.message : String(err) });
      }
    },
    create: async (name, items = []) => {
      const { playlist } = await api<{ playlist: Playlist }>('POST', '/api/playlists', { name, entries: items });
      replace(playlist);
      return playlist;
    },
    createSmart: async (name, query) => {
      const { playlist } = await api<{ playlist: Playlist }>('POST', '/api/playlists', { name, kind: 'smart', query });
      replace(playlist);
      return playlist;
    },
    duplicate: async (p) => {
      const body = p.kind === 'smart' ? { name: `${p.name} (kopi)`, kind: 'smart', query: p.query } : { name: `${p.name} (kopi)`, entries: p.entries.map(({ slug, variant, version }) => ({ slug, variant, version })) };
      const { playlist } = await api<{ playlist: Playlist }>('POST', '/api/playlists', body);
      replace(playlist);
      return playlist;
    },
    restore: async (p) => {
      const body = p.kind === 'smart' ? { name: p.name, kind: 'smart', query: p.query, color: p.color } : { name: p.name, entries: p.entries, color: p.color };
      const { playlist } = await api<{ playlist: Playlist }>('POST', '/api/playlists', body);
      replace(playlist);
      return playlist;
    },
    add: (id, items) => mutate(id, () => ({ add: items })),
    rename: (id, name) => mutate(id, (p) => (p.name === name ? null : { name }), (p) => ({ ...p, name })),
    move: (id, entryId, beforeId) => {
      const reorder = (p: Playlist) => {
        const moving = p.entries.find((e) => e.id === entryId);
        if (!moving) return null; // fjernet et annet sted i mellomtiden
        const rest = p.entries.filter((e) => e.id !== entryId);
        const at = beforeId ? rest.findIndex((e) => e.id === beforeId) : -1;
        rest.splice(at < 0 ? rest.length : at, 0, moving);
        return rest;
      };
      return mutate(
        id,
        (p) => {
          const entries = reorder(p);
          return entries && entries.some((e, i) => e.id !== p.entries[i]?.id) ? { entries } : null;
        },
        (p) => ({ ...p, entries: reorder(p) ?? p.entries })
      );
    },
    removeEntries: (id, entryIds) => {
      const keep = (p: Playlist) => p.entries.filter((e) => !entryIds.includes(e.id));
      return mutate(id, (p) => (keep(p).length === p.entries.length ? null : { entries: keep(p) }), (p) => ({ ...p, entries: keep(p) }));
    },
    restoreEntries: (id, removed) => {
      const put = (p: Playlist) => {
        const out = p.entries.filter((e) => !removed.some((r) => r.entry.id === e.id));
        for (const r of [...removed].sort((a, b) => a.index - b.index)) out.splice(Math.min(r.index, out.length), 0, r.entry);
        return out;
      };
      return mutate(id, (p) => ({ entries: put(p) }), (p) => ({ ...p, entries: put(p) }));
    },
    setVariant: (id, entryId, variant) => {
      const change = (p: Playlist) => p.entries.map((e) => (e.id === entryId ? { ...e, variant } : e));
      return mutate(id, (p) => ({ entries: change(p) }), (p) => ({ ...p, entries: change(p) }));
    },
    setColor: (id, color) => mutate(id, (p) => (p.color === color ? null : { color }), (p) => ({ ...p, color })),
    remove: async (id) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = get().playlists.find((p) => p.id === id);
        if (!cur) return;
        try {
          await api('DELETE', `/api/playlists/${encodeURIComponent(id)}`, { updatedAt: cur.updatedAt });
          set({ playlists: get().playlists.filter((p) => p.id !== id) });
          return;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.current) {
            replace(err.current);
            continue;
          }
          if (err instanceof ApiError && err.status === 404) {
            set({ playlists: get().playlists.filter((p) => p.id !== id) });
            return;
          }
          throw err;
        }
      }
    }
  };
});

/** Henter listene ved oppstart, når fanen/appen kommer i forgrunnen, og hvert 10. sekund mens den vises. */
export function usePlaylistSync() {
  const load = usePlaylists((s) => s.load);
  useEffect(() => {
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const t = window.setInterval(onVisible, 10_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(t);
    };
  }, [load]);
}

export const mostRecentTarget = (playlists: Playlist[]): Playlist | undefined => addTargets(playlists).recent[0];

/** «Legg til det du ser»: en variant som er valgt/spilles låses, ellers følger oppføringen hovedvarianten. */
export const itemFor = (a: LoadedAsset): AddItem => ({ slug: a.manifest.slug, variant: a.manifest.variant, version: null });

// ---------------------------------------------------------------- Meldinger nederst (med angre)

interface ToastState {
  message: string | null;
  action: { label: string; run: () => void } | null;
  seq: number;
  show: (message: string, action?: { label: string; run: () => void }) => void;
  hide: () => void;
}

let toastTimer: number | undefined;
export const useToast = create<ToastState>((set, get) => ({
  message: null,
  action: null,
  seq: 0,
  show: (message, action) => {
    window.clearTimeout(toastTimer);
    set({ message, action: action ?? null, seq: get().seq + 1 });
    toastTimer = window.setTimeout(() => get().hide(), action ? 6000 : 3500);
  },
  hide: () => set({ message: null, action: null })
}));

export const toastError = (err: unknown) => useToast.getState().show(err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- «Fortsett» i en liste

/** Hvilken liste som spilles nå (køen = lista), så «Fortsett» vet hvor du slapp. */
interface NowList {
  listId: string | null;
  /** Oppførings-id per plass i køen (rekkefølgen som ble spilt, også ved Bland). */
  entryIds: string[];
  slugs: string[];
}
export const useNowList = create<NowList>(() => ({ listId: null, entryIds: [], slugs: [] }));

const resumeKey = (listId: string) => `gv:pl:${listId}`;
export function savedEntry(listId: string): string | null {
  try {
    return localStorage.getItem(resumeKey(listId));
  } catch {
    return null;
  }
}

/** Spill en liste: køen blir lista. `entryIds[i]` hører til `assets[i]`. */
export function playList(listId: string, assets: LoadedAsset[], entryIds: string[], i: number) {
  useNowList.setState({ listId, entryIds, slugs: assets.map((a) => a.manifest.slug) });
  usePlayer.getState().playFrom(assets, i);
}

if (typeof window !== 'undefined') {
  usePlayer.subscribe((s) => {
    const now = useNowList.getState();
    if (!now.listId) return;
    // Køen er byttet til noe annet enn lista (variantbytte beholder slugene og teller ikke).
    if (s.queue.length !== now.slugs.length || s.queue.some((a, i) => a.manifest.slug !== now.slugs[i])) {
      useNowList.setState({ listId: null, entryIds: [], slugs: [] });
      return;
    }
    const entryId = now.entryIds[s.index];
    try {
      if (entryId && localStorage.getItem(resumeKey(now.listId)) !== entryId) localStorage.setItem(resumeKey(now.listId), entryId);
    } catch {
      /* privat modus */
    }
  });
}
