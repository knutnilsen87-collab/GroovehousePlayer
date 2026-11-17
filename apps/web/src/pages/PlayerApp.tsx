import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { bpmLabel, formatTime, isDraft, keyShort, matchesStatus, NEUTRAL_PALETTE, paletteToCssVars, sectionAt, sectionsOf, type StatusFilter } from '@gv/shared/web';
import { Logo } from '../components/Brand';
import { AnalysisSidebarCard, CoverCard, NowPanel, SideTabs } from '../components/Deck';
import { FullPlayer } from '../components/MobilePlayer';
import { DraftBadge, DraftConfirmHost, StatusSegment, trackVars, useStatusFilter } from '../components/Draft';
import { BottomNav, Sidebar, type View } from '../components/Nav';
import { sortTracks, StudioTable, VariantSelect, type Sort } from '../components/StudioTable';
import { startListenReporting, useFavorites } from '../lib/library';
import { DjView, HomeView, StatsView } from './Views';
import { CommandPalette } from '../components/CommandPalette';
import { CoverArt } from '../components/CoverArt';
import { addWithUndo, AddToPlaylistSheet, PlaylistDetail, PlaylistsOverview, SidebarPlaylists, Toast } from '../components/Playlists';
import { ChevronDownIcon, MoreIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, SearchIcon, SectionNextIcon, SectionPrevIcon, VolumeIcon } from '../components/Icons';
import { SpectralWaveform } from '../components/SpectralWaveform';
import { assetUrl, groupTracks, loadVersion, useCatalog, useFullAsset, variantName, versionKey, type LoadedAsset, type Track } from '../lib/catalog';
import { startPlaybackSync } from '../lib/playbackSync';
import { savedPosition, storedQueue, usePlayer } from '../lib/player';
import { SetBuilder } from '../components/SetBuilder';
import { itemFor, mostRecentTarget, toastError, usePlaylists, usePlaylistSync, useToast } from '../lib/playlists';
import { useSubBass } from '../lib/useSubBass';
import { useVersionCtx } from '../lib/versions';
import { QueuePanel, TrackActionsHost } from '../components/TrackActions';
import { ResumeBanner } from '../components/ResumeBanner';
import { ShareSheetHost } from '../components/ShareSheet';
import { useUi } from '../lib/ui';
import { fromStored } from '@gv/shared/web';
import { App as CapApp } from '@capacitor/app';
import { isApp } from '../lib/platform';
import { loadPlaybackSettings } from '../lib/settings';
import { UnreachableScreen } from './Connect';
import { skinTrackVars, useSkinId, useTagline } from '../lib/skin';
import { Heartbeat, useHeartbeatMotif } from '../components/Brand';
import { useFx } from '../lib/fx';

type Filter = 'all' | 'track' | 'set';

/** Del 14: direkte lenke til en visning, f.eks. /?vis=bibliotek. */
// Menyen heter «Live-sett», så /?vis=live-sett (og varianter) må virke i tillegg til /?vis=sett
const VIEW_PARAM: Record<string, View> = { hjem: 'home', bibliotek: 'library', lister: 'playlists', spillelister: 'playlists', sett: 'sets', 'live-sett': 'sets', livesett: 'sets', live: 'sets', dj: 'dj', analyse: 'stats', statistikk: 'stats' };
/** Leser ?vis=… uten å bry seg om store bokstaver eller mellomrom («Live sett»). */
export const viewFromParam = (v: string | null): View | undefined => (v ? VIEW_PARAM[v.trim().toLowerCase().replace(/[\s_]+/g, '-')] : undefined);

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setDesktop(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return desktop;
}

/**
 * Din egen spiller. Mobil: én tommel – bunnmeny, flytende mini-spiller, fullskjerm ved trykk.
 * Desktop (del 14 «High-End Studio»): sidemeny, dekket (cover, Spilles nå, låtinfo/zoom/spektrum) og
 * låttabellen. Coveret styrer alle farger; gull bare i logoen.
 */
