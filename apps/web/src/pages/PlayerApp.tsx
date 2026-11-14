import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatTime, GOLD_FALLBACK, paletteToCssVars, sectionAt, sectionsOf } from '@gv/shared/web';
import { Logo } from '../components/Brand';
import { CommandPalette } from '../components/CommandPalette';
import { CoverArt } from '../components/CoverArt';
import { addWithUndo, AddToPlaylistSheet, DRAG_ITEMS, PlaylistDetail, PlaylistsOverview, SidebarPlaylists, Toast } from '../components/Playlists';
import {
  ChevronDownIcon,
  LibraryIcon,
  ListIcon,
  MoreIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  PulseIcon,
  SearchIcon,
  SectionNextIcon,
  SectionPrevIcon,
  StudioIcon,
  VolumeIcon
} from '../components/Icons';
import { SpectralWaveform } from '../components/SpectralWaveform';
import { assetUrl, groupTracks, loadVersion, useCatalog, variantName, versionKey, type LoadedAsset, type Track } from '../lib/catalog';
import { savedPosition, storedQueue, usePlayer } from '../lib/player';
import { itemFor, mostRecentTarget, toastError, usePlaylists, usePlaylistSync, useToast, type AddItem } from '../lib/playlists';
import { useSubBass } from '../lib/useSubBass';
import { useVersionCtx } from '../lib/versions';
import { QueuePanel, TrackActionsHost } from '../components/TrackActions';
import { useUi } from '../lib/ui';
import { fromStored } from '@gv/shared/web';

type View = 'catalog' | 'sets' | 'playlists';

type Filter = 'all' | 'track' | 'set';

/**
 * Din egen spiller. Mobil: én tommel – bunnmeny, flytende mini-spiller, fullskjerm ved trykk.
 * Desktop: sidebar, presisjonstabell og transport-dock. Gull er rammen; det som spilles farger rommet.
 */
