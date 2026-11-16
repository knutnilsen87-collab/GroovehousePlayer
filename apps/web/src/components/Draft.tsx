import { useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { isDraft, type AssetManifest, type StatusFilter } from '@gv/shared/web';
import { skinTrackVars } from '../lib/skin';

/**
 * Del 16: utkast holdes atskilt og er tydelig merket overalt:
 *  - UTKAST-brikke i mono
 *  - stiplet kant på cover og miniatyrer (CoverArt `draft`)
 *  - dempet glød (aksenten på 50 %)
 */
export function DraftBadge({ m, className = '' }: { m: Pick<AssetManifest, 'version' | 'status'>; className?: string }) {
  if (!isDraft(m)) return null;
  return (
    <span title="Umastret – holdes atskilt fra release-klare" className={`inline-flex flex-none items-center rounded border border-dashed border-white/40 px-1 py-px align-middle font-mono text-[9px] font-semibold tracking-[0.14em] text-soft ${className}`}>
      UMASTRET
    </span>
  );
}

/**
 * CSS-variablene for en låt i gjeldende skin (del 19): Kameleon bruker låtas palett (cover eller manuell farge),
 * faste skins bruker sine egne aksenter. Utkast får halv glød (del 16).
 */
export function trackVars(m: Pick<AssetManifest, 'palette' | 'version' | 'status'>): CSSProperties {
  return skinTrackVars(m.palette, isDraft(m)) as CSSProperties;
}

// ---------------------------------------------------------------- Segment: Release-klar · Utkast · Alle

const KEY = (view: string) => `gv:status:${view}`;
const read = (view: string, dflt: StatusFilter): StatusFilter => {
  try {
    const v = localStorage.getItem(KEY(view));
    return v === 'draft' || v === 'all' || v === 'release' ? v : dflt;
  } catch {
    return dflt;
  }
};

/**
 * Valget huskes per visning (bibliotek, hjem, dj, søk …). Standard: bare release-klare, unntatt der
 * Knut har bedt om begge (del 16, 2026-11-15): DJ-verktøy («Passer etter …») og Ctrl+K tar med umastrede.
 */
export function useStatusFilter(view: string, dflt: StatusFilter = 'release'): [StatusFilter, (f: StatusFilter) => void] {
  const [f, setF] = useState<StatusFilter>(() => read(view, dflt));
  return [
    f,
    (next) => {
      setF(next);
      try {
        localStorage.setItem(KEY(view), next);
      } catch {
        /* privat modus */
      }
    }
  ];
}

export function StatusSegment({ value, onChange, counts }: { value: StatusFilter; onChange: (f: StatusFilter) => void; counts?: { release: number; draft: number } }) {
  const opts: Array<[StatusFilter, string]> = [
    ['release', 'Release-klar'],
    ['draft', 'Umastret'],
    ['all', 'Alle']
  ];
  return (
    <div role="radiogroup" aria-label="Status" className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-0.5">
      {opts.map(([id, name]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`h-8 rounded-lg px-3 text-xs ${value === id ? 'gv-neon-soft border border-accent/70 bg-accent/[0.12] font-semibold text-accent' : 'border border-transparent text-soft hover:text-ink-strong'}`}
        >
          {name}
          {counts && id !== 'all' && <span className="ml-1 font-mono text-[10px] text-muted">{counts[id]}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- «Denne låta er umastret – legg til likevel?»

interface ConfirmState {
  ask: { listId: string; listName: string; resolve: (ok: boolean) => void } | null;
  confirm: (listId: string, listName: string) => Promise<boolean>;
}
const skipKey = (id: string) => `gv:draftok:${id}`;
export const useDraftConfirm = create<ConfirmState>((set) => ({
  ask: null,
  confirm: (listId, listName) => {
    try {
      if (localStorage.getItem(skipKey(listId)) === '1') return Promise.resolve(true);
    } catch {
      /* privat modus */
    }
    return new Promise((resolve) => set({ ask: { listId, listName, resolve } }));
  }
}));

export function DraftConfirmHost() {
  const ask = useDraftConfirm((s) => s.ask);
  const [dontAsk, setDontAsk] = useState(false);
  if (!ask) return null;
  const done = (ok: boolean) => {
    if (ok && dontAsk) {
      try {
        localStorage.setItem(skipKey(ask.listId), '1');
      } catch {
        /* privat modus */
      }
    }
    ask.resolve(ok);
    setDontAsk(false);
    useDraftConfirm.setState({ ask: null });
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 p-3 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div role="alertdialog" aria-modal="true" aria-label="Umastret låt i vanlig liste" className="gv-panel w-full max-w-md !bg-surface p-5">
        <h2 className="m-0 text-base font-semibold text-ink-strong">Denne låta er umastret – legg til likevel?</h2>
        <p className="m-0 mt-2 text-sm text-soft">
          «{ask.listName}» er en vanlig liste. Umastrede låter hører vanligvis hjemme i en Album-plan eller Sett-plan, så de ikke blandes med det som er klart for release.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-soft">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Ikke spør igjen for denne lista
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => done(false)} className="h-10 rounded-full px-4 text-sm text-muted hover:text-ink">
            Avbryt
          </button>
          <button type="button" autoFocus onClick={() => done(true)} className="h-10 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
            Legg til likevel
          </button>
        </div>
      </div>
    </div>
  );
}