export function PlayerApp({ onDisconnected }: { onDisconnected?: () => void } = {}) {
  const { assets, index: catalogIndex, loading, error: catalogError, reload } = useCatalog();
  const tracks = useMemo(() => groupTracks(assets), [assets]);
  // Startvisning fra lenken (/?vis=bibliotek), ellers Hjem
  const [view, setView] = useState<View>(() => viewFromParam(new URLSearchParams(location.search).get('vis')) ?? 'home');
  const [sort, setSort] = useState<Sort>({ key: 'none', dir: 1 });
  const [filter, setFilter] = useState<Filter>('all');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [listId, setListId] = useState<string | null>(null);
  const addSheet = useUi((s) => s.addSheet);
  const openActions = useUi((s) => s.openActions);
  /** Desktop: valgte låter i tabellen (Ctrl/Shift-klikk). Mobil: velgemodus (hold inne på en låt). */
  const [selected, setSelected] = useState<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const { queue, index, playing, playFrom, switchVariant, toggle, nextSection, prevSection } = usePlayer();
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

  // Del 8: LUFS-målet fra innstillingene (demping regnes ut i spilleren).
  // Del 14: favoritter og egne avspillinger (Analyse, Hjem) ligger på PC-en.
  useEffect(() => {
    void loadPlaybackSettings();
    void useFavorites.getState().load();
    const stopSync = startPlaybackSync();
    const stopListen = startListenReporting();
    return () => {
      stopSync();
      stopListen();
    };
  }, []);

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

  // Android: tilbake-knappen lukker ark, menyer og fullskjerm først. Ut av appen = musikken fortsetter.
  const back = useRef<() => void>(() => {});
  back.current = () => {
    const ui = useUi.getState();
    if (ui.share) ui.closeShare();
    else if (ui.actions) ui.closeActions();
    else if (ui.addSheet) ui.closeAddSheet();
    else if (ui.queueOpen) ui.setQueueOpen(false);
    else if (paletteOpen) setPaletteOpen(false);
    else if (full) setFull(false);
    else if (selectMode) history.back();
    else if (listId) setListId(null);
    else if (view !== 'home') setView('home');
    else void CapApp.minimizeApp();
  };
  useEffect(() => {
    if (!isApp) return;
    const h = CapApp.addListener('backButton', () => back.current());
    return () => void h.then((x) => x.remove());
  }, []);

  // Del 14: standardfargen (grønn) brukes med mindre låta har fått egen farge i Studio.
  useSkinId(); // del 19: bytt skin uten omstart
  const desktop = useIsDesktop();
  // Del 18: presets og overgangsidéer (rask idéfangst og påminnelser) – på mobil hentes dette først ved avspilling eller i sett/DJ-visning
  useEffect(() => {
    if (desktop || playing || view === 'sets' || view === 'dj') {
      void useFx.getState().load();
    }
  }, [desktop, playing, view]);

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

  // Del 16: Release-klar · Utkast · Alle – bare release-klare som standard, valget huskes per visning
  const [libStatus, setLibStatus] = useStatusFilter('library', 'all');
  const [homeStatus, setHomeStatus] = useStatusFilter('home', 'all');
  const [djStatus, setDjStatus] = useStatusFilter('dj', 'all');
  const byStatus = (f: StatusFilter) => tracks.filter((t) => matchesStatus(t.main.manifest, f));
  const statusCounts = { release: tracks.filter((t) => !isDraft(t.main.manifest)).length, draft: tracks.filter((t) => isDraft(t.main.manifest)).length };
  const homeTracks = useMemo(() => byStatus(homeStatus), [tracks, homeStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = sortTracks(
    (view === 'sets' ? tracks : view === 'home' ? homeTracks : byStatus(libStatus)).filter((t) => (view === 'sets' ? t.main.manifest.kind === 'set' : view === 'home' || filter === 'all' || t.main.manifest.kind === filter)),
    view === 'library' ? sort : { key: 'none', dir: 1 }
  );
  /** Hjem: nyeste først (tabellen «Nylig lagt til» under dekket). */
  const newest = useMemo(() => [...homeTracks].sort((a, b) => b.main.manifest.createdAt.localeCompare(a.main.manifest.createdAt)), [homeTracks]);

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

  if (isApp && catalogError && tracks.length === 0) return <UnreachableScreen error={catalogError} onRetry={reload} onReconnect={() => onDisconnected?.()} />;

  const deckAsset = cur ?? newest[0]?.main;
  // Del 14/19: låta i spilleren (også pauset), ellers låta som vises i dekket. Faste skins overstyrer i skinTrackVars.
  const vars = deckAsset ? trackVars(deckAsset.manifest) : (skinTrackVars(null) as CSSProperties);
  const showDeck = desktop && (view === 'home' || view === 'library') && !!deckAsset && tracks.length > 0;
  /** Dekket før noe er spilt: play/spoling starter låta som vises. */
  const idle = cur ? undefined : (atMs?: number) => newest[0] && playFrom(newest.map((t) => t.main), 0, atMs);
  const tableProps = {
    onPlay: play,
    selected,
    onSelect: selectRow,
    itemsFor: (slug: string) => assetsFor(slug).map(itemFor),
    onContext: (slug: string, at: { x: number; y: number }) => {
      if (!selected.includes(slug)) setSelected([slug]);
      openActions({ assets: selected.includes(slug) ? assetsFor(slug) : [shownAsset(visible.find((t) => t.slug === slug) ?? tracks.find((t) => t.slug === slug)!)], context: 'row', anchor: at });
    }
  };
  const goto = (v: View) => {
    setView(v);
    setListId(null);
    setSelected([]);
    window.scrollTo({ top: 0 });
  };

  return (
    <div ref={root} className="relative min-h-[100svh] bg-obsidian text-ink lg:grid lg:grid-cols-[272px_minmax(0,1fr)]" style={vars}>
      <AmbientGlow />
      <Sidebar view={view} setView={goto} onSearch={() => setPaletteOpen(true)} playlists={<SidebarPlaylists tracks={tracks} activeId={view === 'playlists' ? listId : null} onOpen={openList} />} />

      <main className={`relative z-10 min-w-0 px-4 pb-[168px] pt-4 lg:px-5 lg:pt-4 ${showDeck ? 'lg:pb-8' : 'lg:pb-[132px]'}`}>
        <header className="mb-5 flex items-center justify-between gap-4 lg:hidden">
          <Logo size={36} subtitle="VAULT" />
          <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Søk" className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.05] text-soft">
            <SearchIcon width={20} height={20} />
          </button>
        </header>
        <ResumeBanner tracks={tracks} />

        {loading && tracks.length === 0 ? (
          <LoadingVault onRetry={reload} error={catalogError} />
        ) : tracks.length === 0 ? (
          <EmptyState />
        ) : (
          <div className={showDeck ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] xl:gap-4' : ''}>
            <div className="flex min-w-0 flex-col gap-4">
              {showDeck && deckAsset && (
                <div className="hidden gap-4 lg:grid lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)]">
                  <CoverCard cur={deckAsset} onMore={(at) => (cur ? openNowActions(at) : openActions({ assets: [deckAsset], context: 'row', anchor: at }))} />
                  <NowPanel
                    cur={deckAsset}
                    idle={idle}
                    onMore={(at) => (cur ? openNowActions(at) : openActions({ assets: [deckAsset], context: 'row', anchor: at }))}
                    extra={
                      <div className="xl:hidden">
                        <SideTabs cur={deckAsset} />
                      </div>
                    }
                  />
                </div>
              )}

              {view === 'home' && (
                <div className="flex justify-end">
                  <StatusSegment value={homeStatus} onChange={setHomeStatus} counts={statusCounts} />
                </div>
              )}
              {view === 'home' && (
                <HomeView
                  tracks={homeTracks}
                  onPlay={play}
                  onOpenList={openList}
                  table={desktop ? <StudioTable {...tableProps} tracks={newest} limit={16} label="Nylig lagt til" /> : undefined}
                />
              )}
              {view === 'library' && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h1 className="gv-display m-0 text-[30px] font-semibold text-ink-strong lg:hidden">Bibliotek</h1>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusSegment value={libStatus} onChange={setLibStatus} counts={statusCounts} />
                      <Pills value={filter} onChange={setFilter} />
                    </div>
                    <span className="hidden font-mono text-[11px] text-muted lg:inline">
                      {visible.length} låter · klikk = velg · dobbeltklikk = spill
                    </span>
                  </div>
                  {/* Del 16: «Alle (gruppert)» – Release-klar øverst, Umastret under, i hver sin seksjon */}
                  {(libStatus === 'all' ? ([['Release-klar', visible.filter((t) => !isDraft(t.main.manifest))], ['Umastret', visible.filter((t) => isDraft(t.main.manifest))]] as const) : ([[null, visible]] as const)).map(([heading, list]) =>
                    list.length === 0 && heading ? null : (
                      <section key={heading ?? 'alle'} aria-label={heading ?? undefined} className="flex flex-col gap-2">
                        {heading && (
                          <h2 className="gv-label m-0 mt-2 flex items-baseline gap-2 text-[11px] text-soft">
                            {heading} <span className="font-mono text-[11px] text-muted">{list.length}</span>
                          </h2>
                        )}
                      {desktop ? (
                        <StudioTable {...tableProps} tracks={list} sort={sort} onSort={setSort} />
                      ) : (
                        <TrackList
                          tracks={list}
                          onPlay={play}
                          onMore={(t) => openActions({ assets: [shownAsset(t)], context: 'row' })}
                          onSwipeRight={(t) => {
                            // Mobil: sveip til høyre = legg sist i køen (med angre).
                            const a = shownAsset(t);
                            const player = usePlayer.getState();
                            player.enqueue([a]);
                            const at = usePlayer.getState().queue.length - 1;
                            useToast.getState().show(`Lagt i køen: ${a.manifest.title}`, {
                              label: 'Angre',
                              run: () => {
                                const q = usePlayer.getState().queue;
                                if (q[at]?.manifest.id === a.manifest.id && at !== usePlayer.getState().index) usePlayer.getState().removeFromQueue(at);
                              }
                            });
                          }}
                          onSwipeLeft={(t) => {
                            // Mobil: sveip til venstre = legg til i sist brukte spilleliste (med angre). Ingen liste ennå → arket.
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
                      )}
                      </section>
                    )
                  )}
                </>
              )}
              {view === 'playlists' &&
                (listId ? (
                  <PlaylistDetail id={listId} tracks={tracks} vctx={vctx} onBack={() => setListId(null)} onClosed={() => setListId(null)} />
                ) : (
                  <PlaylistsOverview tracks={tracks} onOpen={openList} vctx={vctx} />
                ))}
              {view === 'sets' && <SetsView sets={visible} tracks={tracks} onPlay={play} onOpenList={openList} />}
              {view === 'dj' && (
                <>
                  <div className="flex justify-end">
                    <StatusSegment value={djStatus} onChange={setDjStatus} counts={statusCounts} />
                  </div>
                  <DjView tracks={byStatus(djStatus)} onPlay={play} />
                </>
              )}
              {view === 'stats' && <StatsView tracks={tracks} onPlay={play} />}
            </div>

            {showDeck && deckAsset && (
              <aside aria-label="Analyse av låta" className="sticky top-4 hidden min-w-0 flex-col gap-4 self-start xl:flex">
                <AnalysisSidebarCard cur={deckAsset} />
              </aside>
            )}
          </div>
        )}
      </main>

      {cur && <Dock cur={cur} track={trackOf(cur)} onVariant={(v) => switchVariant(v)} tracks={tracks} onPlay={play} onMore={openNowActions} hideOnDesktop={showDeck} />}
      {cur && !selectMode && <MiniPlayer cur={cur} onOpen={() => setFull(true)} onMore={() => openNowActions()} />}
      {selectMode && (
        <div className="fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-30 flex items-center gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => history.back()}
            className="gv-glass h-12 rounded-full bg-sunken/85 px-4 text-sm text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_24px_rgba(0,0,0,0.45)]"
          >
            Avbryt
          </button>
          <button
            type="button"
            disabled={!selected.length}
            onClick={() => openSheet(visible.filter((t) => selected.includes(t.slug)).map(shownAsset))}
            className="h-12 flex-1 rounded-full bg-accent text-sm font-semibold text-on-accent shadow-[0_8px_24px_var(--glow)] disabled:opacity-50"
          >
            Legg til i spilleliste ({selected.length})
          </button>
        </div>
      )}
      <BottomNav view={view} setView={goto} />
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
      <DraftConfirmHost />
      <QueuePanel />
      <ShareSheetHost />
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

function EmptyState() {
  const motif = useHeartbeatMotif();
  const line = useTagline('', 1);
  return (
    <div className="rounded-2xl border border-dashed border-accent/30 p-8 text-center text-sm text-muted">
      {motif && line && <p className="gv-script m-0 mb-3 text-2xl">{line}</p>}
      Hvelvet er tomt. Kjør <code className="text-ink">pnpm make-fixtures</code> og <code className="text-ink">pnpm gh-ingest fixtures/blue-fire</code>, eller bounce til eksportmappa med <code className="text-ink">pnpm gh-watch</code>.
    </div>
  );
}

// ---------------------------------------------------------------- Katalog

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
          className={`h-11 flex-none rounded-full px-4 text-xs font-semibold lg:h-9 ${value === id ? 'bg-accent text-on-accent' : 'bg-white/[0.05] text-ink hover:bg-white/[0.09]'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Mobil: kompakt liste, én tommel. ⋯ = låthandlinger (del 11).
 * Hold inne = velgemodus. Sveip til høyre = legg i køen, sveip til venstre = legg til i sist brukte spilleliste (begge med angre).
 */
function TrackList({
  tracks,
  onPlay,
  onMore,
  onSwipeRight,
  onSwipeLeft,
  selectMode,
  selected,
  onLongPress,
  onToggle
}: {
  tracks: Track[];
  onPlay: (t: Track) => void;
  onMore: (t: Track) => void;
  onSwipeRight: (t: Track) => void;
  onSwipeLeft: (t: Track) => void;
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
        const meta = [isCur && m.variant ? variantName(a) : null, m.kind === 'set' ? 'Live-sett' : null, bpmLabel(m), m.key ? `${keyShort(m.key.name)} ${m.key.camelot}` : null, t.variants.length > 1 ? `${t.variants.length} varianter` : null]
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
                // Sveip (tydelig vannrett, begge veier): raden følger fingeren
                if (!selectMode && (p.swiping || (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5))) {
                  p.swiping = true;
                  p.dx = dx;
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
                  } else if (p.dx < -90) {
                    navigator.vibrate?.(10);
                    onSwipeLeft(t);
                  }
                  p.fired = true; // ikke spill låta på klikket som følger
                  setSwipe(null);
                }
              }}
              onContextMenu={(e) => e.preventDefault()}
              aria-pressed={selectMode ? isSel : undefined}
              className={`relative flex min-h-[64px] min-w-0 flex-1 select-none items-center gap-3 rounded-xl px-1.5 text-left [-webkit-touch-callout:none] active:bg-white/[0.05] ${isSel ? 'bg-white/[0.07]' : isCur ? 'gv-row-active rounded-l-none' : ''}`}
              style={{ ...trackVars(m), ...(swipe?.slug === t.slug ? { transform: `translateX(${swipe.dx}px)`, background: '#15181F' } : {}) }}
            >
              {swipe?.slug === t.slug && swipe.dx > 0 && (
                <span aria-hidden="true" className="absolute inset-y-0 right-full flex items-center whitespace-nowrap pr-3 text-xs font-semibold text-accent" style={{ opacity: Math.min(1, swipe.dx / 90) }}>
                  + Køen
                </span>
              )}
              {swipe?.slug === t.slug && swipe.dx < 0 && (
                <span aria-hidden="true" className="absolute inset-y-0 left-full flex items-center whitespace-nowrap pl-3 text-xs font-semibold text-accent" style={{ opacity: Math.min(1, -swipe.dx / 90) }}>
                  + Sist brukte liste
                </span>
              )}
              {selectMode && (
                <span aria-hidden="true" className={`flex h-6 w-6 flex-none items-center justify-center rounded-full border text-[13px] font-bold ${isSel ? 'border-accent bg-accent text-on-accent' : 'border-white/30'}`}>
                  {isSel ? '✓' : ''}
                </span>
              )}
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={48} rounded={8} draft={isDraft(m)} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={`truncate text-[15px] ${isCur ? 'font-bold text-accent' : 'font-semibold text-ink-strong'}`}>
                  {isCur && playing ? '▶ ' : ''}
                  {m.title}<DraftBadge m={m} className="ml-1.5" />
                </span>
                <span className="truncate font-mono text-[13px] text-muted">{meta}</span>
              </span>
              <span className="font-mono text-[13px] text-muted">{formatTime(m.durationMs)}</span>
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

type SetsTab = 'recorded' | 'planned' | 'build';
const SETS_TABS: Array<[SetsTab, string]> = [
  ['recorded', 'Innspilte sett'],
  ['planned', 'Planlagte sett'],
  ['build', 'Lag sett']
];

/** Live-sett (del 17): innspilte sett, planlagte sett (Sett-planer fra del 16) og settbyggeren – holdt atskilt. */
function SetsView({ sets, tracks, onPlay, onOpenList }: { sets: Track[]; tracks: Track[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void; onOpenList: (id: string) => void }) {
  const [tab, setTab] = useState<SetsTab>(() => {
    try {
      return (localStorage.getItem('gv.setsTab') as SetsTab) || 'recorded';
    } catch {
      return 'recorded';
    }
  });
  const pick = (t: SetsTab) => {
    setTab(t);
    try {
      localStorage.setItem('gv.setsTab', t);
    } catch {
      /* uten lagring */
    }
  };
  const allLists = usePlaylists((s) => s.playlists);
  const plans = useMemo(() => allLists.filter((p) => p.plan === 'set'), [allLists]);
  const assets = useMemo(() => tracks.flatMap((t) => t.variants), [tracks]);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="m-0 font-display text-[30px] font-semibold uppercase tracking-[1.5px] text-ink-strong">Live-sett</h1>
      <div role="tablist" aria-label="Live-sett" className="flex flex-wrap gap-2">
        {SETS_TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => pick(k)} className={`h-9 rounded-full px-4 text-sm ${tab === k ? 'bg-accent/[0.14] font-semibold text-accent shadow-[0_0_18px_-4px_var(--glow)]' : 'bg-white/[0.05] text-soft hover:text-ink'}`}>
            {label}
            {k === 'planned' && plans.length > 0 ? ` (${plans.length})` : ''}
          </button>
        ))}
      </div>
      {tab === 'recorded' && <RecordedSets sets={sets} tracks={tracks} onPlay={onPlay} />}
      {tab === 'planned' &&
        (plans.length === 0 ? (
          <p className="text-sm text-muted">Ingen planlagte sett ennå. Lag et under «Lag sett», eller merk en spilleliste som Sett-plan.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Planlagte sett">
            {plans.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => onOpenList(p.id)} className="gv-panel flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.05]">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-strong">{p.name}</span>
                  <span className="font-mono text-[11px] text-muted">{p.entries.length} låter</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
      {tab === 'build' && <SetBuilder assets={assets} />}
    </div>
  );
}

function RecordedSets({ sets, tracks, onPlay }: { sets: Track[]; tracks: Track[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void }) {
  const { queue, index, positionMs } = usePlayer();
  const cur = queue[index];
  if (sets.length === 0) return <p className="text-sm text-muted">Ingen live-sett ennå. Legg et sett med live_log.json i eksportmappa.</p>;
  return (
    <div className="flex flex-col gap-4">
      {sets.map((t) => {
        const a = cur?.manifest.slug === t.slug ? cur : t.main;
        const m = a.manifest;
        const isCur = cur?.manifest.id === a.manifest.id;
        const resume = savedPosition(a);
        const chapters = sectionsOf(m.markers);
        const now = isCur ? sectionAt(m.markers, positionMs) : null;
        const single = now?.refSlug ? tracks.find((x) => x.slug === now.refSlug && x.main.manifest.kind === 'track') : undefined;
        return (
          <article key={t.slug} className="gv-panel relative overflow-hidden p-4 lg:p-5" style={skinTrackVars(m.palette) as CSSProperties}>
            <div className="flex flex-wrap items-center gap-4">
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={64} rounded={10} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 className="gv-display m-0 text-[18px] font-semibold text-ink-strong">{m.title}</h2>
                <span className="text-xs text-muted">{[m.venue, m.performedAt ? new Date(m.performedAt).toLocaleDateString('nb-NO') : null, formatTime(m.durationMs), `${chapters.length} låter`].filter(Boolean).join(' · ')}</span>
              </div>
              <button type="button" onClick={() => onPlay(t, a)} className="flex h-11 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
                <PlayIcon width={16} height={16} />
                {resume && !isCur ? `Fortsett fra ${formatTime(resume)}` : 'Spill'}
              </button>
            </div>
            {isCur && now && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2 text-[13px]">
                <span className="text-[11px] font-semibold tracking-[1.5px] text-accent">SPILLES NÅ I SETTET</span>
                <span className="font-semibold text-ink-strong">{now.label}</span>
                {single && (
                  <button type="button" onClick={() => onPlay(single)} className="ml-auto h-8 rounded-full bg-white/[0.06] px-3 text-xs text-ink hover:bg-accent/[0.14]">
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
                      className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] ${now === c ? 'border-transparent bg-accent/[0.16] text-ink-strong' : 'border-transparent bg-white/[0.04] text-ink hover:bg-white/[0.08]'}`}
                    >
                      <span className="tabular text-muted">{formatTime(c.startMs)}</span>
                      {c.label}
                      {c.bpm != null && <span className="font-mono text-[11px] text-muted">{Math.round(c.bpm)}</span>}
                      {!c.confirmed && <span className="text-accent" title="Ubekreftet – fant ikke sync-klikket">·?</span>}
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
  const small = `flex items-center justify-center rounded-full text-soft hover:text-ink-strong disabled:opacity-30 ${big ? 'h-12 w-12' : 'h-10 w-10'}`;
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
        className={`rounded-full bg-accent p-[3px] shadow-[0_8px_24px_var(--glow)] active:scale-95 ${big ? 'h-[76px] w-[76px]' : 'h-12 w-12'}`}
      >
        <span className="flex h-full w-full items-center justify-center rounded-full bg-sunken text-accent">
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
function Dock({ cur, track, onVariant, tracks, onPlay, onMore, hideOnDesktop = false }: { cur: LoadedAsset; track?: Track; onVariant: (v: LoadedAsset) => void; tracks: Track[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void; onMore: (anchor?: { x: number; y: number } | null) => void; /** Dekket viser transporten (Hjem, Bibliotek). */ hideOnDesktop?: boolean }) {
  const { positionMs, started, seek, volume, setVolume } = usePlayer();
  const m = cur.manifest;
  const full = useFullAsset(cur);
  const setNow = m.kind === 'set' ? sectionAt(m.markers, positionMs) : null;
  const single = setNow?.refSlug ? tracks.find((x) => x.slug === setNow.refSlug && x.main.manifest.kind === 'track') : undefined;
  return (
    <div className={`fixed inset-x-0 bottom-0 z-30 hidden h-[112px] bg-sunken/90 shadow-[0_-1px_0_rgba(255,255,255,0.06),0_-16px_40px_rgba(0,0,0,0.5)] lg:left-[272px] gv-glass ${hideOnDesktop ? '' : 'lg:block'}`}>
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
              <SpectralWaveform analysis={full.analysis} durationMs={m.durationMs} progress={positionMs / m.durationMs} active={started} height={34} markers={m.markers} showLabels onSeek={(r) => seek(r * m.durationMs)} />
            </div>
            <span className="tabular w-14 text-[11px] text-muted">{formatTime(m.durationMs)}</span>
          </div>
          <TransportButtons />
        </div>
        <label className="flex w-[180px] items-center gap-2 text-muted">
          <VolumeIcon width={18} height={18} />
          <span className="sr-only">Volum</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
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
  const full = useFullAsset(cur);
  const startX = useRef<number | null>(null);
  const hold = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null);
  return (
    <div
      className="fixed inset-x-3 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 gv-glass overflow-hidden rounded-2xl bg-sunken/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_12px_40px_rgba(0,0,0,0.55),0_0_28px_var(--glow-2)] lg:hidden"
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
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Spill'} data-playing={playing ? 'true' : 'false'} className="gv-play flex h-11 w-11 flex-none items-center justify-center rounded-full">
          {playing ? <PauseIcon width={18} height={18} /> : <PlayIcon width={18} height={18} className="ml-0.5" />}
        </button>
      </div>
      <div className="px-2 pb-1.5">
        <SpectralWaveform analysis={full.analysis} durationMs={m.durationMs} progress={positionMs / m.durationMs} active={started} height={14} barPx={2} />
      </div>
    </div>
  );
}

/**
 * Oppstart: «Åpner hvelvet …», eller i Echo Groove Nights hjerteslaget og en kort tekst i guidens tone.
 * Feilet første lasting (og ingen lagret katalog finnes), vises feilen med «Prøv igjen».
 */
function LoadingVault({ onRetry, error }: { onRetry?: () => void; error?: string | null }) {
  const motif = useHeartbeatMotif();
  const line = useTagline('Åpner hvelvet …', new Date().getDate());
  if (error)
    return (
      <div role="alert" className="flex flex-col items-start gap-3 py-8">
        <p className="m-0 text-sm text-ink">Fikk ikke hentet katalogen fra Vault ({error}).</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent">
            Prøv igjen
          </button>
        )}
      </div>
    );
  if (!motif) return <p className="text-sm text-muted">Åpner hvelvet …</p>;
  return (
    <div className="flex flex-col items-center gap-3 py-16" role="status">
      <Heartbeat width={120} height={40} animate />
      <p className="gv-script m-0 text-2xl">{line}</p>
    </div>
  );
}