export function PlayerApp() {
  const { assets, index: catalogIndex, loading } = useCatalog();
  const tracks = useMemo(() => groupTracks(assets), [assets]);
  const [view, setView] = useState<View>('catalog');
  const [filter, setFilter] = useState<Filter>('all');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [listId, setListId] = useState<string | null>(null);
  const addSheet = useUi((s) => s.addSheet);
  const openActions = useUi((s) => s.openActions);
  /** Desktop: valgte låter i tabellen (Ctrl/Shift-klikk). Mobil: velgemodus (hold inne på en låt). */
  const [selected, setSelected] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const { queue, index, playing, started, playFrom, switchVariant, toggle, nextSection, prevSection } = usePlayer();
  const cur = queue[index];
  const root = useRef<HTMLDivElement>(null);
  useSubBass(root, cur, playing);
  usePlaylistSync();
  const vctx = useVersionCtx(catalogIndex, usePlaylists((s) => s.playlists));

  const openList = (id: string | null) => {
    setListId(id);
    setView('playlists');
    setFull(false);
    window.scrollTo({ top: 0 });
  };
  /** Det du ser: en låt som spilles i en annen variant, legges til med den varianten. */
  const shownAsset = (t: Track) => (cur?.manifest.slug === t.slug ? cur : t.main);
  const openSheet = (assetsToAdd: LoadedAsset[], anchor: { x: number; y: number } | null = null) => {
    if (assetsToAdd.length) useUi.getState().openAddSheet({ assets: assetsToAdd, anchor });
  };
  /** «⋯» for låta som spilles (fullskjerm, minispiller, dokken, Shift+F10). */
  const openNowActions = (anchor: { x: number; y: number } | null = null) => {
    const now = usePlayer.getState().queue[usePlayer.getState().index];
    if (now) openActions({ assets: [now], context: 'now', anchor });
  };

  // Køen fra forrige gang: legges tilbake pauset når katalogen er lastet (eldre versjoner hentes ved behov).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || loading || !catalogIndex.length) return;
    restored.current = true;
    const stored = storedQueue();
    if (!stored || usePlayer.getState().queue.length) return;
    const latest = new Map(assets.map((a) => [versionKey(a.manifest.slug, a.manifest.variant, a.manifest.version), a]));
    void Promise.all(
      stored.items.map(async (it) => {
        const key = versionKey(it.slug, it.variant, it.version);
        if (latest.has(key)) return;
        const e = catalogIndex.find((x) => x.slug === it.slug && (x.variant ?? null) === it.variant && x.version === it.version);
        if (e) latest.set(key, await loadVersion(e).catch(() => undefined as never));
      })
    ).then(() => {
      const r = fromStored(stored, (slug, variant, version) => latest.get(versionKey(slug, variant, version)));
      if (r) usePlayer.getState().restoreQueue(r.queue, r.index, r.positionMs);
    });
  }, [loading, assets, catalogIndex]);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected([]);
  };
  // Mobil: tilbake-knappen avslutter velgemodus
  useEffect(() => {
    if (!selectMode) return;
    history.pushState({ gvSelect: true }, '');
    const onPop = () => exitSelectMode();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [selectMode]);

  const vars = paletteToCssVars(started && cur ? cur.manifest.palette : GOLD_FALLBACK) as CSSProperties;

  // Tastatur: Ctrl/Cmd+K søk, mellomrom spill/pause, Shift+←/→ forrige/neste del, Esc lukker fullskjerm
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        // Ctrl+Shift+P: låta som spilles nå → sist brukte liste
        e.preventDefault();
        const now = usePlayer.getState().queue[usePlayer.getState().index];
        if (!now) return useToast.getState().show('Ingen låt spilles nå');
        const target = mostRecentTarget(usePlaylists.getState().playlists);
        if (target) void addWithUndo(target, [itemFor(now)]).catch(toastError);
        else openSheet([now]);
      } else if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        // Shift+F10 / menytasten: «⋯» for låta som spilles, ved ⋯-knappen i dokken
        e.preventDefault();
        const r = document.getElementById('gv-dock-more')?.getBoundingClientRect();
        openNowActions(r ? { x: r.left, y: r.top - 360 } : null);
      } else if (typing) return;
      else if (e.key === ' ' && t?.tagName !== 'BUTTON' && t?.tagName !== 'A') {
        e.preventDefault();
        toggle();
      } else if (e.shiftKey && e.key === 'ArrowRight') nextSection();
      else if (e.shiftKey && e.key === 'ArrowLeft') prevSection();
      else if (e.key === 'Escape') {
        setFull(false);
        setSelected([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, nextSection, prevSection]);

  const visible = tracks.filter((t) => (view === 'sets' ? t.main.manifest.kind === 'set' : filter === 'all' || t.main.manifest.kind === filter));

  /** Spill en låt (valgfri variant og posisjon). Køen blir listen du ser. */
  const play = (t: Track, variant?: LoadedAsset, atMs?: number) => {
    const chosen = variant ?? (cur?.manifest.slug === t.slug ? cur : t.main);
    if (cur && cur.manifest.slug === t.slug && chosen.manifest.id !== cur.manifest.id && atMs == null) {
      switchVariant(chosen);
      if (!playing) toggle();
      return;
    }
    const list = visible.map((x) => (x.slug === t.slug ? chosen : x.main));
    playFrom(list, list.indexOf(chosen), atMs);
  };
  const trackOf = (a: LoadedAsset | undefined) => (a ? tracks.find((t) => t.slug === a.manifest.slug) : undefined);

  /** Desktop: klikk = velg én, Ctrl = legg til/fjern, Shift = område. */
  const selectRow = (slug: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const order = visible.map((t) => t.slug);
    setSelected((s) => {
      if (e.shiftKey && s.length) {
        const [a, b] = [order.indexOf(s[s.length - 1]!), order.indexOf(slug)].sort((x, y) => x - y) as [number, number];
        return [...new Set([...s, ...order.slice(a, b + 1)])];
      }
      if (e.ctrlKey || e.metaKey) return s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug];
      return [slug];
    });
  };
  /** Låtene en handling gjelder: de valgte hvis raden er blant dem, ellers bare raden. */
  const assetsFor = (slug: string) => {
    const slugs = selected.includes(slug) ? selected : [slug];
    return visible.filter((t) => slugs.includes(t.slug)).map(shownAsset);
  };
  const toggleMobileSelect = (slug: string) => setSelected((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug]));

  return (
    <div ref={root} className="relative min-h-[100svh] bg-obsidian text-ink lg:grid lg:grid-cols-[240px_minmax(0,1fr)]" style={vars}>
      <AmbientGlow />
      <Sidebar
        view={view}
        setView={(v) => {
          setView(v);
          setListId(null);
        }}
        onSearch={() => setPaletteOpen(true)}
      >
        <SidebarPlaylists tracks={tracks} activeId={view === 'playlists' ? listId : null} onOpen={openList} />
      </Sidebar>

      <main className="relative z-10 min-w-0 px-5 pb-[168px] pt-5 lg:px-8 lg:pb-[132px] lg:pt-7">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div className="lg:hidden">
            <Logo size={36} />
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-10 w-full max-w-[460px] items-center gap-3 rounded-full border border-white/[0.08] bg-surface/70 px-4 text-left text-sm text-muted hover:border-white/15 lg:flex"
          >
            <SearchIcon width={16} height={16} />
            <span className="flex-1">Søk i tittel, BPM, toneart …</span>
            <kbd className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-champagne">Ctrl K</kbd>
          </button>
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Søk" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 text-champagne lg:hidden">
            <SearchIcon width={20} height={20} />
          </button>
        </header>

        {loading ? (
          <p className="text-sm text-muted">Åpner hvelvet …</p>
        ) : tracks.length === 0 ? (
          <EmptyState />
        ) : view === 'playlists' ? (
          listId ? (
            <PlaylistDetail id={listId} tracks={tracks} vctx={vctx} onBack={() => setListId(null)} onClosed={() => setListId(null)} />
          ) : (
            <PlaylistsOverview tracks={tracks} onOpen={openList} vctx={vctx} />
          )
        ) : view === 'catalog' ? (
          <>
            {visible[0] && filter === 'all' && <Hero t={tracks[0]!} onPlay={(v, at) => play(tracks[0]!, v, at)} />}
            <Pills value={filter} onChange={setFilter} />
            <TrackTable
              tracks={visible}
              onPlay={play}
              selected={selected}
              onSelect={selectRow}
              itemsFor={(slug) => assetsFor(slug).map(itemFor)}
              onContext={(slug, at) => {
                if (!selected.includes(slug)) setSelected([slug]);
                openActions({ assets: selected.includes(slug) ? assetsFor(slug) : [shownAsset(visible.find((t) => t.slug === slug)!)], context: 'row', anchor: at });
              }}
            />
            <TrackList
              tracks={visible}
              onPlay={play}
              onMore={(t) => openActions({ assets: [shownAsset(t)], context: 'row' })}
              onSwipeRight={(t) => {
                // Mobil: sveip til høyre = legg til i sist brukte liste (med angre). Ingen liste ennå → arket.
                const target = mostRecentTarget(usePlaylists.getState().playlists);
                if (target) void addWithUndo(target, [itemFor(shownAsset(t))]).catch(toastError);
                else openSheet([shownAsset(t)]);
              }}
              selectMode={selectMode}
              selected={selected}
              onLongPress={(t) => {
                setSelectMode(true);
                setSelected([t.slug]);
              }}
              onToggle={(t) => toggleMobileSelect(t.slug)}
            />
          </>
        ) : (
          <SetsView sets={visible} tracks={tracks} onPlay={play} />
        )}
      </main>

      {cur && <Dock cur={cur} track={trackOf(cur)} onVariant={(v) => switchVariant(v)} tracks={tracks} onPlay={play} onMore={openNowActions} />}
      {cur && !selectMode && <MiniPlayer cur={cur} onOpen={() => setFull(true)} onMore={() => openNowActions()} />}
      {selectMode && (
        <div className="fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-30 flex items-center gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => history.back()}
            className="h-12 rounded-full border border-white/15 bg-[rgba(14,16,21,0.95)] px-4 text-sm text-ink backdrop-blur-xl"
          >
            Avbryt
          </button>
          <button
            type="button"
            disabled={!selected.length}
            onClick={() => openSheet(visible.filter((t) => selected.includes(t.slug)).map(shownAsset))}
            className="h-12 flex-1 rounded-full bg-gold text-sm font-semibold text-[#120D02] shadow-[0_8px_24px_rgba(240,192,48,0.3)] disabled:opacity-50"
          >
            Legg til i spilleliste ({selected.length})
          </button>
        </div>
      )}
      <BottomNav
        view={view}
        setView={(v) => {
          setView(v);
          setListId(null);
        }}
      />
      {full && cur && <FullPlayer cur={cur} track={trackOf(cur)} tracks={tracks} onClose={() => setFull(false)} onPlay={play} onMore={() => openNowActions()} />}
      {addSheet && (
        <AddToPlaylistSheet
          items={addSheet.assets.map(itemFor)}
          label={addSheet.assets.length === 1 ? addSheet.assets[0]!.manifest.title + (addSheet.assets[0]!.manifest.variant ? ` · ${variantName(addSheet.assets[0]!)}` : '') : `${addSheet.assets.length} låter`}
          variantLabel={addSheet.assets.length === 1 && addSheet.assets[0]!.manifest.variant ? variantName(addSheet.assets[0]!) : null}
          anchor={addSheet.anchor ?? null}
          onClose={() => {
            useUi.getState().closeAddSheet();
            if (selectMode) history.back();
          }}
        />
      )}
      <TrackActionsHost tracks={tracks} index={catalogIndex} onPlay={play} />
      <QueuePanel />
      <Toast />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        assets={assets}
        onPick={(list, i) => {
          const a = list[i]!;
          const t = trackOf(a);
          if (t) play(t, a);
        }}
        onSaveSmart={async (name, query) => {
          try {
            const p = await usePlaylists.getState().createSmart(name, query);
            useToast.getState().show(`Lagret smart liste «${p.name}»`, { label: 'Åpne', run: () => openList(p.id) });
          } catch (err) {
            toastError(err);
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Ramme

/** Rolig glød øverst i rommet i farge fra det som spilles; puster med sub-bassen. */
function AmbientGlow() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-1/2 top-[-260px] z-0 h-[620px] w-[min(1100px,140vw)] -translate-x-1/2 rounded-full transition-[background] duration-1000"
      style={{
        background: 'radial-gradient(closest-side, var(--glow), var(--glow-2) 55%, transparent)',
        opacity: 'calc(0.35 + var(--sub, 0) * 0.3)'
      }}
    />
  );
}

function Sidebar({ view, setView, onSearch, children }: { view: View; setView: (v: View) => void; onSearch: () => void; children?: ReactNode }) {
  const item = (id: View, label: string, Icon: typeof LibraryIcon) => {
    const active = view === id;
    return (
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => setView(id)}
        className={`flex min-h-11 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm ${active ? 'bg-gold/[0.08] font-semibold text-gold' : 'text-muted hover:text-ink-strong'}`}
      >
        <Icon width={18} height={18} />
        {label}
      </button>
    );
  };
  return (
    <aside className="sticky top-0 z-10 hidden h-[100svh] flex-col gap-7 border-r border-white/[0.06] bg-sunken/90 px-[18px] pb-[132px] pt-6 lg:flex">
      <Logo size={44} />
      <nav aria-label="Hovedmeny" className="flex flex-col gap-0.5">
        {item('catalog', 'Katalog', LibraryIcon)}
        {item('sets', 'Live-sett', PulseIcon)}
        <button type="button" onClick={onSearch} className="flex min-h-11 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm text-muted hover:text-ink-strong">
          <SearchIcon width={18} height={18} />
          Søk
        </button>
        <a href="/studio" className="flex min-h-11 items-center gap-2.5 rounded-[10px] px-3 text-sm text-muted no-underline hover:text-ink-strong">
          <StudioIcon width={18} height={18} />
          Studio og drops
        </a>
      </nav>
      {children}
      <div className="rounded-xl border border-white/[0.06] bg-surface p-3.5 text-[11px] leading-relaxed text-muted">
        <span className="block text-xs font-semibold text-ink">Snarveier</span>
        Mellomrom: spill/pause
        <br />
        Shift + ← →: forrige/neste del
        <br />
        Ctrl + K: søk
        <br />
        Ctrl + Shift + P: låta → sist brukte liste
      </div>
    </aside>
  );
}

/** Mobil: fire faner. Søk ligger som knappen øverst til høyre (avklart med Knut), så Lister tar plassen. */
function BottomNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const cls = (active: boolean) => `flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium ${active ? 'text-gold' : 'text-muted'}`;
  return (
    <nav aria-label="Hovedmeny" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-white/[0.07] bg-sunken/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <button type="button" className={cls(view === 'catalog')} aria-current={view === 'catalog' ? 'page' : undefined} onClick={() => setView('catalog')}>
        <LibraryIcon width={22} height={22} />
        Katalog
      </button>
      <button type="button" className={cls(view === 'sets')} aria-current={view === 'sets' ? 'page' : undefined} onClick={() => setView('sets')}>
        <PulseIcon width={22} height={22} />
        Live-sett
      </button>
      <button type="button" className={cls(view === 'playlists')} aria-current={view === 'playlists' ? 'page' : undefined} onClick={() => setView('playlists')}>
        <ListIcon width={22} height={22} />
        Lister
      </button>
      <a href="/studio" className={`${cls(false)} no-underline`}>
        <StudioIcon width={22} height={22} />
        Studio
      </a>
    </nav>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-gold/30 p-8 text-center text-sm text-muted">
      Hvelvet er tomt. Kjør <code className="text-ink">pnpm make-fixtures</code> og <code className="text-ink">pnpm gh-ingest fixtures/blue-fire</code>, eller bounce til eksportmappa med <code className="text-ink">pnpm gh-watch</code>.
    </div>
  );
}

