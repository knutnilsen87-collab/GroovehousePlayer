import { useState } from 'react';
import { create } from 'zustand';
import { useDialog } from '../lib/dialog';
import { lockVersionLabel } from '../lib/lock';

/**
 * Del 27 pkt. 7–8: «DJ-klar». Låter i et sett (Sett-plan) låses til versjonen som er valgt nå, så cue-punktene
 * følger riktig fil også etter en ny bounce (v4). Versjonen bekreftes før lagring, og første gang forklares det.
 */
export interface LockItem {
  title: string;
  variantLabel: string | null;
  version: number;
}

const EXPLAINED_KEY = 'gv:hint:dj-lock';
export function lockExplained(): boolean {
  try {
    return localStorage.getItem(EXPLAINED_KEY) === '1';
  } catch {
    return false;
  }
}
function markExplained() {
  try {
    localStorage.setItem(EXPLAINED_KEY, '1');
  } catch {
    /* privat modus */
  }
}
/** Innstillinger → Hjelp → «Vis hint igjen» (del 27 pkt. 16). */
export function resetLockHint() {
  try {
    localStorage.removeItem(EXPLAINED_KEY);
  } catch {
    /* privat modus */
  }
}

interface Ask {
  listName: string;
  items: LockItem[];
  resolve: (ok: boolean) => void;
}
export const useLockConfirm = create<{ ask: Ask | null; confirm: (listName: string, items: LockItem[]) => Promise<boolean> }>((set) => ({
  ask: null,
  confirm: (listName, items) => (items.length ? new Promise((resolve) => set({ ask: { listName, items, resolve } })) : Promise.resolve(true))
}));

export function LockConfirmHost() {
  const ask = useLockConfirm((s) => s.ask);
  if (!ask) return null;
  return <LockConfirm ask={ask} />;
}

function LockConfirm({ ask }: { ask: Ask }) {
  const [first] = useState(() => !lockExplained());
  const done = (ok: boolean) => {
    if (ok) markExplained();
    ask.resolve(ok);
    useLockConfirm.setState({ ask: null });
  };
  const ref = useDialog<HTMLDivElement>(() => done(false));
  const shown = ask.items.slice(0, 8);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 p-3 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="gv-lock-title" aria-describedby="gv-lock-text" tabIndex={-1} className="gv-panel w-full max-w-md !bg-surface p-5 focus:outline-none">
        <h2 id="gv-lock-title" className="m-0 text-base font-semibold text-ink-strong">
          {ask.items.length === 1 ? 'Lås versjonen i settet?' : `Lås versjonene i settet (${ask.items.length})?`}
        </h2>
        <p id="gv-lock-text" className="m-0 mt-2 text-sm text-soft">
          {first ? 'Denne versjonen låses, slik at cue-punktene følger riktig fil. En ny bounce (ny versjon) endrer ikke settet – du bytter selv når du vil.' : `«${ask.listName}» er et sett: versjonene låses.`}
        </p>
        <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0 text-sm">
          {shown.map((it, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-ink-strong">
                {it.title}
                {it.variantLabel ? <span className="text-muted"> · {it.variantLabel}</span> : null}
              </span>
              <span className="flex-none font-mono text-[12px] text-soft">Låst til {lockVersionLabel(it.version)}</span>
            </li>
          ))}
          {ask.items.length > shown.length && <li className="text-[12px] text-muted">… og {ask.items.length - shown.length} til</li>}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => done(false)} className="h-11 rounded-full px-4 text-sm text-muted hover:text-ink">
            Avbryt
          </button>
          <button type="button" data-autofocus onClick={() => done(true)} className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent">
            Lås og lagre
          </button>
        </div>
      </div>
    </div>
  );
}
