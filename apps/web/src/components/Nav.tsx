import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Logo } from './Brand';
import { AnalyticsIcon, ChevronDownIcon, DjIcon, HomeIcon, LibraryIcon, MoreIcon, PlaylistIcon, PulseIcon, SearchIcon, SettingsIcon, StudioIcon } from './Icons';
import { useDialog } from '../lib/dialog';
import { linkClick } from '../lib/nav';

/** Del 14: visningene i spilleren. */
export type View = 'home' | 'library' | 'playlists' | 'sets' | 'dj' | 'stats';

/**
 * Del 27 pkt. 4: samme navn overalt. «Vault» er appens navn; arbeidsbordet heter «Studio» i all navigasjon.
 * Mobil og desktop bruker de samme ordene, og alt på desktop kan nås på mobil (DJ-verktøy og Analyse under «Mer»).
 */
export const VIEW_LABEL: Record<View, string> = { home: 'Hjem', library: 'Bibliotek', playlists: 'Spillelister', sets: 'Live-sett', dj: 'DJ-verktøy', stats: 'Analyse' };

type IconT = typeof HomeIcon;

/**
 * Venstre sidemeny (desktop), tilpasset Knuts innhold: Hjem, Bibliotek, Spillelister (utvidbar, med
 * fargeprikkene fra del 9), Live-sett, DJ-verktøy, Analyse, Studio. Innstillinger nederst.
 */
export function Sidebar({ view, setView, onSearch, playlists }: { view: View; setView: (v: View) => void; onSearch: () => void; playlists?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const cls = (active: boolean) =>
    `flex min-h-[46px] w-full items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] transition-colors ${
      active ? 'gv-row-active bg-accent/[0.12] font-semibold text-ink-strong [&>svg]:text-accent' : 'text-soft hover:bg-white/[0.04] hover:text-ink-strong [&>svg]:text-soft hover:[&>svg]:text-ink-strong'
    }`;
  const item = (id: View, Icon: IconT) => (
    <button type="button" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)} className={cls(view === id)}>
      <Icon width={20} height={20} className="flex-none" />
      {VIEW_LABEL[id]}
    </button>
  );
  return (
    <aside className="gv-panel sticky top-4 z-10 m-4 mr-0 hidden h-[calc(100svh-32px)] flex-col gap-4 overflow-hidden !rounded-2xl px-3.5 pb-3.5 pt-5 lg:flex">
      <div className="px-2">
        <Logo size={40} subtitle="VAULT" />
      </div>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Søk i biblioteket"
        className="flex min-h-[44px] w-full items-center gap-3 rounded-xl bg-white/[0.04] px-3.5 py-2 text-left text-[14px] text-soft transition-colors hover:bg-white/[0.07] hover:text-ink-strong"
      >
        <SearchIcon width={18} height={18} className="flex-none text-soft" />
        <span className="truncate">Søk…</span>
        <kbd className="ml-auto rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-muted">Ctrl K</kbd>
      </button>
      <nav aria-label="Hovedmeny" className="gv-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1">
        {item('home', HomeIcon)}
        {item('library', LibraryIcon)}
        <div className="flex flex-col">
          <div className="flex items-center">
            <button type="button" aria-current={view === 'playlists' ? 'page' : undefined} onClick={() => setView('playlists')} className={cls(view === 'playlists')}>
              <PlaylistIcon width={20} height={20} className="flex-none" />
              {VIEW_LABEL.playlists}
            </button>
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? 'Skjul spillelistene' : 'Vis spillelistene'}
              onClick={() => setOpen((o) => !o)}
              className="ml-1 flex h-10 w-10 flex-none items-center justify-center rounded-lg text-soft hover:bg-white/[0.04] hover:text-ink-strong"
            >
              <ChevronDownIcon width={16} height={16} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
            </button>
          </div>
          {open && <div className="ml-5 mt-1.5 pl-3">{playlists}</div>}
        </div>
        {item('sets', PulseIcon)}
        {item('dj', DjIcon)}
        {item('stats', AnalyticsIcon)}
        <a href="/studio" onClick={linkClick} className={`${cls(false)} no-underline`}>
          <StudioIcon width={20} height={20} className="flex-none" />
          Studio
        </a>
      </nav>
      <div className="flex flex-col gap-1 pt-3">
        <a href="/studio/innstillinger" onClick={linkClick} className={`${cls(false)} no-underline`}>
          <SettingsIcon width={20} height={20} className="flex-none" />
          Innstillinger
        </a>
      </div>
    </aside>
  );
}

