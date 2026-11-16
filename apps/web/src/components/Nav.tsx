import { useState, type ReactNode } from 'react';
import { Logo } from './Brand';
import { AnalyticsIcon, ChevronDownIcon, DjIcon, HomeIcon, LibraryIcon, PlaylistIcon, PulseIcon, SearchIcon, SettingsIcon, StudioIcon, VaultIcon } from './Icons';

/** Del 14: visningene i spilleren. */
export type View = 'home' | 'library' | 'playlists' | 'sets' | 'dj' | 'stats';

type IconT = typeof HomeIcon;

/**
 * Venstre sidemeny (desktop), tilpasset Knuts innhold: Hjem, Bibliotek, Spillelister (utvidbar, med
 * fargeprikkene fra del 9), Live-sett, DJ-verktøy, Analyse, Vault (Studio). Innstillinger nederst.
 */
export function Sidebar({ view, setView, onSearch, playlists }: { view: View; setView: (v: View) => void; onSearch: () => void; playlists?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const cls = (active: boolean) =>
    `flex min-h-[46px] w-full items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-left text-[15px] transition-colors ${
      active ? 'gv-neon-soft border border-accent/70 bg-accent/[0.14] font-semibold text-ink-strong [&>svg]:text-accent' : 'border border-transparent text-soft hover:bg-white/[0.04] hover:text-ink-strong [&>svg]:text-soft hover:[&>svg]:text-ink-strong'
    }`;
  const item = (id: View, label: string, Icon: IconT) => (
    <button type="button" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)} className={cls(view === id)}>
      <Icon width={20} height={20} className="flex-none" />
      {label}
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
        className="flex min-h-[44px] w-full items-center gap-3 rounded-xl border border-white/[0.09] bg-sunken/80 px-3.5 py-2 text-left text-[14px] text-soft shadow-inner transition-colors hover:border-accent/50 hover:bg-white/[0.04] hover:text-ink-strong"
      >
        <SearchIcon width={18} height={18} className="flex-none text-soft" />
        <span className="truncate">Søk…</span>
        <kbd className="ml-auto rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted">Ctrl K</kbd>
      </button>
      <nav aria-label="Hovedmeny" className="gv-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1">
        {item('home', 'Hjem', HomeIcon)}
        {item('library', 'Bibliotek', LibraryIcon)}
        <div className="flex flex-col">
          <div className="flex items-center">
            <button type="button" aria-current={view === 'playlists' ? 'page' : undefined} onClick={() => setView('playlists')} className={cls(view === 'playlists')}>
              <PlaylistIcon width={20} height={20} className="flex-none" />
              Spillelister
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
          {open && <div className="ml-5 mt-1.5 border-l border-white/[0.09] pl-3">{playlists}</div>}
        </div>
        {item('sets', 'Live-sett', PulseIcon)}
        {item('dj', 'DJ-verktøy', DjIcon)}
        {item('stats', 'Analyse', AnalyticsIcon)}
        <a href="/studio" className={`${cls(false)} no-underline`}>
          <VaultIcon width={20} height={20} className="flex-none" />
          Vault
          <span className="ml-auto font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Studio</span>
        </a>
      </nav>
      <div className="flex flex-col gap-1 border-t border-white/[0.07] pt-3">
        <a href="/studio/innstillinger" className={`${cls(false)} no-underline`}>
          <SettingsIcon width={20} height={20} className="flex-none" />
          Innstillinger
        </a>
      </div>
    </aside>
  );
}

/** Mobil og app: fem faner. Søk er knappen øverst til høyre. */
export function BottomNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  const cls = (active: boolean) => `relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium ${active ? 'text-accent' : 'text-muted'}`;
  const tab = (id: View, label: string, Icon: IconT) => (
    <button type="button" className={cls(view === id)} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
      {view === id && <span aria-hidden="true" className="gv-neon absolute top-0 h-0.5 w-8 rounded-full bg-accent" />}
      <Icon width={22} height={22} />
      {label}
    </button>
  );
  return (
    <nav aria-label="Hovedmeny" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-white/[0.07] bg-sunken/95 pb-[env(safe-area-inset-bottom)] lg:hidden">
      {tab('home', 'Hjem', HomeIcon)}
      {tab('library', 'Bibliotek', LibraryIcon)}
      {tab('sets', 'Live-sett', PulseIcon)}
      {tab('playlists', 'Lister', PlaylistIcon)}
      <a href="/studio" className={`${cls(false)} no-underline`}>
        <StudioIcon width={22} height={22} />
        Studio
      </a>
    </nav>
  );
}
