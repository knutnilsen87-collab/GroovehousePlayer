import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  isDraft,
  planStats,
  PLAN_NAMES,
  type Flow,
  addTargets,
  BUILTIN_SMART,
  colorById,
  formatListDuration,
  formatTime,
  isBuiltin,
  neonCore,
  neonGlow,
  PLAYLIST_COLOR_GROUPS,
  PLAYLIST_COLORS, PLAYLIST_ICONS,
  playableEntries,
  playlistStats,
  resolveEntries,
  shuffled,
  smartListAssets,
  type Playlist,
  type PlaylistColor,
  type PlaylistEntry,
  type ResolvedEntry
} from '@gv/shared/web';
import { assetUrl, variantName, type LoadedAsset, type Track } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { playList, savedEntry, toastError, useNowList, usePlaylists, useToast, type AddItem } from '../lib/playlists';
import { useTouchReorder } from '../lib/useTouchReorder';
import { lockOptions, lockValue, type VersionCtx } from '../lib/versions';
import { useUi, type ExtraAction } from '../lib/ui';
import { serverBase } from '../lib/connection';
import { useFavorites } from '../lib/library';
import { DraftBadge } from './Draft';
import { CoverArt } from './CoverArt';
import { BoltIcon, ChevronDownIcon, GripIcon, MoreIcon, PlayIcon, PlusIcon, ShuffleIcon, TrashIcon } from './Icons';

// ---------------------------------------------------------------- Farge og glød

/** Fargeprikken: lys kjerne (neonrør) og glød i listefargen. `pulse` = puster med sub-bassen mens lista spilles. */
export function ColorDot({ color, size = 10, pulse = false }: { color: PlaylistColor; size?: number; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block flex-none rounded-full ${pulse ? 'gv-pulse' : ''}`}
      style={{ width: size, height: size, background: `radial-gradient(circle, ${neonCore(color.primary)} 0 32%, ${color.primary} 72%)`, boxShadow: neonGlow(color.primary) }}
    />
  );
}

/** Cover-mosaikk av de fire første låtene, med tynn kant i listefargen. */
export function Mosaic({ assets, size, color, rounded = 10 }: { assets: LoadedAsset[]; size: number; color: PlaylistColor; rounded?: number }) {
  const four = assets.slice(0, 4);
  const frame: CSSProperties = { width: size, height: size, borderRadius: rounded, boxShadow: `0 0 0 1px ${color.primary}80` };
  if (four.length < 4) {
    const a = four[0];
    return (
      <span className="block flex-none overflow-hidden" style={frame}>
        {a ? (
          <CoverArt src={assetUrl(a, a.manifest.files.coverThumb)} palette={a.manifest.palette} title={a.manifest.title} size={size} rounded={rounded} />
        ) : (
          <span className="flex h-full w-full items-center justify-center" style={{ background: `radial-gradient(circle at 30% 25%, ${color.primary}55, ${color.secondary}22 60%, #0E1015)` }}>
            <ColorDot color={color} size={Math.max(8, size / 6)} />
          </span>
        )}
      </span>
    );
  }
  const half = size / 2;
  return (
    <span className="grid flex-none grid-cols-2 overflow-hidden" style={frame}>
      {four.map((a, i) => (
        <CoverArt key={`${i}-${a.manifest.id}`} src={assetUrl(a, a.manifest.files.coverThumb)} palette={a.manifest.palette} title={a.manifest.title} size={half} rounded={0} />
      ))}
    </span>
  );
}

/** Bilde fra ikonpakka (public/playlist-icons): 160 px i lister og ark, 512 px ellers. */
export const playlistIconUrl = (icon: string, size: number) => `/playlist-icons/${icon}${size <= 160 ? '_160' : ''}.webp`;

