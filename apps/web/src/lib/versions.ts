import { useEffect } from 'react';
import { create } from 'zustand';
import type { Playlist } from '@gv/shared/web';
import { loadVersion, versionKey, versionsOf, type IndexEntry, type LoadedAsset, type Track } from './catalog';

/**
 * Låste versjoner (del 9 pkt. 13). Katalogen har bare nyeste versjon per variant; eldre versjoner
 * som en spilleliste peker på, hentes her ved behov fra media/ (de slettes ikke ved ny ingest).
 */
interface VersionState {
  loaded: Record<string, LoadedAsset>;
  failed: Record<string, true>;
  ensure: (index: IndexEntry[], wanted: Array<{ slug: string; variant: string | null; version: number }>) => void;
}

export const useVersions = create<VersionState>((set, get) => ({
  loaded: {},
  failed: {},
  ensure: (index, wanted) => {
    for (const w of wanted) {
      const key = versionKey(w.slug, w.variant, w.version);
      if (get().loaded[key] || get().failed[key]) continue;
      const entry = index.find((e) => e.slug === w.slug && (e.variant ?? null) === w.variant && e.version === w.version);
      if (!entry) continue; // finnes ikke i indeksen → vises som utilgjengelig
      loadVersion(entry)
        .then((a) => set({ loaded: { ...get().loaded, [key]: a } }))
        .catch(() => set({ failed: { ...get().failed, [key]: true } }));
    }
  }
}));

export interface VersionCtx {
  find: (slug: string, variant: string | null, version: number) => LoadedAsset | undefined;
  /** Finnes i indeksen, men er ikke hentet ennå. */
  pending: (slug: string, variant: string | null, version: number) => boolean;
  index: IndexEntry[];
}

/** Henter versjonene alle listene peker på, og gir oppslag for resolveEntries. */
export function useVersionCtx(index: IndexEntry[], playlists: Playlist[]): VersionCtx {
  const { loaded, failed, ensure } = useVersions();
  const wanted = playlists.flatMap((p) => p.entries.filter((e) => e.version != null).map((e) => ({ slug: e.slug, variant: e.variant, version: e.version! })));
  const sig = wanted.map((w) => versionKey(w.slug, w.variant, w.version)).join('|');
  useEffect(() => {
    if (index.length) ensure(index, wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, sig, ensure]);
  return {
    index,
    find: (slug, variant, version) => loaded[versionKey(slug, variant, version)],
    pending: (slug, variant, version) => {
      const key = versionKey(slug, variant, version);
      return !loaded[key] && !failed[key] && index.some((e) => e.slug === slug && (e.variant ?? null) === variant && e.version === version);
    }
  };
}

/** Valgene per oppføring: følg nyeste, lås variant (nyeste versjon), eller lås en bestemt versjon. */
export interface LockOption {
  value: string;
  label: string;
  variant: string | null;
  version: number | null;
}

export function lockOptions(track: Track, index: IndexEntry[]): LockOption[] {
  const label = (variant: string | null) => {
    const v = track.variants.find((x) => x.manifest.variant === variant);
    return v ? (v.manifest.variantLabel ?? 'Original') : variant ?? 'Original';
  };
  const variants = [...new Set(index.filter((e) => e.slug === track.slug).map((e) => e.variant ?? null))].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  const out: LockOption[] = [{ value: '', label: 'Følg nyeste', variant: null, version: null }];
  for (const variant of variants) {
    if (variant !== null) out.push({ value: `v:${variant}`, label: `Alltid ${label(variant)} (nyeste)`, variant, version: null });
  }
  for (const variant of variants) {
    for (const e of versionsOf(index, track.slug, variant)) {
      out.push({ value: `x:${variant ?? ''}:${e.version}`, label: `${label(variant)} v${e.version} · låst`, variant, version: e.version });
    }
  }
  return out;
}

export const lockValue = (variant: string | null, version: number | null) => (version != null ? `x:${variant ?? ''}:${version}` : variant ? `v:${variant}` : '');
