import { useEffect } from 'react';
import { create } from 'zustand';
import { addTargets, isDraft, type Playlist, type PlaylistEntry } from '@gv/shared/web';
import { useDraftConfirm } from '../components/Draft';
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
  /** Del 16: bare i klienten – låta er et utkast (sendes ikke til serveren). */
  draft?: boolean;
}

type PatchBody = { name?: string; entries?: PlaylistEntry[]; add?: AddItem[]; query?: string; color?: string; icon?: string | null; plan?: 'album' | 'set' | null };

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
  /** Lås oppføringen: variant (null = hovedvarianten) og versjon (null = følg nyeste). */
  setLock: (id: string, entryId: string, variant: string | null, version: number | null) => Promise<Playlist>;
  setColor: (id: string, color: string) => Promise<Playlist>;
  /** Ikon fra ikonpakka (null = ingen, da vises eget cover eller mosaikken). */
  setIcon: (id: string, icon: string | null) => Promise<Playlist>;
  /** Del 16: Vanlig (null), Album-plan eller Sett-plan. */
  setPlan: (id: string, plan: 'album' | 'set' | null) => Promise<Playlist>;
  /** Eget cover (pkt. 14). Ved 409 prøves det på nytt med den ferske lista. */
  setCover: (id: string, file: Blob) => Promise<Playlist>;
  removeCover: (id: string) => Promise<Playlist>;
  remove: (id: string) => Promise<void>;
}

const PLAYLISTS_CACHE_KEY = 'gv:playlists:v1';
function readPlaylistsCache(): Playlist[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PLAYLISTS_CACHE_KEY) : null;
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(arr) ? (arr as Playlist[]) : [];
  } catch {
    return [];
  }
}
function writePlaylistsCache(playlists: Playlist[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PLAYLISTS_CACHE_KEY, JSON.stringify(playlists));
  } catch {
    /* privat modus */
  }
}

