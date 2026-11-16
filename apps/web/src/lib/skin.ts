import { create } from 'zustand';
import { BUILT_IN_SKIN_IDS, DEFAULT_SKIN_ID, skinAccentVars, skinRootVars, validateSkin, type Palette, type Skin } from '@gv/shared/web';

/**
 * Del 19: skins. Valget lagres PER ENHET (localStorage), så PC og telefon kan ha ulike skins.
 * «Bruk samme på alle enheter» følger i stedet data/skins/_shared.json på Vault-serveren.
 * Byttet skjer umiddelbart: variablene legges på <html>, og komponentene som bruker trackVars abonnerer.
 */
const files = import.meta.glob<Skin>('../skins/*.json', { eager: true, import: 'default' });
export const BUILT_IN_SKINS: Skin[] = BUILT_IN_SKIN_IDS.map((id) => {
  const raw = Object.entries(files).find(([p]) => p.endsWith(`/${id}.json`))?.[1];
  if (!raw) throw new Error(`skin mangler: ${id}`);
  return { ...validateSkin(raw), builtIn: true };
});
const byId = (list: Skin[], id: string | null | undefined) => (id ? list.find((s) => s.id === id) : undefined);
const DEFAULT = byId(BUILT_IN_SKINS, DEFAULT_SKIN_ID)!;

const KEY = 'gv:skin';
interface Local {
  id: string;
  followShared: boolean;
  /** Siste kjente egne skins, så et eget skin vises riktig før serveren har svart. */
  cache?: Skin[];
}
function readLocal(): Local {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Local | null;
    if (v && typeof v.id === 'string') return { id: v.id, followShared: v.followShared === true, cache: Array.isArray(v.cache) ? v.cache : [] };
  } catch {
    /* privat modus eller ødelagt verdi */
  }
  return { id: DEFAULT_SKIN_ID, followShared: false, cache: [] };
}
function writeLocal(l: Local) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* ikke kritisk */
  }
}

interface SkinStore {
  /** Valgt id på denne enheten. */
  localId: string;
  followShared: boolean;
  sharedId: string | null;
  custom: Skin[];
  /** Skinnet som faktisk gjelder nå. */
  skin: Skin;
  all: () => Skin[];
  choose: (id: string) => void;
  setFollowShared: (on: boolean) => Promise<void>;
  load: () => Promise<void>;
  saveCustom: (s: Skin) => Promise<void>;
  deleteCustom: (id: string) => Promise<void>;
}

function resolve(localId: string, followShared: boolean, sharedId: string | null, custom: Skin[]): Skin {
  const all = [...BUILT_IN_SKINS, ...custom];
  return byId(all, followShared ? sharedId ?? localId : localId) ?? DEFAULT;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Feil (${r.status})`);
  return j;
}

const initial = readLocal();
const initialCustom = (initial.cache ?? []).flatMap((s) => {
  try {
    return [validateSkin(s)];
  } catch {
    return [];
  }
});

export const useSkin = create<SkinStore>((set, get) => {
  const commit = (patch: Partial<Pick<SkinStore, 'localId' | 'followShared' | 'sharedId' | 'custom'>>) => {
    const next = { ...get(), ...patch };
    const skin = resolve(next.localId, next.followShared, next.sharedId, next.custom);
    set({ ...patch, skin });
    writeLocal({ id: next.localId, followShared: next.followShared, cache: next.custom });
    applySkin(skin);
  };
  return {
    localId: initial.id,
    followShared: initial.followShared,
    sharedId: null,
    custom: initialCustom,
    skin: resolve(initial.id, initial.followShared, null, initialCustom),
    all: () => [...BUILT_IN_SKINS, ...get().custom],
    choose: (id) => {
      commit({ localId: id });
      // Følger enheten «samme på alle», flyttes valget for alle
      if (get().followShared) void api<{ shared: string | null }>('/api/skins/shared', 'PUT', { id }).then((r) => commit({ sharedId: r.shared })).catch(() => undefined);
    },
    setFollowShared: async (on) => {
      commit({ followShared: on });
      if (on) {
        const r = await api<{ shared: string | null }>('/api/skins/shared', 'PUT', { id: get().localId });
        commit({ sharedId: r.shared });
      }
    },
    load: async () => {
      try {
        const r = await api<{ custom: Skin[]; shared: string | null }>('/api/skins');
        commit({ custom: r.custom, sharedId: r.shared });
      } catch {
        /* frakoblet: behold lokalt valg */
      }
    },
    saveCustom: async (s) => {
      const r = await api<{ custom: Skin[]; shared: string | null }>(`/api/skins/custom/${encodeURIComponent(s.id)}`, 'PUT', s);
      commit({ custom: r.custom, sharedId: r.shared });
    },
    deleteCustom: async (id) => {
      const r = await api<{ custom: Skin[]; shared: string | null }>(`/api/skins/custom/${encodeURIComponent(id)}`, 'DELETE');
      const patch: Partial<SkinStore> = { custom: r.custom, sharedId: r.shared };
      if (get().localId === id) patch.localId = DEFAULT_SKIN_ID;
      commit(patch);
    }
  };
});

/** Android-appen: statuslinje, navigasjonslinje og oppstartsskjerm (del 19 pkt. 8). Settes av platform.ts. */
let nativeBars: ((bg: string, splash: string) => void) | null = null;
export function setNativeSkinHook(fn: (bg: string, splash: string) => void) {
  nativeBars = fn;
  fn(useSkin.getState().skin.background.base, splashKind(useSkin.getState().skin));
}
/** Oppstartsskjermen kan bare velge blant forhåndsdefinerte temaer i appen. */
export function splashKind(s: Skin): 'obsidian' | 'oled' | 'night' {
  if (s.background.base === '#000000') return 'oled';
  if (s.id === 'echo-groove-nights') return 'night';
  return 'obsidian';
}

/** Legger skinnets variabler på <html>. Ingen omstart. */
export function applySkin(skin: Skin) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  for (const [k, v] of Object.entries({ ...skinRootVars(skin), ...skinAccentVars(skin, null) })) el.style.setProperty(k, v);
  el.dataset.skin = skin.id;
  el.dataset.wave = skin.waveform;
  el.dataset.goldFrame = skin.goldFrame ? '1' : '0';
  if (skin.background.moon) el.dataset.moon = '1';
  else delete el.dataset.moon;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', skin.background.base);
  nativeBars?.(skin.background.base, splashKind(skin));
}

/** Aksentvariablene for en låt i gjeldende skin (manuell farge gjelder bare i Kameleon). */
export function skinTrackVars(p: Palette | null | undefined, dim = false): Record<string, string> {
  return skinAccentVars(useSkin.getState().skin, p ?? null, dim);
}

/** Abonner på skin-bytte (for komponenter som bruker trackVars). */
export const useSkinId = () => useSkin((s) => s.skin.id);

/** Kort tekst i skinnets tone til tomme tilstander og oppstart (Echo Groove Nights), ellers fallback. */
export function useTagline(fallback: string, seed = 0): string {
  const t = useSkin((s) => s.skin.brand?.taglines);
  return t && t.length ? t[Math.abs(seed) % t.length]! : fallback;
}

applySkin(useSkin.getState().skin);