// ---------------------------------------------------------------- Katalog

function Hero({ t, onPlay }: { t: Track; onPlay: (v?: LoadedAsset, atMs?: number) => void }) {
  const m = t.main.manifest;
  const { queue, index, positionMs } = usePlayer();
  const isCur = queue[index]?.manifest.slug === t.slug;
  const shown = isCur ? queue[index]! : t.main;
  return (
    <section
      aria-label="Nyeste i hvelvet"
      className="relative mb-7 overflow-hidden rounded-[22px] border border-white/[0.07] bg-surface/80 p-5 lg:p-6"
      style={paletteToCssVars(m.palette) as CSSProperties}
    >
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 h-[420px] w-[420px] rounded-full" style={{ background: 'radial-gradient(closest-side, var(--glow), transparent)', opacity: 0.55 }} />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
        <CoverArt src={assetUrl(t.main, m.files.cover)} palette={m.palette} title={m.title} size={168} rounded={14} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="text-[10px] font-semibold tracking-[2px] text-accent">NYESTE I HVELVET</span>
          <h1 className="m-0 font-display text-[34px] font-semibold uppercase leading-none tracking-[1.5px] text-ink-strong lg:text-[44px]">{m.title}</h1>
          <p className="m-0 text-[13px] text-muted">
            {[m.artist, t.variants.length > 1 ? `${t.variants.length} varianter` : null, m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot, formatTime(m.durationMs)].filter(Boolean).join(' · ')}
          </p>
          <div className="mt-1 flex items-center gap-3">
            <button type="button" onClick={() => onPlay()} aria-label={`Spill ${m.title}`} className="flex h-12 items-center gap-2 rounded-full bg-gold px-5 text-sm font-semibold text-[#120D02]">
              <PlayIcon width={18} height={18} />
              Spill
            </button>
            {t.variants.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {t.variants.map((v) => (
                  <button key={v.manifest.id} type="button" onClick={() => onPlay(v)} className="h-9 rounded-full border border-white/10 px-3 text-xs text-ink hover:border-accent">
                    {variantName(v)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-2">
            <SpectralWaveform
              analysis={shown.analysis}
              durationMs={shown.manifest.durationMs}
              progress={isCur ? positionMs / shown.manifest.durationMs : 0}
              active
              unplayedAlpha={isCur ? 0.3 : 0.8}
              height={44}
              markers={shown.manifest.markers}
              showLabels
              onSeek={(r) => onPlay(shown, r * shown.manifest.durationMs)}
              label={`Spol i ${m.title}`}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Pills({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const opts: Array<[Filter, string]> = [
    ['all', 'Alle'],
    ['track', 'Låter'],
    ['set', 'Live-sett']
  ];
  return (
    <div role="group" aria-label="Filter" className="mb-4 flex gap-2 overflow-x-auto pb-1">
      {opts.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`h-9 flex-none rounded-full px-4 text-xs font-semibold ${value === id ? 'bg-gold text-[#120D02]' : 'border border-white/10 bg-surface text-ink hover:border-white/20'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Desktop: presisjonstabell med bølgeform-kolonne for «needle drop». */
function TrackTable({
  tracks,
  onPlay,
  selected,
  onSelect,
  itemsFor,
  onContext
}: {
  tracks: Track[];
  onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void;
  selected: string[];
  onSelect: (slug: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  itemsFor: (slug: string) => AddItem[];
  onContext: (slug: string, at: { x: number; y: number }) => void;
}) {
  const { queue, index, positionMs, playing } = usePlayer();
  const cur = queue[index];
  return (
    <div className="hidden overflow-x-auto lg:block">
      {selected.length > 1 && <p className="m-0 mb-2 text-[11px] text-muted">{selected.length} valgt · dra til en liste i sidemenyen, eller høyreklikk → Legg til i spilleliste · Esc fjerner valget</p>}
      <table className="w-full min-w-[900px] border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-[10px] tracking-[1.5px] text-muted">
            <th scope="col" className="w-10 pb-2 font-semibold">#</th>
            <th scope="col" className="pb-2 font-semibold">TITTEL</th>
            <th scope="col" className="w-[34%] pb-2 font-semibold">BØLGEFORM</th>
            <th scope="col" className="w-20 pb-2 text-right font-semibold">BPM</th>
            <th scope="col" className="w-16 pb-2 text-right font-semibold">KEY</th>
            <th scope="col" className="w-16 pb-2 text-right font-semibold">TID</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t, i) => {
            const isCur = cur?.manifest.slug === t.slug;
            const a = isCur ? cur! : t.main;
            const m = a.manifest;
            return (
              <tr
                key={t.slug}
                draggable
                aria-selected={selected.includes(t.slug)}
                onDragStart={(e) => {
                  if (!selected.includes(t.slug)) onSelect(t.slug, { ctrlKey: false, metaKey: false, shiftKey: false });
                  const items = itemsFor(t.slug);
                  e.dataTransfer.setData(DRAG_ITEMS, JSON.stringify(items));
                  e.dataTransfer.setData('text/plain', items.length > 1 ? `${items.length} låter` : m.title);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button,select,[role="slider"],canvas,input')) return;
                  onSelect(t.slug, e);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContext(t.slug, { x: e.clientX, y: e.clientY });
                }}
                className={`border-t border-white/[0.05] ${selected.includes(t.slug) ? 'bg-white/[0.07] outline outline-1 -outline-offset-1 outline-white/15' : isCur ? 'bg-white/[0.035]' : 'hover:bg-white/[0.02]'}`}
                style={paletteToCssVars(m.palette) as CSSProperties}
              >
                <td className="tabular py-2 text-muted">{isCur && playing ? <span className="text-accent">▶</span> : i + 1}</td>
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => onPlay(t)} aria-label={`Spill ${m.title}`} className="flex-none">
                      <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={40} rounded={6} />
                    </button>
                    <div className="flex min-w-0 flex-col">
                      <button type="button" onClick={() => onPlay(t)} className="truncate text-left font-semibold text-ink-strong hover:underline">
                        {m.title}
                      </button>
                      <VariantSelect t={t} value={a} onChange={(v) => onPlay(t, v)} />
                    </div>
                  </div>
                </td>
                <td className="py-2">
                  <SpectralWaveform
                    analysis={a.analysis}
                    durationMs={m.durationMs}
                    progress={isCur ? positionMs / m.durationMs : 0}
                    active
                    height={30}
                    barPx={3}
                    unplayedAlpha={isCur ? 0.3 : 0.75}
                    markers={m.markers}
                    onSeek={(r) => onPlay(t, a, r * m.durationMs)}
                    label={`Spill ${m.title} fra punktet`}
                  />
                </td>
                <td className="tabular py-2 text-right text-ink">{m.bpm ?? '–'}</td>
                <td className="tabular py-2 text-right font-semibold text-champagne">{m.key?.camelot ?? '–'}</td>
                <td className="tabular py-2 text-right text-muted">{formatTime(m.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VariantSelect({ t, value, onChange }: { t: Track; value: LoadedAsset; onChange: (v: LoadedAsset) => void }) {
  if (t.variants.length < 2) {
    return <span className="text-[11px] text-muted">{t.main.manifest.kind === 'set' ? 'Live-sett' : t.main.manifest.artist ?? 'Groovehouse'}</span>;
  }
  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span className="sr-only">Variant av {t.main.manifest.title}</span>
      <span className="relative inline-flex items-center">
      <select
        value={value.manifest.id}
        onChange={(e) => onChange(t.variants.find((v) => v.manifest.id === e.target.value)!)}
        className="appearance-none bg-transparent pr-4 text-[11px] text-champagne focus:outline-none"
      >
        {t.variants.map((v) => (
          <option key={v.manifest.id} value={v.manifest.id} className="bg-surface text-ink">
            {variantName(v)} · {formatTime(v.manifest.durationMs)}
          </option>
        ))}
      </select>
      <ChevronDownIcon width={12} height={12} className="pointer-events-none absolute right-0 text-champagne" />
      </span>
      <span aria-hidden="true" className="rounded border border-white/10 px-1 text-[9px] tracking-[1px]">{t.variants.length} VARIANTER</span>
    </label>
  );
}

/**
 * Mobil: kompakt liste, én tommel. ⋯ = låthandlinger (del 11).
 * Hold inne = velgemodus. Sveip til høyre = legg til i sist brukte spilleliste (med angre).
 */
function TrackList({
  tracks,
  onPlay,
  onMore,
  onSwipeRight,
  selectMode,
  selected,
  onLongPress,
  onToggle
}: {
  tracks: Track[];
  onPlay: (t: Track) => void;
  onMore: (t: Track) => void;
  onSwipeRight: (t: Track) => void;
  selectMode: boolean;
  selected: string[];
  onLongPress: (t: Track) => void;
  onToggle: (t: Track) => void;
}) {
  const { queue, index, playing } = usePlayer();
  const cur = queue[index];
  const press = useRef<{ timer: number; fired: boolean; x: number; y: number; slug: string; swiping: boolean; dx: number } | null>(null);
  const [swipe, setSwipe] = useState<{ slug: string; dx: number } | null>(null);
  const startPress = (t: Track, x: number, y: number) => {
    if (selectMode) return;
    const p = { timer: 0, fired: false, x, y, slug: t.slug, swiping: false, dx: 0 };
    p.timer = window.setTimeout(() => {
      p.fired = true;
      navigator.vibrate?.(10);
      onLongPress(t);
    }, 450);
    press.current = p;
  };
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  return (
    <ul className="m-0 flex list-none flex-col p-0 lg:hidden">
      {tracks.map((t) => {
        const isCur = cur?.manifest.slug === t.slug;
        const a = isCur ? cur! : t.main;
        const m = a.manifest;
        const meta = [isCur && m.variant ? variantName(a) : null, m.kind === 'set' ? 'Live-sett' : null, m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot, t.variants.length > 1 ? `${t.variants.length} varianter` : null]
          .filter(Boolean)
          .join(' · ');
        const isSel = selected.includes(t.slug);
        return (
          <li key={t.slug} className="flex items-center">
            <button
              type="button"
              onClick={() => {
                if (press.current?.fired) return void (press.current = null);
                if (selectMode) onToggle(t);
                else onPlay(t);
              }}
              onTouchStart={(e) => startPress(t, e.touches[0]!.clientX, e.touches[0]!.clientY)}
              onTouchMove={(e) => {
                const p = press.current;
                if (!p || p.fired) return;
                const tt = e.touches[0]!;
                const dx = tt.clientX - p.x;
                const dy = tt.clientY - p.y;
                if (Math.abs(dx) > 10 || Math.abs(dy) > 10) cancelPress();
                // Sveip til høyre (tydelig vannrett): raden følger fingeren
                if (!selectMode && (p.swiping || (dx > 12 && dx > Math.abs(dy) * 1.5))) {
                  p.swiping = true;
                  p.dx = Math.max(0, dx);
                  setSwipe({ slug: t.slug, dx: p.dx });
                }
              }}
              onTouchEnd={() => {
                cancelPress();
                const p = press.current;
                if (p?.swiping) {
                  if (p.dx > 90) {
                    navigator.vibrate?.(10);
                    onSwipeRight(t);
                  }
                  p.fired = true; // ikke spill låta på klikket som følger
                  setSwipe(null);
                }
              }}
              onContextMenu={(e) => e.preventDefault()}
              aria-pressed={selectMode ? isSel : undefined}
              className={`relative flex min-h-[64px] min-w-0 flex-1 select-none items-center gap-3 rounded-xl px-1.5 text-left [-webkit-touch-callout:none] active:bg-white/[0.05] ${isSel ? 'bg-white/[0.07]' : ''}`}
              style={{ ...(paletteToCssVars(m.palette) as CSSProperties), ...(swipe?.slug === t.slug ? { transform: `translateX(${swipe.dx}px)`, background: '#15181F' } : {}) }}
            >
              {swipe?.slug === t.slug && (
                <span aria-hidden="true" className="absolute inset-y-0 right-full flex items-center whitespace-nowrap pr-3 text-xs font-semibold text-gold" style={{ opacity: Math.min(1, swipe.dx / 90) }}>
                  + Sist brukte liste
                </span>
              )}
              {selectMode && (
                <span aria-hidden="true" className={`flex h-6 w-6 flex-none items-center justify-center rounded-full border text-[13px] font-bold ${isSel ? 'border-gold bg-gold text-[#120D02]' : 'border-white/30'}`}>
                  {isSel ? '✓' : ''}
                </span>
              )}
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={48} rounded={8} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-[15px] font-semibold ${isCur ? 'text-accent' : 'text-ink-strong'}`}>
                  {isCur && playing ? '▶ ' : ''}
                  {m.title}
                </span>
                <span className="truncate text-xs text-muted">{meta}</span>
              </span>
              <span className="tabular text-xs text-muted">{formatTime(m.durationMs)}</span>
            </button>
            {!selectMode && (
              <button type="button" onClick={() => onMore(t)} aria-label={`Flere valg for ${m.title}`} className="flex h-12 w-11 flex-none items-center justify-center rounded-full text-muted active:bg-white/[0.06]">
                <MoreIcon width={18} height={18} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- Live-sett

function SetsView({ sets, tracks, onPlay }: { sets: Track[]; tracks: Track[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void }) {
  const { queue, index, positionMs } = usePlayer();
  const cur = queue[index];
  if (sets.length === 0) return <p className="text-sm text-muted">Ingen live-sett ennå. Legg et sett med live_log.json i eksportmappa.</p>;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="m-0 font-display text-[30px] font-semibold uppercase tracking-[1.5px] text-ink-strong">Live-sett</h1>
      {sets.map((t) => {
        const a = cur?.manifest.slug === t.slug ? cur : t.main;
        const m = a.manifest;
        const isCur = cur?.manifest.id === a.manifest.id;
        const resume = savedPosition(a);
        const chapters = sectionsOf(m.markers);
        const now = isCur ? sectionAt(m.markers, positionMs) : null;
        const single = now?.refSlug ? tracks.find((x) => x.slug === now.refSlug && x.main.manifest.kind === 'track') : undefined;
        return (
          <article key={t.slug} className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-surface/80 p-4 lg:p-5" style={paletteToCssVars(m.palette) as CSSProperties}>
            <div className="flex flex-wrap items-center gap-4">
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={64} rounded={10} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 className="m-0 text-base font-semibold text-ink-strong">{m.title}</h2>
                <span className="text-xs text-muted">{[m.venue, m.performedAt ? new Date(m.performedAt).toLocaleDateString('nb-NO') : null, formatTime(m.durationMs), `${chapters.length} låter`].filter(Boolean).join(' · ')}</span>
              </div>
              <button type="button" onClick={() => onPlay(t, a)} className="flex h-11 items-center gap-2 rounded-full bg-gold px-4 text-sm font-semibold text-[#120D02]">
                <PlayIcon width={16} height={16} />
                {resume && !isCur ? `Fortsett fra ${formatTime(resume)}` : 'Spill'}
              </button>
            </div>
            {isCur && now && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2 text-[13px]">
                <span className="text-[10px] font-semibold tracking-[1.5px] text-accent">SPILLES NÅ I SETTET</span>
                <span className="font-semibold text-ink-strong">{now.label}</span>
                {single && (
                  <button type="button" onClick={() => onPlay(single)} className="ml-auto h-8 rounded-full border border-white/15 px-3 text-xs text-ink hover:border-accent">
                    Gå til enkeltlåt →
                  </button>
                )}
              </div>
            )}
            <div className="mt-3">
              <SpectralWaveform
                analysis={a.analysis}
                durationMs={m.durationMs}
                progress={isCur ? positionMs / m.durationMs : 0}
                active
                height={40}
                markers={m.markers}
                onSeek={(r) => onPlay(t, a, r * m.durationMs)}
                label={`Spol i ${m.title}`}
              />
            </div>
            {chapters.length > 0 && (
              <ol className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
                {chapters.map((c) => (
                  <li key={c.startMs}>
                    <button
                      type="button"
                      onClick={() => onPlay(t, a, c.startMs)}
                      className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] ${now === c ? 'border-accent text-ink-strong' : 'border-white/10 text-ink hover:border-white/25'}`}
                    >
                      <span className="tabular text-muted">{formatTime(c.startMs)}</span>
                      {c.label}
                      {!c.confirmed && <span className="text-gold" title="Ubekreftet – fant ikke sync-klikket">·?</span>}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Transport

function TransportButtons({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const { playing, toggle, next, prev, nextSection, prevSection, queue, index } = usePlayer();
  const cur = queue[index];
  const hasSections = !!cur && sectionsOf(cur.manifest.markers).length > 0;
  const big = size === 'lg';
  const small = `flex items-center justify-center rounded-full text-champagne hover:text-ink-strong disabled:opacity-30 ${big ? 'h-12 w-12' : 'h-10 w-10'}`;
  return (
    <div className={`flex items-center justify-center ${big ? 'gap-3' : 'gap-1.5'}`}>
      <button type="button" aria-label="Forrige del" title="Forrige del (Shift+←)" onClick={prevSection} disabled={!hasSections} className={small}>
        <SectionPrevIcon width={big ? 24 : 20} height={big ? 24 : 20} />
      </button>
      <button type="button" aria-label="Forrige spor" onClick={prev} className={small}>
        <PrevIcon width={big ? 24 : 20} height={big ? 24 : 20} />
      </button>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Spill'}
        onClick={toggle}
        className={`rounded-full bg-gold p-[3px] shadow-[0_8px_24px_rgba(240,192,48,0.25)] active:scale-95 ${big ? 'h-[76px] w-[76px]' : 'h-12 w-12'}`}
      >
        <span className="flex h-full w-full items-center justify-center rounded-full bg-[#0B0D12] text-gold">
          {playing ? <PauseIcon width={big ? 28 : 20} height={big ? 28 : 20} /> : <PlayIcon width={big ? 28 : 20} height={big ? 28 : 20} className="ml-0.5" />}
        </span>
      </button>
      <button type="button" aria-label="Neste spor" onClick={next} className={small}>
        <NextIcon width={big ? 24 : 20} height={big ? 24 : 20} />
      </button>
      <button type="button" aria-label="Neste del" title="Neste del (Shift+→)" onClick={nextSection} disabled={!hasSections} className={small}>
        <SectionNextIcon width={big ? 24 : 20} height={big ? 24 : 20} />
      </button>
    </div>
  );
}

function NowLabel({ cur, hideVariant = false }: { cur: LoadedAsset; hideVariant?: boolean }) {
  const positionMs = usePlayer((s) => s.positionMs);
  const s = sectionAt(cur.manifest.markers, positionMs);
  const m = cur.manifest;
  return (
    <span className="truncate text-[11px] text-muted">
      {[m.variant && !hideVariant ? variantName(cur) : null, m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot].filter(Boolean).join(' · ')}
      {s?.label && (
        <>
          {' · '}
          <span className="font-semibold text-accent">{s.label}</span>
        </>
      )}
    </span>
  );
}

/** Desktop: fullbredde transport-dock. Kantlinja puster med sub-bassen. */
function Dock({ cur, track, onVariant, tracks, onPlay, onMore }: { cur: LoadedAsset; track?: Track; onVariant: (v: LoadedAsset) => void; tracks: Track[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void; onMore: (anchor?: { x: number; y: number } | null) => void }) {
  const { positionMs, started, seek, volume, setVolume } = usePlayer();
  const m = cur.manifest;
  const setNow = m.kind === 'set' ? sectionAt(m.markers, positionMs) : null;
  const single = setNow?.refSlug ? tracks.find((x) => x.slug === setNow.refSlug && x.main.manifest.kind === 'track') : undefined;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 hidden h-[112px] border-t border-white/[0.07] bg-sunken/90 backdrop-blur-xl lg:block">
      <SubBassEdge />
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-6 px-6">
        <div className="flex w-[300px] min-w-0 items-center gap-3">
          <span
            title="Høyreklikk for valg"
            onContextMenu={(e) => {
              e.preventDefault();
              onMore({ x: e.clientX, y: e.clientY - 360 });
            }}
          >
            <CoverArt src={assetUrl(cur, m.files.coverThumb)} palette={m.palette} title={m.title} size={60} rounded={8} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-sm font-semibold text-ink-strong">{m.title}</span>
              <button
                id="gv-dock-more"
                type="button"
                aria-label={`Valg for ${m.title}`}
                title="Valg (Shift+F10)"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  onMore({ x: r.left, y: r.top - 360 });
                }}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted hover:bg-white/[0.08] hover:text-ink-strong"
              >
                <MoreIcon width={16} height={16} />
              </button>
            </span>
            {track && track.variants.length > 1 ? <VariantSelect t={track} value={cur} onChange={onVariant} /> : null}
            <NowLabel cur={cur} hideVariant={!!track && track.variants.length > 1} />
            {single && (
              <button type="button" onClick={() => onPlay(single)} className="w-fit text-left text-[11px] text-accent hover:underline">
                Gå til enkeltlåt →
              </button>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="tabular w-14 text-right text-[11px] text-muted">{formatTime(positionMs)}</span>
            <div className="min-w-0 flex-1">
              <SpectralWaveform analysis={cur.analysis} durationMs={m.durationMs} progress={positionMs / m.durationMs} active={started} height={34} markers={m.markers} showLabels onSeek={(r) => seek(r * m.durationMs)} />
            </div>
            <span className="tabular w-14 text-[11px] text-muted">{formatTime(m.durationMs)}</span>
          </div>
          <TransportButtons />
        </div>
        <label className="flex w-[180px] items-center gap-2 text-muted">
          <VolumeIcon width={18} height={18} />
          <span className="sr-only">Volum</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full accent-[#F0C030]" />
        </label>
      </div>
    </div>
  );
}

function SubBassEdge() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 -top-px h-px"
      style={{ background: 'var(--accent)', opacity: 'calc(0.12 + var(--sub, 0) * 0.88)', boxShadow: '0 0 calc(var(--sub, 0) * 22px) calc(var(--sub, 0) * 2px) var(--accent)' }}
    />
  );
}

/** Mobil: glassmorfisk pille over bunnmenyen. Trykk = fullskjerm, sveip = bytt spor, hold inne = «⋯»-menyen. */
function MiniPlayer({ cur, onOpen, onMore }: { cur: LoadedAsset; onOpen: () => void; onMore: () => void }) {
  const { playing, toggle, positionMs, next, prev, started } = usePlayer();
  const m = cur.manifest;
  const startX = useRef<number | null>(null);
  const hold = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null);
  return (
    <div
      className="fixed inset-x-3 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 overflow-hidden rounded-2xl border border-white/[0.08] bg-[rgba(14,16,21,0.92)] shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl lg:hidden"
      onTouchStart={(e) => {
        const t = e.touches[0];
        startX.current = t?.clientX ?? null;
        if (!t) return;
        const h = { timer: 0, fired: false, x: t.clientX, y: t.clientY };
        h.timer = window.setTimeout(() => {
          h.fired = true;
          navigator.vibrate?.(10);
          onMore();
        }, 500);
        hold.current = h;
      }}
      onTouchMove={(e) => {
        const h = hold.current;
        const t = e.touches[0];
        if (h && t && (Math.abs(t.clientX - h.x) > 10 || Math.abs(t.clientY - h.y) > 10)) window.clearTimeout(h.timer);
      }}
      onTouchEnd={(e) => {
        if (hold.current) window.clearTimeout(hold.current.timer);
        if (hold.current?.fired) {
          // Menyarket har glidd opp under fingeren: klikket som følger skal ikke treffe et valg i det.
          const swallow = (ev: Event) => {
            ev.stopPropagation();
            ev.preventDefault();
          };
          for (const t of ['mousedown', 'mouseup', 'click']) window.addEventListener(t, swallow, { capture: true });
          setTimeout(() => {
            for (const t of ['mousedown', 'mouseup', 'click']) window.removeEventListener(t, swallow, { capture: true });
          }, 450);
          hold.current = null;
        }
        const dx = (e.changedTouches[0]?.clientX ?? 0) - (startX.current ?? 0);
        if (startX.current != null && !hold.current?.fired && Math.abs(dx) > 60) (dx < 0 ? next : prev)();
        startX.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <SubBassEdge />
      <div className="flex items-center gap-3 p-2 pr-3">
        <button
          type="button"
          onClick={(e) => {
            // Klikket etter et langt trykk skal ikke åpne fullskjerm
            if (hold.current?.fired) {
              hold.current = null;
              return e.preventDefault();
            }
            onOpen();
          }}
          className="flex min-w-0 flex-1 select-none items-center gap-3 text-left [-webkit-touch-callout:none]"
          aria-label={`Åpne spilleren: ${m.title}`}
        >
          <CoverArt src={assetUrl(cur, m.files.coverThumb)} palette={m.palette} title={m.title} size={44} rounded={8} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-ink-strong">{m.title}</span>
            <NowLabel cur={cur} />
          </span>
        </button>
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Spill'} className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-gold text-[#120D02]">
          {playing ? <PauseIcon width={18} height={18} /> : <PlayIcon width={18} height={18} className="ml-0.5" />}
        </button>
      </div>
      <div className="px-2 pb-1.5">
        <SpectralWaveform analysis={cur.analysis} durationMs={m.durationMs} progress={positionMs / m.durationMs} active={started} height={14} barPx={2} />
      </div>
    </div>
  );
}

/** Mobil: fullskjerm. Cover øverst, bølgeform med deler i midten, store kontroller nederst. */
function FullPlayer({ cur, track, tracks, onClose, onPlay, onMore }: { cur: LoadedAsset; track?: Track; tracks: Track[]; onClose: () => void; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void; onMore: () => void }) {
  const { positionMs, started, seek, switchVariant } = usePlayer();
  const m = cur.manifest;
  const now = sectionAt(m.markers, positionMs);
  const single = m.kind === 'set' && now?.refSlug ? tracks.find((x) => x.slug === now.refSlug && x.main.manifest.kind === 'track') : undefined;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Spiller: ${m.title}`} className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-obsidian px-6 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(14px,env(safe-area-inset-top))] lg:hidden">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-[30%] h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: 'radial-gradient(closest-side, var(--glow), var(--glow-2) 55%, transparent)', opacity: 'calc(0.6 + var(--sub, 0) * 0.4)' }} />
      <div className="relative flex items-center justify-between">
        <button type="button" onClick={onClose} aria-label="Lukk spilleren" className="flex h-11 w-11 items-center justify-center rounded-full text-champagne">
          <ChevronDownIcon width={26} height={26} />
        </button>
        <span className="text-[10px] font-semibold tracking-[2px] text-muted">{m.kind === 'set' ? 'LIVE-SETT' : 'SPILLES NÅ'}</span>
        <button type="button" onClick={onMore} aria-label="Valg for låta som spilles" className="flex h-11 w-11 items-center justify-center rounded-full text-champagne">
          <MoreIcon width={22} height={22} />
        </button>
      </div>
      <div className="relative mt-4 flex justify-center">
        <CoverArt src={assetUrl(cur, m.files.cover)} palette={m.palette} title={m.title} size={Math.round(Math.min(window.innerWidth - 48, window.innerHeight * 0.44))} rounded={16} />
      </div>
      <div className="relative mt-6 flex flex-col gap-1">
        <h2 className="m-0 font-display text-[28px] font-semibold uppercase leading-tight tracking-[1px] text-ink-strong">{m.title}</h2>
        <span className="text-[13px] text-muted">{[m.artist, m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot].filter(Boolean).join(' · ')}</span>
      </div>
      {track && track.variants.length > 1 && (
        <div role="group" aria-label="Variant" className="relative mt-3 flex flex-wrap gap-1.5">
          {track.variants.map((v) => (
            <button
              key={v.manifest.id}
              type="button"
              aria-pressed={v.manifest.id === m.id}
              onClick={() => switchVariant(v)}
              className={`h-9 rounded-full px-3.5 text-xs font-semibold ${v.manifest.id === m.id ? 'bg-white/[0.12] text-ink-strong' : 'border border-white/10 text-muted'}`}
            >
              {variantName(v)}
            </button>
          ))}
        </div>
      )}
      <div className="relative mt-5">
        <SpectralWaveform analysis={cur.analysis} durationMs={m.durationMs} progress={positionMs / m.durationMs} active={started} height={64} markers={m.markers} showLabels onSeek={(r) => seek(r * m.durationMs)} />
        <div className="tabular mt-1.5 flex justify-between text-[11px] text-muted">
          <span>{formatTime(positionMs)}</span>
          {now?.label && <span className="font-semibold text-accent">{now.label}</span>}
          <span>{formatTime(m.durationMs)}</span>
        </div>
      </div>
      {single && (
        <button type="button" onClick={() => onPlay(single)} className="relative mt-3 h-10 self-start rounded-full border border-white/15 px-4 text-xs text-ink">
          Gå til enkeltlåt: {single.main.manifest.title} →
        </button>
      )}
      <div className="relative mt-auto pt-6">
        <TransportButtons size="lg" />
      </div>
    </div>
  );
}