/** Mobil og app: fem faner. «Mer» har DJ-verktøy, Analyse, Studio og Innstillinger. Søk er knappen øverst til høyre. */
export function BottomNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const [more, setMore] = useState(false);
  const inMore = view === 'dj' || view === 'stats';
  const cls = (active: boolean) => `relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? 'text-accent' : 'text-muted'}`;
  const tab = (id: View, Icon: IconT) => (
    <button type="button" className={cls(view === id)} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
      {view === id && <span aria-hidden="true" className="gv-neon absolute top-0 h-0.5 w-8 rounded-full bg-accent" />}
      <Icon width={22} height={22} />
      {VIEW_LABEL[id]}
    </button>
  );
  return (
    <>
      <nav aria-label="Hovedmeny" className="fixed inset-x-0 bottom-0 z-30 flex bg-sunken/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_rgba(255,255,255,0.05),0_-12px_30px_rgba(0,0,0,0.45)] lg:hidden">
        {tab('home', HomeIcon)}
        {tab('library', LibraryIcon)}
        {tab('sets', PulseIcon)}
        {tab('playlists', PlaylistIcon)}
        <button type="button" className={cls(inMore)} aria-haspopup="dialog" aria-expanded={more} aria-current={inMore ? 'page' : undefined} onClick={() => setMore(true)}>
          {inMore && <span aria-hidden="true" className="gv-neon absolute top-0 h-0.5 w-8 rounded-full bg-accent" />}
          <MoreIcon width={22} height={22} />
          {inMore ? VIEW_LABEL[view] : 'Mer'}
        </button>
      </nav>
      {more && (
        <MoreSheet
          view={view}
          onClose={() => setMore(false)}
          onPick={(v) => {
            setMore(false);
            setView(v);
          }}
        />
      )}
    </>
  );
}

function MoreSheet({ view, onClose, onPick }: { view: View; onClose: () => void; onPick: (v: View) => void }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  const row = 'flex min-h-14 w-full items-center gap-4 rounded-xl px-3 text-left text-[15px] text-ink-strong no-underline active:bg-white/[0.08]';
  const pick = (id: View, Icon: IconT, hint: string) => (
    <li>
      <button type="button" aria-current={view === id ? 'page' : undefined} onClick={() => onPick(id)} className={`${row} ${view === id ? 'text-accent' : ''}`}>
        <Icon width={22} height={22} className="flex-none" />
        <span className="flex flex-col">
          {VIEW_LABEL[id]}
          <span className="text-[12px] text-muted">{hint}</span>
        </span>
      </button>
    </li>
  );
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/55 lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Mer" tabIndex={-1} className="fixed inset-x-0 bottom-0 rounded-t-2xl bg-surface px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 focus:outline-none">
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15" />
        <ul className="m-0 flex list-none flex-col p-0">
          {pick('dj', DjIcon, 'Passer etter, BPM og toneart')}
          {pick('stats', AnalyticsIcon, 'Avspillinger og katalogen i tall')}
          <li>
            <a href="/studio" onClick={(e) => (onClose(), linkClick(e))} className={row}>
              <StudioIcon width={22} height={22} className="flex-none" />
              <span className="flex flex-col">
                Studio
                <span className="text-[12px] text-muted">Arkiv, album, drops og redigering</span>
              </span>
            </a>
          </li>
          <li>
            <a href="/studio/innstillinger" onClick={(e) => (onClose(), linkClick(e))} className={row}>
              <SettingsIcon width={22} height={22} className="flex-none" />
              <span className="flex flex-col">
                Innstillinger
                <span className="text-[12px] text-muted">Mapper, skin og tilgang</span>
              </span>
            </a>
          </li>
        </ul>
        <button type="button" onClick={onClose} className="mt-1 h-12 w-full rounded-full text-sm text-muted">
          Lukk
        </button>
      </div>
    </div>,
    document.body
  );
}