export const usePlaylists = create<State>((set, get) => {
  const replace = (p: Playlist) => {
    const next = get().playlists.some((x) => x.id === p.id) ? get().playlists.map((x) => (x.id === p.id ? p : x)) : [...get().playlists, p];
    writePlaylistsCache(next);
    set({ playlists: next });
  };

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

  /** Cover-forespørsler sender updatedAt selv; ved 409 brukes lista serveren sendte tilbake (maks 3 forsøk). */
  async function coverRequest(id: string, send: (p: Playlist) => Promise<Response>): Promise<Playlist> {
    let cur = get().playlists.find((p) => p.id === id);
    for (let attempt = 0; cur && attempt < 3; attempt++) {
      const r = await send(cur);
      const j = (await r.json().catch(() => ({}))) as { error?: string; playlist?: Playlist };
      if (r.ok && j.playlist) {
        replace(j.playlist);
        return j.playlist;
      }
      if (r.status === 409 && j.playlist) {
        cur = j.playlist;
        replace(cur);
        continue;
      }
      throw new Error(j.error ?? `Feil ${r.status}`);
    }
    throw new Error(cur ? 'Lista endres et annet sted akkurat nå – prøv igjen' : 'Fant ikke spillelista');
  }

  return {
    playlists: readPlaylistsCache(),
    loaded: false,
    error: null,
    load: async () => {
      try {
        const { playlists } = await api<{ playlists: Playlist[] }>('GET', '/api/playlists');
        writePlaylistsCache(playlists);
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
      const body = p.kind === 'smart' ? { name: `${p.name} (kopi)`, kind: 'smart', query: p.query } : { name: `${p.name} (kopi)`, entries: p.entries.map(({ slug, variant, version }) => ({ slug, variant, version })), ...(p.plan ? { plan: p.plan } : {}) };
      const { playlist } = await api<{ playlist: Playlist }>('POST', '/api/playlists', body);
      replace(playlist);
      return playlist;
    },
    restore: async (p) => {
      const body = p.kind === 'smart' ? { name: p.name, kind: 'smart', query: p.query, color: p.color, icon: p.icon ?? null } : { name: p.name, entries: p.entries, color: p.color, icon: p.icon ?? null, ...(p.plan ? { plan: p.plan } : {}) };
      const { playlist } = await api<{ playlist: Playlist }>('POST', '/api/playlists', body);
      replace(playlist);
      return playlist;
    },
    add: async (id, items) => {
      // Del 16: utkast i en vanlig liste (ikke Album-/Sett-plan) – spør først
      const p = get().playlists.find((x) => x.id === id);
      if (p && !p.plan && items.some((i) => i.draft) && !(await useDraftConfirm.getState().confirm(id, p.name))) throw new CancelledError();
      return mutate(id, () => ({ add: items.map(({ draft: _d, ...x }) => x) }));
    },
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
    setLock: (id, entryId, variant, version) => {
      const change = (p: Playlist) => p.entries.map((e) => (e.id === entryId ? { ...e, variant, version } : e));
      return mutate(id, (p) => ({ entries: change(p) }), (p) => ({ ...p, entries: change(p) }));
    },
    setColor: (id, color) => mutate(id, (p) => (p.color === color ? null : { color }), (p) => ({ ...p, color })),
    setIcon: (id, icon) => mutate(id, (p) => ((p.icon ?? null) === icon ? null : { icon }), (p) => ({ ...p, icon })),
    setPlan: (id, plan) => mutate(id, (p) => ((p.plan ?? null) === plan ? null : { plan }), (p) => ({ ...p, plan })),
    setCover: (id, file) => coverRequest(id, (p) => fetch(`/api/playlists/${encodeURIComponent(id)}/cover?updatedAt=${encodeURIComponent(p.updatedAt)}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file })),
    removeCover: (id) => coverRequest(id, (p) => fetch(`/api/playlists/${encodeURIComponent(id)}/cover`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedAt: p.updatedAt }) })),
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
export const itemFor = (a: LoadedAsset): AddItem => ({ slug: a.manifest.slug, variant: a.manifest.variant, version: null, ...(isDraft(a.manifest) ? { draft: true } : {}) });

/** Brukeren avbrøt (f.eks. «legg til utkast likevel?» → Avbryt). Vises ikke som feil. */
export class CancelledError extends Error {
  constructor() {
    super('avbrutt');
  }
}

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
export const toastError = (err: unknown) => {
  if (err instanceof CancelledError) return; // brukeren avbrøt selv
  useToast.getState().show(err instanceof Error ? err.message : String(err));
};

// ---------------------------------------------------------------- «Fortsett» i en liste

/**
 * Hvilken liste som spilles nå, så «Fortsett» vet hvor du slapp. Følger køen via queueId: «Spill neste»
 * og «Legg til i køen» (del 11) endrer køen uten å bytte den ut, og da gjelder lista fortsatt.
 */
interface NowList {
  listId: string | null;
  /** usePlayer.queueId da lista ble startet. */
  queueId: number;
  /** Asset → oppførings-nøkkel (også ved Bland). Slug brukes som reserve etter variant-/versjonsbytte. */
  keyOf: Map<LoadedAsset, string>;
  keyBySlug: Map<string, string>;
  /** Oppføringen som spilles nå (null = låta hører ikke til lista, f.eks. lagt til i køen). */
  currentKey: string | null;
}
export const useNowList = create<NowList>(() => ({ listId: null, queueId: -1, keyOf: new Map(), keyBySlug: new Map(), currentKey: null }));

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
  const keyOf = new Map(assets.map((a, k) => [a, entryIds[k]!] as const));
  const slugCount = new Map<string, number>();
  for (const a of assets) slugCount.set(a.manifest.slug, (slugCount.get(a.manifest.slug) ?? 0) + 1);
  const keyBySlug = new Map(assets.filter((a) => slugCount.get(a.manifest.slug) === 1).map((a) => [a.manifest.slug, keyOf.get(a)!] as const));
  // Sett lista før playFrom, så abonnenten under ser den med én gang; queueId oppdateres rett etter.
  useNowList.setState({ listId, queueId: usePlayer.getState().queueId + 1, keyOf, keyBySlug, currentKey: entryIds[i] ?? null });
  usePlayer.getState().playFrom(assets, i);
  useNowList.setState({ queueId: usePlayer.getState().queueId });
}

if (typeof window !== 'undefined') {
  usePlayer.subscribe((s) => {
    const now = useNowList.getState();
    if (!now.listId) return;
    // Køen er byttet ut med noe annet (ny playFrom) → ikke lenger denne lista.
    if (s.queueId !== now.queueId) {
      useNowList.setState({ listId: null, queueId: -1, keyOf: new Map(), keyBySlug: new Map(), currentKey: null });
      return;
    }
    const a = s.queue[s.index];
    const key = a ? (now.keyOf.get(a) ?? now.keyBySlug.get(a.manifest.slug) ?? null) : null;
    if (key !== now.currentKey) useNowList.setState({ currentKey: key });
    try {
      if (key && localStorage.getItem(resumeKey(now.listId)) !== key) localStorage.setItem(resumeKey(now.listId), key);
    } catch {
      /* privat modus */
    }
  });
}