/** Eget cover hvis lista har det (pkt. 14), ellers ikon fra ikonpakka, ellers mosaikken. Tynn kant i listefargen uansett. */
export function ListCover({ v, size, rounded = 10 }: { v: ListView; size: number; rounded?: number }) {
  const cover = v.playlist?.cover;
  const icon = v.playlist?.icon;
  if (!cover && icon)
    return (
      <img
        src={playlistIconUrl(icon, size)}
        alt={`Ikon: ${v.name}`}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className="block flex-none object-cover"
        style={{ width: size, height: size, borderRadius: rounded }}
      />
    );
  if (!cover) return <Mosaic assets={v.assets} size={size} color={v.color} rounded={rounded} />;
  const file = size <= 300 ? cover.replace(/\.jpg$/, '_300.jpg') : cover;
  return (
    <img
      src={`${serverBase()}/api/playlist-covers/${encodeURIComponent(file)}`}
      alt={`Cover: ${v.name}`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="block flex-none object-cover"
      style={{ width: size, height: size, borderRadius: rounded, boxShadow: `0 0 0 1px ${v.color.primary}80` }}
    />
  );
}

// ---------------------------------------------------------------- Lister som modell (manuell, smart, innebygd)

export interface ListView {
  id: string;
  name: string;
  kind: 'manual' | 'smart' | 'builtin';
  color: PlaylistColor;
  playlist: Playlist | null;
  /** Manuelle lister: alle rader, også utilgjengelige. */
  rows: Array<ResolvedEntry<LoadedAsset>>;
  /** Det som kan spilles, i rekkefølge, med nøkkel for «Fortsett». */
  assets: LoadedAsset[];
  keys: string[];
}

const BUILTIN_COLORS: Record<string, string> = { 'builtin:favorites': 'hot-pink', 'builtin:recent': 'neon-cyan', 'builtin:sets': 'ultraviolet' };
const BUILTIN_SUB: Record<string, string> = { 'builtin:favorites': 'Smart · hjertede låter', 'builtin:recent': 'Smart · siste 14 dager', 'builtin:sets': 'Smart · alle live-sett' };

/** Del 14: «Favoritter» – låtene med hjerte, sist hjertede først (hovedvarianten). */
function favoriteAssets(tracks: Track[]): LoadedAsset[] {
  const bySlug = new Map(tracks.map((t) => [t.slug, t.main]));
  return useFavorites.getState().slugs.flatMap((s) => bySlug.get(s) ?? []);
}

export function buildListView(id: string, playlists: Playlist[], tracks: Track[], vctx?: VersionCtx): ListView | null {
  // Del 16: smarte lister (også de innebygde) bruker bare release-klare låter
  const releaseTracks = tracks.filter((t) => !isDraft(t.main.manifest));
  if (isBuiltin(id)) {
    const b = BUILTIN_SMART.find((x) => x.id === id)!;
    const assets = 'favorites' in b ? favoriteAssets(releaseTracks) : smartListAssets(releaseTracks, 'days' in b ? { days: b.days } : { query: b.query });
    return { id, name: b.name, kind: 'builtin', color: colorById(BUILTIN_COLORS[id]), playlist: null, rows: [], assets, keys: assets.map((a) => a.manifest.slug) };
  }
  const p = playlists.find((x) => x.id === id);
  if (!p) return null;
  if (p.kind === 'smart') {
    const assets = smartListAssets(releaseTracks, { query: p.query });
    return { id, name: p.name, kind: 'smart', color: colorById(p.color), playlist: p, rows: [], assets, keys: assets.map((a) => a.manifest.slug) };
  }
  const rows = resolveEntries(p.entries, tracks, vctx?.find).map((r) =>
    // Låst versjon som finnes i media/, men ikke er hentet ennå: «henter», ikke «utilgjengelig».
    !r.asset && r.entry.version != null && vctx?.pending(r.entry.slug, r.entry.variant, r.entry.version) ? { ...r, reason: `Henter v${r.entry.version} …` } : r
  );
  const ok = playableEntries(rows);
  return { id, name: p.name, kind: 'manual', color: colorById(p.color), playlist: p, rows, assets: ok.map((r) => r.asset), keys: ok.map((r) => r.entry.id) };
}

// ---------------------------------------------------------------- Meldinger nederst

export function Toast() {
  const { message, action, seq, hide } = useToast();
  if (!message) return null;
  return (
    <div
      key={seq}
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-[calc(150px+env(safe-area-inset-bottom))] z-[45] mx-auto flex max-w-[460px] items-center gap-3 rounded-xl border border-white/10 bg-[#15181F] px-4 py-3 text-sm text-ink-strong shadow-[0_12px_40px_rgba(0,0,0,0.6)] lg:bottom-[128px] lg:left-auto lg:right-6"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.run();
            hide();
          }}
          className="h-9 flex-none rounded-full px-3 text-sm font-semibold text-accent hover:bg-white/[0.06]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Legg til, med «Angre» som fjerner nøyaktig oppføringene som ble lagt til. */
export async function addWithUndo(p: Playlist, items: AddItem[]) {
  const res = await usePlaylists.getState().add(p.id, items);
  const added = res.entries.slice(-items.length).map((e) => e.id);
  useToast.getState().show(`Lagt til i ${res.name}${items.length > 1 ? ` (${items.length})` : ''}`, {
    label: 'Angre',
    run: () => void usePlaylists.getState().removeEntries(p.id, added).catch(toastError)
  });
}

// ---------------------------------------------------------------- «Legg til i spilleliste»

/**
 * Mobil: ark nederfra. Desktop: lite vindu ved musepekeren (høyreklikk) eller midt på skjermen.
 * De 3 sist brukte listene øverst, så resten, og + Ny spilleliste.
 */
export function AddToPlaylistSheet({ items, label, variantLabel, anchor, onClose }: { items: AddItem[]; label: string; variantLabel?: string | null; anchor?: { x: number; y: number } | null; onClose: () => void }) {
  const playlists = usePlaylists((s) => s.playlists);
  const { recent, rest } = useMemo(() => addTargets(playlists), [playlists]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [lock, setLock] = useState(true);
  const lockable = items.length === 1 && !!items[0]!.variant;
  const final = items.map((i) => (lockable && !lock ? { ...i, variant: null } : i));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = async (p: Playlist) => {
    setBusy(true);
    try {
      await addWithUndo(p, final);
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const p = await usePlaylists.getState().create(n, final);
      useToast.getState().show(`Lagt til i ${p.name}`, { label: 'Angre', run: () => void usePlaylists.getState().remove(p.id).catch(toastError) });
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const desktopPos: CSSProperties | undefined = anchor ? { left: Math.min(anchor.x, window.innerWidth - 340), top: Math.min(anchor.y, window.innerHeight - 440) } : undefined;
  const row = (p: Playlist) => {
    const c = colorById(p.color);
    return (
      <li key={p.id}>
        <button type="button" disabled={busy} onClick={() => void pick(p)} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-ink-strong hover:bg-white/[0.05] active:bg-white/[0.08] disabled:opacity-50 lg:min-h-10 lg:text-sm">
          <ColorDot color={c} />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <span className="tabular text-xs text-muted">{p.entries.length}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Legg til i spilleliste"
        style={desktopPos}
        className={`fixed inset-x-0 bottom-0 max-h-[78svh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-surface px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 shadow-2xl lg:bottom-auto lg:w-[320px] lg:rounded-2xl lg:border ${anchor ? 'lg:inset-x-auto' : 'lg:left-1/2 lg:top-[18vh] lg:-translate-x-1/2'}`}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15 lg:hidden" />
        <div className="px-3 pb-2">
          <h2 className="m-0 text-sm font-semibold text-ink-strong">Legg til i spilleliste</h2>
          <p className="m-0 truncate text-xs text-muted">{label}</p>
        </div>
        {lockable && variantLabel && (
          <label className="mx-3 mb-2 flex min-h-11 items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Spill alltid {variantLabel}
          </label>
        )}
        {creating ? (
          <form
            className="mx-1 mb-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label htmlFor="gv-new-list" className="sr-only">
              Navn på ny spilleliste
            </label>
            <input id="gv-new-list" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Navn, f.eks. Club Ready" className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-sunken px-3 text-[15px] text-ink-strong placeholder:text-muted focus:border-accent/60 focus:outline-none lg:h-10 lg:text-sm" />
            <button type="submit" disabled={busy || !name.trim()} className="h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40 lg:h-10">
              Lagre
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setCreating(true)} className="mb-1 flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] font-semibold text-accent hover:bg-white/[0.05] lg:min-h-10 lg:text-sm">
            <PlusIcon width={18} height={18} />
            Ny spilleliste
          </button>
        )}
        {recent.length > 0 && <SheetHeading>Sist brukt</SheetHeading>}
        <ul className="m-0 list-none p-0">{recent.map(row)}</ul>
        {rest.length > 0 && <SheetHeading>{recent.length ? 'Alle lister' : 'Spillelister'}</SheetHeading>}
        <ul className="m-0 list-none p-0">{rest.map(row)}</ul>
        <button type="button" onClick={onClose} className="mt-2 h-11 w-full rounded-xl text-sm text-muted hover:text-ink lg:hidden">
          Avbryt
        </button>
      </div>
    </div>
  );
}

const SheetHeading = ({ children }: { children: ReactNode }) => <h3 className="m-0 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[1.5px] text-muted">{children}</h3>;

// ---------------------------------------------------------------- Ikonvelger (Groovehouse-ikonpakka)

export function IconPicker({ value, hasCover, onPick, onClose }: { value: string | null; hasCover: boolean; onPick: (id: string | null) => void; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Velg ikon" className="fixed inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-surface p-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:bottom-auto lg:left-1/2 lg:top-[12vh] lg:w-[560px] lg:-translate-x-1/2 lg:rounded-2xl lg:border">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="m-0 text-base font-semibold text-ink-strong">Velg ikon</h2>
          <button type="button" onClick={onClose} className="h-10 rounded-full px-3 text-sm text-muted hover:text-ink">
            Lukk
          </button>
        </div>
        {hasCover && <p className="m-0 mb-3 text-xs text-muted">Lista har eget cover. Det vises foran ikonet til du fjerner coveret.</p>}
        <div role="radiogroup" aria-label="Ikoner" className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {PLAYLIST_ICONS.map((ic) => (
            <button
              key={ic.id}
              type="button"
              role="radio"
              aria-checked={ic.id === value}
              onClick={() => onPick(ic.id)}
              className={`flex flex-col items-center gap-1.5 rounded-xl p-1.5 text-[11px] text-soft hover:bg-white/[0.05] ${ic.id === value ? 'bg-white/[0.08] ring-2 ring-accent/70' : ''}`}
            >
              <img src={playlistIconUrl(ic.id, 160)} alt="" width={80} height={80} className="h-20 w-20" loading="lazy" />
              <span className="text-center leading-tight">{ic.name}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          onClick={() => onPick(null)}
          className={`mt-3 flex min-h-11 w-full items-center justify-center rounded-xl border text-sm ${!value ? 'border-accent/60 text-ink-strong' : 'border-white/10 text-muted hover:text-ink'}`}
        >
          Uten ikon (coverne til låtene)
        </button>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------- Fargevelger

export function ColorPicker({ value, onPick, onClose }: { value: string; onPick: (id: string) => void; onClose: () => void }) {
  const [group, setGroup] = useState<'neon' | 'candy'>(colorById(value).group);
  const [hover, setHover] = useState<PlaylistColor | null>(null);
  const shown = hover ?? colorById(value);
  // Portal til body: lista ligger i <main> (egen stablingskontekst), og arket må over minispilleren og bunnmenyen.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Velg farge" className="fixed inset-x-0 bottom-0 rounded-t-2xl bg-surface p-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:bottom-auto lg:left-1/2 lg:top-[20vh] lg:w-[380px] lg:-translate-x-1/2 lg:rounded-2xl lg:border">
        <div role="tablist" aria-label="Fargegruppe" className="mb-4 flex gap-2">
          {(Object.keys(PLAYLIST_COLOR_GROUPS) as Array<'neon' | 'candy'>).map((g) => (
            <button key={g} type="button" role="tab" aria-selected={group === g} onClick={() => setGroup(g)} className={`h-9 rounded-full px-4 text-xs font-semibold ${group === g ? 'bg-white/[0.12] text-ink-strong' : ' text-muted'}`}>
              {PLAYLIST_COLOR_GROUPS[g]}
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label={`Farger: ${PLAYLIST_COLOR_GROUPS[group]}`} className="grid grid-cols-6 gap-3">
          {PLAYLIST_COLORS.filter((c) => c.group === group).map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === value}
              aria-label={c.name}
              title={c.name}
              onMouseEnter={() => setHover(c)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(c)}
              onBlur={() => setHover(null)}
              // Langt trykk på mobil viser navnet (uten å velge)
              onTouchStart={() => setHover(c)}
              onClick={() => onPick(c.id)}
              className={`flex h-11 w-11 items-center justify-center rounded-full ${c.id === value ? 'ring-2 ring-white/70' : ''}`}
            >
              <ColorDot color={c} size={20} />
            </button>
          ))}
        </div>
        <p className="m-0 mt-4 flex items-center gap-2 text-sm text-ink-strong">
          <ColorDot color={shown} size={10} />
          {shown.name}
        </p>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------- Oversikt (fanen «Lister» på mobil)

export function PlaylistsOverview({ tracks, onOpen, vctx }: { tracks: Track[]; onOpen: (id: string) => void; vctx?: VersionCtx }) {
  const playlists = usePlaylists((s) => s.playlists);
  const loaded = usePlaylists((s) => s.loaded);
  const error = usePlaylists((s) => s.error);
  const nowList = useNowList((s) => s.listId);
  const [creating, setCreating] = useState(false);
  useFavorites((s) => s.slugs); // tegn på nytt når et hjerte endres
  const builtins = BUILTIN_SMART.map((b) => buildListView(b.id, playlists, tracks)!);
  const smart = playlists.filter((p) => p.kind === 'smart').sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  const manual = playlists.filter((p) => p.kind === 'manual').sort((a, b) => (b.usedAt ?? b.createdAt).localeCompare(a.usedAt ?? a.createdAt));

  const smartRow = (v: ListView, sub: string) => (
    <li key={v.id}>
      <button type="button" onClick={() => onOpen(v.id)} className="flex min-h-[60px] w-full items-center gap-3 rounded-xl px-1.5 text-left active:bg-white/[0.05] lg:hover:bg-white/[0.03]">
        {v.playlist?.icon ? (
          <ListCover v={v} size={48} rounded={10} />
        ) : (
          <span className="flex h-12 w-12 flex-none items-center justify-center rounded-[10px] bg-white/[0.04]" style={{ color: v.color.primary, boxShadow: `0 0 0 1px ${v.color.primary}55` }}>
            <BoltIcon width={20} height={20} />
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold text-ink-strong">{v.name}</span>
          <span className="truncate text-xs text-muted">{sub}</span>
        </span>
        <span className="tabular text-xs text-muted">{v.assets.length}</span>
      </button>
    </li>
  );

  return (
    <section aria-labelledby="gv-lists-h">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 id="gv-lists-h" className="m-0 font-display text-[30px] font-semibold uppercase tracking-[1.5px] text-ink-strong">
          Spillelister
        </h1>
        <button type="button" onClick={() => setCreating(true)} className="flex h-10 items-center gap-1.5 rounded-full border border-accent/40 px-3.5 text-sm font-semibold text-accent hover:bg-accent/[0.08]">
          <PlusIcon width={16} height={16} />
          Ny liste
        </button>
      </div>
      {creating && <NewListForm onDone={(p) => (setCreating(false), p && onOpen(p.id))} />}
      {error && <p className="text-sm text-[#FF8A7A]">Fikk ikke hentet spillelistene: {error}</p>}
      <ul className="m-0 list-none p-0">
        {builtins.map((v) => smartRow(v, BUILTIN_SUB[v.id] ?? 'Smart'))}
        {smart.map((p) => smartRow(buildListView(p.id, playlists, tracks)!, `Smart · «${p.query}»`))}
      </ul>
      <div className="my-3" />
      {loaded && manual.length === 0 && <p className="px-1.5 text-sm text-muted">Ingen egne lister ennå. Trykk «Ny liste», eller ⋯ på en låt → Legg til i spilleliste.</p>}
      <ul className="m-0 list-none p-0">
        {manual.map((p) => {
          const v = buildListView(p.id, playlists, tracks, vctx)!;
          const s = playlistStats(v.assets);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(p.id)} className="flex min-h-[64px] w-full items-center gap-3 rounded-xl px-1.5 text-left active:bg-white/[0.05] lg:hover:bg-white/[0.03]">
                <ListCover v={v} size={48} rounded={8} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 truncate text-[15px] font-semibold text-ink-strong">
                    <ColorDot color={v.color} size={8} pulse={nowList === p.id} />
                    <span className="truncate">{p.name}</span>
                  </span>
                  <span className="truncate text-xs text-muted">
                    {s.count} {s.count === 1 ? 'låt' : 'låter'} · {formatListDuration(s.totalMs)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NewListForm({ onDone }: { onDone: (p: Playlist | null) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mb-4 flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          onDone(await usePlaylists.getState().create(name.trim()));
        } catch (err) {
          toastError(err);
          setBusy(false);
        }
      }}
    >
      <label htmlFor="gv-new-list-2" className="sr-only">
        Navn på ny spilleliste
      </label>
      <input id="gv-new-list-2" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone(null)} placeholder="Navn på lista" className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-surface px-3 text-[15px] text-ink-strong placeholder:text-muted focus:border-accent/60 focus:outline-none" />
      <button type="submit" disabled={busy || !name.trim()} className="h-11 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40">
        Lag
      </button>
      <button type="button" onClick={() => onDone(null)} className="h-11 rounded-xl px-3 text-sm text-muted">
        Avbryt
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- Sidemenyen på desktop

export const DRAG_ITEMS = 'application/x-gv-items';

export function SidebarPlaylists({ tracks, activeId, onOpen }: { tracks: Track[]; activeId: string | null; onOpen: (id: string) => void }) {
  const playlists = usePlaylists((s) => s.playlists);
  const nowList = useNowList((s) => s.listId);
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const manual = playlists.filter((p) => p.kind === 'manual').sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  const smart = playlists.filter((p) => p.kind === 'smart').sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  const item = (id: string, name: string, color: PlaylistColor, smartIcon: boolean, dropTarget: Playlist | null) => {
    const active = activeId === id;
    return (
      <li key={id}>
        <button
          type="button"
          aria-current={active ? 'page' : undefined}
          onClick={() => onOpen(id)}
          onDragOver={(e) => {
            if (!dropTarget || !e.dataTransfer.types.includes(DRAG_ITEMS)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setOver(id);
          }}
          onDragLeave={() => setOver((o) => (o === id ? null : o))}
          onDrop={(e) => {
            setOver(null);
            if (!dropTarget) return;
            e.preventDefault();
            try {
              const items = JSON.parse(e.dataTransfer.getData(DRAG_ITEMS)) as AddItem[];
              if (items.length) void addWithUndo(dropTarget, items).catch(toastError);
            } catch {
              /* ikke våre data */
            }
          }}
          className={`flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left text-[13px] transition-colors ${active ? 'font-semibold text-ink-strong' : 'text-soft hover:bg-white/[0.03] hover:text-ink-strong'} ${over === id ? 'bg-white/[0.08] ring-1' : ''}`}
          style={active ? { background: `${color.primary}14`, boxShadow: `inset 2px 0 0 ${color.primary}, ${neonGlow(color.primary).split(',')[0]}` } : over === id ? ({ '--tw-ring-color': color.primary } as CSSProperties) : undefined}
        >
          {smartIcon ? <BoltIcon width={14} height={14} style={{ color: color.primary }} /> : <ColorDot color={color} size={9} pulse={nowList === id} />}
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </button>
      </li>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5">
      <button type="button" onClick={() => setCreating(true)} className="mb-1 flex min-h-10 items-center gap-2.5 rounded-[10px] px-3 py-1.5 text-left text-[13px] font-semibold text-accent hover:bg-accent/[0.08]">
        <PlusIcon width={14} height={14} />
        Ny spilleliste
      </button>
      {creating && (
        <div className="px-1">
          <NewListForm onDone={(p) => (setCreating(false), p && onOpen(p.id))} />
        </div>
      )}
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-0 pr-1">
        {BUILTIN_SMART.map((b) => item(b.id, b.name, colorById(BUILTIN_COLORS[b.id]), true, null))}
        {smart.map((p) => item(p.id, p.name, colorById(p.color), true, null))}
        {manual.length > 0 && <li aria-hidden="true" className="mx-3 my-1.5" />}
        {manual.map((p) => item(p.id, p.name, colorById(p.color), false, p))}
      </ul>
      {tracks.length > 0 && <p className="m-0 px-3 pt-1.5 text-[11px] text-muted">Dra låter hit for å legge dem til</p>}
    </div>
  );
}

/** Desktop-oppsett (samme brytepunkt som Tailwind `lg`): klikk velger, dobbeltklikk spiller. */
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

// ---------------------------------------------------------------- Lista

export function PlaylistDetail({ id, tracks, onBack, onClosed, vctx }: { id: string; tracks: Track[]; onBack: () => void; onClosed: () => void; vctx?: VersionCtx }) {
  const playlists = usePlaylists((s) => s.playlists);
  const loaded = usePlaylists((s) => s.loaded);
  useFavorites((s) => s.slugs); // «Favoritter» oppdateres når et hjerte endres
  const v = buildListView(id, playlists, tracks, vctx);
  const nowList = useNowList((s) => s.listId);
  const nowKey = useNowList((s) => s.currentKey);
  const { queue, index, playing } = usePlayer();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [missingOnly, setMissingOnly] = useState(false);
  const [resumeKey, setResumeKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Menyen lukkes ved trykk utenfor eller Esc (ikke på mouseleave, som er upålitelig med berøring).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  const uploadCover = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      await usePlaylists.getState().setCover(id, file);
      useToast.getState().show('Coveret er lagret (uten EXIF)');
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  };

  useEffect(() => setResumeKey(savedEntry(id)), [id, nowList, index]);
  if (!v) return loaded ? <p className="text-sm text-muted">Fant ikke spillelista (slettet på en annen enhet?). <button type="button" className="text-accent underline" onClick={onBack}>Tilbake</button></p> : <p className="text-sm text-muted">Laster …</p>;

  const s = playlistStats(v.assets);
  const c = v.color;
  const isNow = nowList === id;
  const editable = v.kind !== 'builtin';
  const resumeAt = resumeKey ? v.keys.indexOf(resumeKey) : -1;
  const resumeAsset = resumeAt >= 0 ? v.assets[resumeAt] : undefined;
  const play = (i: number) => v.assets.length && playList(id, v.assets, v.keys, i);
  const shuffle = () => {
    const order = shuffled(v.assets.map((_, i) => i));
    playList(
      id,
      order.map((i) => v.assets[i]!),
      order.map((i) => v.keys[i]!),
      0
    );
  };
  const bpm = s.bpmMin != null ? (s.bpmMin === s.bpmMax ? `${s.bpmMin} BPM` : `${s.bpmMin}–${s.bpmMax} BPM`) : null;

  return (
    <section aria-labelledby="gv-list-h" className="relative">
      <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-40 h-[480px] w-[480px] rounded-full" style={{ background: `radial-gradient(closest-side, ${c.primary}2E, ${c.secondary}12 60%, transparent)` }} />
      <button type="button" onClick={onBack} className="relative mb-3 flex h-10 items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronDownIcon width={18} height={18} className="rotate-90" />
        Spillelister
      </button>
      <header className="relative flex flex-col gap-4 sm:flex-row sm:items-end">
        {v.kind === 'manual' || v.playlist?.icon ? (
          <span className={`relative block ${uploading ? 'opacity-50' : ''}`}>
            <ListCover v={v} size={168} rounded={14} />
            {uploading && <span className="absolute inset-0 flex items-center justify-center text-xs text-ink-strong">Laster opp …</span>}
            <input ref={coverInput} type="file" accept="image/jpeg,image/png,image/webp,image/avif" className="sr-only" tabIndex={-1} aria-label="Velg cover for lista" onChange={(e) => void uploadCover(e.target.files?.[0])} />
          </span>
        ) : (
          <span className="flex h-[168px] w-[168px] flex-none items-center justify-center rounded-[14px] bg-surface" style={{ color: c.primary, boxShadow: `0 0 0 1px ${c.primary}80, ${neonGlow(c.primary)}` }}>
            <BoltIcon width={64} height={64} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[2px]" style={{ color: c.primary }}>
            <ColorDot color={c} size={8} pulse={isNow && playing} />
            {v.kind === 'manual' ? (v.playlist?.plan ? PLAN_NAMES[v.playlist.plan] : 'Spilleliste') : `Smart liste${v.playlist?.query ? ` · «${v.playlist.query}»` : ''}`}
          </span>
          {renaming && v.playlist ? (
            <RenameForm p={v.playlist} onDone={() => setRenaming(false)} />
          ) : (
            <h1 id="gv-list-h" className="m-0 break-words font-display text-[32px] font-semibold uppercase leading-none tracking-[1.5px] text-ink-strong lg:text-[44px]">
              {v.name}
            </h1>
          )}
          <p className="m-0 text-[13px] text-muted">{[`${s.count} ${s.count === 1 ? 'låt' : 'låter'}`, formatListDuration(s.totalMs), bpm].filter(Boolean).join(' · ')}</p>
          {v.playlist?.plan && <PlanSummary v={v} missingOnly={missingOnly} onMissingOnly={setMissingOnly} />}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!v.assets.length}
              onClick={() => play(0)}
              className={`flex h-12 items-center gap-2 rounded-full px-5 text-sm font-semibold disabled:opacity-40 ${isNow && playing ? 'gv-pulse' : ''}`}
              style={{ background: c.primary, color: c.onPrimary, boxShadow: neonGlow(c.primary) }}
            >
              <PlayIcon width={18} height={18} />
              Spill
            </button>
            <button type="button" disabled={v.assets.length < 2} onClick={shuffle} className="flex h-12 items-center gap-2 rounded-full bg-white/[0.04] px-4 text-sm text-ink hover:bg-white/[0.07] disabled:opacity-40">
              <ShuffleIcon width={16} height={16} />
              Bland
            </button>
            {resumeAsset && resumeAt > 0 && !isNow && (
              <button type="button" onClick={() => play(resumeAt)} className="flex h-12 min-w-0 items-center gap-2 rounded-full bg-white/[0.04] px-4 text-sm text-ink hover:bg-white/[0.07]">
                <span className="truncate">Fortsett: {resumeAsset.manifest.title}</span>
              </button>
            )}
            {editable && (
              <div className="relative" ref={menuRef}>
                <button type="button" aria-label="Flere valg for lista" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="flex h-12 w-12 items-center justify-center rounded-full text-soft hover:bg-white/[0.06]">
                  <MoreIcon width={20} height={20} />
                </button>
                {menu && (
                  <ul role="menu" className="absolute right-0 top-12 z-20 m-0 w-52 max-w-[calc(100vw-32px)] lg:left-0 lg:right-auto list-none rounded-xl bg-[#15181F] p-1.5 shadow-2xl">
                    {(
                      [
                        ['Gi nytt navn', () => setRenaming(true)],
                        ['Farge', () => setPicking(true)],
                        [v.playlist?.icon ? 'Bytt ikon …' : 'Ikon …', () => setPickingIcon(true)],
                        ...(v.kind === 'manual'
                          ? ([
                              [v.playlist?.cover ? 'Bytt cover …' : 'Eget cover …', () => coverInput.current?.click()],
                              ...(v.playlist?.cover ? [['Fjern eget cover', () => void usePlaylists.getState().removeCover(id).catch(toastError)]] : [])
                            ] as Array<[string, () => void]>)
                          : []),
                        ...(v.kind === 'manual'
                          ? (([null, 'album', 'set'] as const)
                              .filter((pl) => (v.playlist?.plan ?? null) !== pl)
                              .map((pl) => [`Gjør til ${PLAN_NAMES[pl ?? 'none'].toLowerCase()}`, () => void usePlaylists.getState().setPlan(id, pl).catch(toastError)]) as Array<[string, () => void]>)
                          : []),
                        ['Dupliser', () => void usePlaylists.getState().duplicate(v.playlist!).then((p) => useToast.getState().show(`Lagde «${p.name}»`)).catch(toastError)],
                        ['Slett …', () => setConfirmDelete(true)]
                      ] as Array<[string, () => void]>
                    ).map(([label, run]) => (
                      <li key={label} role="none">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(false);
                            run();
                          }}
                          className={`flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm hover:bg-white/[0.06] lg:min-h-9 ${label.startsWith('Slett') ? 'text-[#FF8A7A]' : 'text-ink'}`}
                        >
                          {label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {confirmDelete && v.playlist && (
        <div role="alertdialog" aria-labelledby="gv-del-h" className="relative mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#FF8A7A]/40 bg-[#FF8A7A]/[0.06] p-3">
          <span id="gv-del-h" className="min-w-0 flex-1 text-sm text-ink-strong">
            Slette «{v.name}»? Låtene blir liggende i hvelvet.
          </span>
          <button type="button" onClick={() => setConfirmDelete(false)} className="h-10 rounded-full px-4 text-sm text-muted">
            Avbryt
          </button>
          <button
            type="button"
            onClick={async () => {
              const snapshot = v.playlist!;
              try {
                await usePlaylists.getState().remove(id);
                onClosed();
                useToast.getState().show(`Slettet «${snapshot.name}»`, { label: 'Angre', run: () => void usePlaylists.getState().restore(snapshot).catch(toastError) });
              } catch (err) {
                toastError(err);
              }
            }}
            className="h-10 rounded-full bg-[#FF8A7A] px-4 text-sm font-semibold text-[#1A0704]"
          >
            Slett
          </button>
        </div>
      )}
      {pickingIcon && v.playlist && (
        <IconPicker
          value={v.playlist.icon ?? null}
          hasCover={!!v.playlist.cover}
          onClose={() => setPickingIcon(false)}
          onPick={(icon) => {
            setPickingIcon(false);
            void usePlaylists.getState().setIcon(id, icon).catch(toastError);
          }}
        />
      )}
      {picking && v.playlist && (
        <ColorPicker
          value={v.playlist.color}
          onClose={() => setPicking(false)}
          onPick={(colorId) => {
            setPicking(false);
            void usePlaylists.getState().setColor(id, colorId).catch(toastError);
          }}
        />
      )}

      <div className="relative mt-6">
        {v.kind === 'manual' && missingOnly ? (
          <MissingMaster v={v} onPlay={play} />
        ) : v.kind === 'manual' ? (
          <ManualRows v={v} playingId={isNow ? (nowKey ?? undefined) : undefined} onPlay={play} queueLen={queue.length} vctx={vctx} />
        ) : (
          <ol className="m-0 list-none p-0">
            {v.assets.length === 0 && <li className="text-sm text-muted">Ingen treff ennå.</li>}
            {v.assets.map((a, i) => (
              <li key={a.manifest.id}>
                <EntryButton a={a} i={i} current={isNow && nowKey === v.keys[i]} onPlay={() => play(i)} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function RenameForm({ p, onDone }: { p: Playlist; onDone: () => void }) {
  const [name, setName] = useState(p.name);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void usePlaylists.getState().rename(p.id, name.trim()).catch(toastError);
        onDone();
      }}
    >
      <label htmlFor="gv-rename" className="sr-only">
        Nytt navn
      </label>
      <input id="gv-rename" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onDone()} className="h-12 min-w-0 flex-1 rounded-xl border border-white/15 bg-surface px-3 text-lg text-ink-strong focus:border-accent/60 focus:outline-none" />
      <button type="submit" className="h-12 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent">
        Lagre
      </button>
    </form>
  );
}

function EntryButton({ a, i, current, onPlay, children }: { a: LoadedAsset; i: number; current: boolean; onPlay: (e: MouseEvent) => void; children?: ReactNode }) {
  const m = a.manifest;
  return (
    <div className={`flex min-h-[60px] items-center gap-3 rounded-xl px-1.5 ${current ? 'bg-white/[0.04]' : ''}`}>
      <button type="button" data-play onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Spill ${m.title}`}>
        <span className="tabular w-5 flex-none text-right text-xs text-muted">{current ? <span className="text-accent">▶</span> : i + 1}</span>
        <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={44} rounded={6} draft={isDraft(m)} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate text-[15px] font-semibold lg:text-sm ${current ? 'text-accent' : 'text-ink-strong'}`}>
            {m.title}<DraftBadge m={m} className="ml-1.5" />
          </span>
          <span className="truncate text-xs text-muted">{[m.variant ? variantName(a) : null, m.kind === 'set' ? 'Live-sett' : null, m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="tabular text-xs text-muted">{formatTime(m.durationMs)}</span>
      </button>
      {children}
    </div>
  );
}

/**
 * Manuelle lister.
 * Mobil: hold inne og dra for å flytte, sveip til venstre for å fjerne (med angre).
 * Desktop: dra og slipp for å flytte, klikk/Ctrl/Shift for å velge, Delete fjerner (med angre).
 */
function ManualRows({ v, playingId, onPlay, vctx }: { v: ListView; playingId: string | undefined; onPlay: (i: number) => void; queueLen: number; vctx?: VersionCtx }) {
  const listRef = useRef<HTMLOListElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const p = v.playlist!;
  const rows = v.rows;
  const playIndexOf = (entryId: string) => v.keys.indexOf(entryId);

  const removeWithUndo = async (ids: string[]) => {
    const removed = rows.map((r, index) => ({ entry: r.entry, index })).filter((r) => ids.includes(r.entry.id));
    if (!removed.length) return;
    setSelected([]);
    try {
      await usePlaylists.getState().removeEntries(p.id, ids);
      useToast.getState().show(removed.length === 1 ? `Fjernet ${rows[removed[0]!.index]!.asset?.manifest.title ?? 'låta'}` : `Fjernet ${removed.length} låter`, {
        label: 'Angre',
        run: () => void usePlaylists.getState().restoreEntries(p.id, removed).catch(toastError)
      });
    } catch (err) {
      toastError(err);
    }
  };

  // Delete/Backspace fjerner valgte (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
        e.preventDefault();
        void removeWithUndo(selected);
      } else if (e.key === 'Escape') setSelected([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const touch = useTouchReorder(
    listRef,
    {
      attr: 'entry',
      onMove: (id, before) => void usePlaylists.getState().move(p.id, id, before).catch(toastError),
      onSwipe: (id) => void removeWithUndo([id]),
      setDropBefore
    },
    [p.id]
  );

  const select = (entryId: string, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const ids = rows.map((r) => r.entry.id);
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(entryId)].sort((x, y) => x - y) as [number, number];
      setSelected(ids.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(entryId) ? s.filter((x) => x !== entryId) : [...s, entryId]));
      setAnchor(entryId);
    } else {
      setSelected([entryId]);
      setAnchor(entryId);
    }
  };

  if (rows.length === 0) return <p className="text-sm text-muted">Tom liste. Legg til låter med ⋯ på en låt{' '}<span className="hidden lg:inline">, eller dra dem hit fra katalogen</span>.</p>;

  return (
    <>
      <p className="m-0 mb-2 text-[11px] text-muted lg:hidden">Hold inne og dra for å flytte · sveip til venstre for å fjerne</p>
      <p className="m-0 mb-2 hidden text-[11px] text-muted lg:block">Dra for å flytte · Ctrl/Shift-klikk for å velge flere · Delete fjerner · dobbeltklikk spiller</p>
      <ol ref={listRef} className="m-0 list-none p-0" onDragOver={(e) => dragId && e.preventDefault()} onDrop={() => dragId && dropBefore === null && void usePlaylists.getState().move(p.id, dragId, null).catch(toastError)}>
        {rows.map((r, i) => {
          const id = r.entry.id;
          const isTouched = touch?.id === id;
          const style: CSSProperties = isTouched ? { transform: touch!.mode === 'drag' ? `translateY(${touch!.dy}px) scale(1.02)` : `translateX(${touch!.dx}px)`, zIndex: 5, position: 'relative', background: '#15181F', borderRadius: 12, boxShadow: touch!.mode === 'drag' ? '0 10px 30px rgba(0,0,0,.5)' : undefined } : {};
          const showLine = (dragId || touch?.mode === 'drag') && dropBefore === id && (dragId ?? touch?.id) !== id;
          return (
            <li
              key={id}
              data-entry={id}
              draggable
              onDragStart={(e) => {
                setDragId(id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropBefore(undefined);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropBefore(e.clientY < rect.top + rect.height / 2 ? id : (rows[i + 1]?.entry.id ?? null));
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragId && dropBefore !== undefined && dropBefore !== dragId) void usePlaylists.getState().move(p.id, dragId, dropBefore).catch(toastError);
                setDragId(null);
                setDropBefore(undefined);
              }}
              onClick={(e) => {
                // Avspillingsknappen i raden håndterer klikket selv (velg på desktop, spill på mobil).
                if ((e.target as HTMLElement).closest('button,select')) return;
                select(id, e);
              }}
              onDoubleClick={() => r.asset && onPlay(playIndexOf(id))}
              onContextMenu={(e) => {
                // Desktop: høyreklikk = låtmenyen, med lista sine egne valg (låsing, fjern)
                if (!r.asset) return;
                e.preventDefault();
                (e.currentTarget.querySelector('[data-list-more]') as HTMLButtonElement | null)?.dispatchEvent(new CustomEvent('gv-open', { detail: { x: e.clientX, y: e.clientY } }));
              }}
              aria-selected={selected.includes(id)}
              className={`relative select-none ${selected.includes(id) ? 'rounded-xl bg-white/[0.06] ring-1 ring-white/10' : ''} ${dragId === id ? 'opacity-40' : ''}`}
              style={style}
            >
              {showLine && <span aria-hidden="true" className="absolute inset-x-2 -top-px h-0.5 rounded" style={{ background: v.color.primary, boxShadow: neonGlow(v.color.primary) }} />}
              {isTouched && touch!.mode === 'swipe' && (
                <span aria-hidden="true" className="absolute inset-y-0 right-0 flex items-center gap-1 pr-4 text-xs font-semibold text-[#FF8A7A]" style={{ transform: `translateX(${-touch!.dx}px)` }}>
                  <TrashIcon width={16} height={16} /> Fjern
                </span>
              )}
              {r.asset ? (
                <EntryButton a={r.asset} i={i} current={playingId === id} onPlay={(e) => (isDesktop() && e.detail > 0 ? select(id, e) : onPlay(playIndexOf(id)))}>
                  <EntryControls p={p} r={r} vctx={vctx} onRemove={() => void removeWithUndo([id])} />
                </EntryButton>
              ) : (
                <div className="flex min-h-[60px] items-center gap-3 rounded-xl px-1.5 opacity-70">
                  <span className="tabular w-5 flex-none text-right text-xs text-muted">{i + 1}</span>
                  <span className="flex h-11 w-11 flex-none items-center justify-center rounded-md border border-dashed border-white/15 text-muted">?</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold text-muted line-through">{r.track?.main.manifest.title ?? r.entry.slug}</span>
                    <span className="truncate text-xs text-[#FFB4A8]">Utilgjengelig: {r.reason}</span>
                  </span>
                  <EntryControls p={p} r={r} vctx={vctx} onRemove={() => void removeWithUndo([id])} />
                </div>
              )}
            </li>
          );
        })}
        {dragId && (
          <li
            aria-hidden="true"
            className="h-8"
            onDragOver={(e) => {
              e.preventDefault();
              setDropBefore(null);
            }}
          >
            {dropBefore === null && <span className="mx-2 mt-1 block h-0.5 rounded" style={{ background: v.color.primary, boxShadow: neonGlow(v.color.primary) }} />}
          </li>
        )}
      </ol>
    </>
  );
}

/**
 * Låsen per oppføring (pkt. 13): følg nyeste, lås variant, eller lås en bestemt versjon.
 * Desktop: nedtrekksliste og fjern-knapp. Mobil: ⋯ åpner et ark med de samme valgene + Fjern.
 */
function EntryControls({ p, r, vctx, onRemove }: { p: Playlist; r: ResolvedEntry<LoadedAsset>; vctx?: VersionCtx; onRemove: () => void }) {
  const t = r.track;
  const [sheet, setSheet] = useState(false);
  const options = t && vctx ? lockOptions(t, vctx.index) : [];
  const current = lockValue(r.entry.variant, r.entry.version);
  // Står den låste versjonen ikke lenger i indeksen, vises den likevel som valgt (med forklaring i raden).
  const all = options.some((o) => o.value === current) ? options : [...options, { value: current, label: `v${r.entry.version} · finnes ikke`, variant: r.entry.variant, version: r.entry.version }];
  const choose = (value: string) => {
    const o = all.find((x) => x.value === value);
    if (o) void usePlaylists.getState().setLock(p.id, r.entry.id, o.variant, o.version).catch(toastError);
  };
  /** Valg som bare gjelder denne lista, lagt til i låtmenyen (del 11). */
  const listExtras = (): ExtraAction[] => [
    ...(all.length > 1 ? [{ label: 'Låsing i lista', options: all.map((o) => ({ label: o.label, checked: o.value === current, run: () => choose(o.value) })) }] : []),
    { label: 'Fjern fra lista', danger: true, run: onRemove }
  ];
  const moreRef = useRef<HTMLButtonElement>(null);
  const extrasRef = useRef(listExtras);
  extrasRef.current = listExtras;
  useEffect(() => {
    const b = moreRef.current;
    if (!b) return;
    const open = (e: Event) => r.asset && useUi.getState().openActions({ assets: [r.asset], context: 'row', extra: extrasRef.current(), anchor: (e as CustomEvent<{ x: number; y: number }>).detail });
    b.addEventListener('gv-open', open);
    return () => b.removeEventListener('gv-open', open);
  }, [r.asset]);
  const lockLabel = r.entry.version != null ? `v${r.entry.version}` : r.entry.variant ? 'låst' : null;
  return (
    <>
      {lockLabel && (
        <span className="flex-none rounded bg-white/[0.04] px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[1px] text-soft" title={all.find((o) => o.value === current)?.label}>
          {lockLabel}
        </span>
      )}
      {all.length > 1 && (
        <label className="hidden items-center lg:flex">
          <span className="sr-only">Versjon for {t?.main.manifest.title ?? r.entry.slug}</span>
          <select value={current} onChange={(e) => choose(e.target.value)} className="h-8 max-w-[190px] rounded-lg border border-white/10 bg-sunken px-2 text-[11px] text-soft focus:outline-none">
            {all.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" onClick={onRemove} aria-label="Fjern fra lista" title="Fjern (Delete)" className="hidden h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-white/[0.06] hover:text-[#FF8A7A] lg:flex">
        <TrashIcon width={16} height={16} />
      </button>
      <button ref={moreRef} data-list-more type="button" onClick={() => (r.asset ? useUi.getState().openActions({ assets: [r.asset], context: 'row', extra: listExtras() }) : setSheet(true))} aria-label={`Valg for ${t?.main.manifest.title ?? r.entry.slug}`} className="flex h-10 w-9 flex-none items-center justify-center rounded-full text-muted active:bg-white/[0.06] lg:hidden">
        <MoreIcon width={18} height={18} />
      </button>
      <span aria-hidden="true" className="hidden h-9 w-6 items-center justify-center text-muted/70 lg:flex lg:cursor-grab">
        <GripIcon width={16} height={16} />
      </span>
      {sheet &&
        createPortal(
        <div className="fixed inset-0 z-50 bg-black/55 lg:hidden" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setSheet(false); }}>
          <div role="dialog" aria-modal="true" aria-label="Versjon og variant" className="fixed inset-x-0 bottom-0 max-h-[75svh] overflow-y-auto rounded-t-2xl bg-surface px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-2">
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15" />
            <h2 className="m-0 px-3 pb-2 text-sm font-semibold text-ink-strong">{t?.main.manifest.title ?? r.entry.slug}</h2>
            <ul role="radiogroup" aria-label="Spill" className="m-0 list-none p-0">
              {all.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={o.value === current}
                    onClick={() => {
                      setSheet(false);
                      choose(o.value);
                    }}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-ink-strong active:bg-white/[0.08]"
                  >
                    <span aria-hidden="true" className={`h-4 w-4 flex-none rounded-full border ${o.value === current ? 'border-accent bg-accent' : 'border-white/30'}`} />
                    {o.label}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => {
                setSheet(false);
                onRemove();
              }}
              className="mt-1 flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-[#FF8A7A] active:bg-white/[0.08]"
            >
              <TrashIcon width={16} height={16} /> Fjern fra lista
            </button>
          </div>
        </div>,
          document.body
        )}
    </>
  );
}

export type { PlaylistEntry };

// ---------------------------------------------------------------- Del 16: Album- og settplaner

const FLOW_COLOR: Record<Flow, string> = { green: '#3DDC84', yellow: '#F5C84B', red: '#FF6B5A', unknown: 'rgba(255,255,255,0.25)' };
const FLOW_TEXT: Record<Flow, string> = { green: 'harmonisk', yellow: '±1 på hjulet', red: 'brudd', unknown: 'ukjent' };

/** «7 av 10 mastret», total tid og BPM-/Camelot-flyt mellom låtene, med filteret «Mangler master». */
function PlanSummary({ v, missingOnly, onMissingOnly }: { v: ListView; missingOnly: boolean; onMissingOnly: (b: boolean) => void }) {
  const rows = v.assets.map((a) => ({ status: isDraft(a.manifest) ? ('draft' as const) : ('release' as const), durationMs: a.manifest.durationMs, bpm: a.manifest.bpm, camelot: a.manifest.key?.camelot ?? null, title: a.manifest.title }));
  const st = planStats(rows);
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-xl bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-ink-strong" data-testid="plan-status">
          {st.mastered} av {st.total} mastret
        </span>
        <span className="h-1.5 w-32 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${st.total ? (st.mastered / st.total) * 100 : 0}%` }} />
        </span>
        <span className="font-mono text-xs text-muted">{formatListDuration(st.durationMs)}</span>
        <label className="ml-auto flex items-center gap-2 text-xs text-soft">
          <input type="checkbox" checked={missingOnly} onChange={(e) => onMissingOnly(e.target.checked)} />
          Mangler master ({st.total - st.mastered})
        </label>
      </div>
      {st.flows.length > 0 && (
        <ol aria-label="Flyt mellom låtene" className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-soft" title={r.title}>
                {r.camelot ?? '?'}
                {r.bpm ? `·${Math.round(r.bpm)}` : ''}
              </span>
              {i < st.flows.length && <span aria-label={FLOW_TEXT[st.flows[i]!]} title={FLOW_TEXT[st.flows[i]!]} className="h-1.5 w-4 rounded-full" style={{ background: FLOW_COLOR[st.flows[i]!] }} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Filteret «Mangler master»: bare utkastene i planen. */
function MissingMaster({ v, onPlay }: { v: ListView; onPlay: (i: number) => void }) {
  const items = v.assets.map((a, i) => ({ a, i })).filter(({ a }) => isDraft(a.manifest));
  if (!items.length) return <p className="text-sm text-muted">Alle låtene i planen er mastret.</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map(({ a, i }) => (
        <li key={`${a.manifest.id}-${i}`}>
          <button type="button" onClick={() => onPlay(i)} className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.03]">
            <span className="w-6 text-right font-mono text-xs text-muted">{i + 1}</span>
            <CoverArt src={assetUrl(a, a.manifest.files.coverThumb)} palette={a.manifest.palette} title={a.manifest.title} size={40} rounded={6} draft />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-strong">
              {a.manifest.title}<DraftBadge m={a.manifest} className="ml-1.5" />
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
