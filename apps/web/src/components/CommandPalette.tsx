import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime, isDraft, matchesQuery, matchesStatus } from '@gv/shared/web';
import { assetUrl, variantName, type LoadedAsset } from '../lib/catalog';
import { CoverArt } from './CoverArt';
import { DraftBadge, StatusSegment, useStatusFilter } from './Draft';
import { BoltIcon } from './Icons';

/**
 * Ctrl/Cmd + K. Skriv «126», «8A», «sett», «extended» eller deler av tittelen – alle ord må treffe.
 * Reglene (matchesQuery i @gv/shared) er de samme som smarte spillelister bruker.
 */
export const matches = (a: LoadedAsset, query: string) => matchesQuery(a.manifest, query);

export function CommandPalette({
  open,
  onClose,
  assets,
  onPick,
  onSaveSmart
}: {
  open: boolean;
  onClose: () => void;
  assets: LoadedAsset[];
  onPick: (list: LoadedAsset[], i: number) => void;
  /** «Lagre som smart liste»: lagrer selve søket. */
  onSaveSmart?: (name: string, query: string) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Del 16: bare release-klare som standard; valget huskes
  const [status, setStatus] = useStatusFilter('search', 'all');
  const pool = useMemo(() => assets.filter((a) => matchesStatus(a.manifest, status)), [assets, status]);
  const results = useMemo(() => (q.trim() ? pool.filter((a) => matches(a, q)) : pool).slice(0, 30), [pool, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      setSaving(null);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setSel(0), [q]);

  if (!open) return null;
  const pick = (i: number) => {
    onPick(results, i);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Søk i katalogen" className="w-full max-w-[620px] overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <label htmlFor="gv-search" className="sr-only">
          Søk
        </label>
        <input
          id="gv-search"
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter' && results[sel]) pick(sel);
          }}
          placeholder="Tittel, 126, 8A, sett, extended …"
          role="combobox"
          aria-expanded="true"
          aria-controls="gv-search-results"
          aria-activedescendant={results[sel] ? `gv-r-${sel}` : undefined}
          className="h-14 w-full border-b border-white/[0.08] bg-transparent px-5 text-[15px] text-ink-strong placeholder:text-muted focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-4 py-2">
          <StatusSegment value={status} onChange={setStatus} />
          <span className="font-mono text-[11px] text-muted">{pool.length} treff mulig</span>
        </div>
        <ul id="gv-search-results" role="listbox" className="m-0 max-h-[50vh] list-none overflow-y-auto p-2">
          {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Ingen treff</li>}
          {results.map((a, i) => {
            const m = a.manifest;
            return (
              <li
                key={m.id}
                id={`gv-r-${i}`}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => pick(i)}
                className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ${i === sel ? 'bg-white/[0.07]' : ''}`}
              >
                <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={36} rounded={6} draft={isDraft(m)} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-ink-strong">
                    {m.title}<DraftBadge m={m} className="ml-1.5" />
                    {m.variant && <span className="font-normal text-muted"> · {variantName(a)}</span>}
                  </span>
                  <span className="text-[11px] text-muted">{m.kind === 'set' ? 'Live-sett' : 'Låt'}</span>
                </span>
                <span className="tabular hidden text-xs text-muted sm:block">{m.bpm ? `${m.bpm} BPM` : ''}</span>
                <span className="tabular w-8 text-right text-xs font-semibold text-soft">{m.key?.camelot ?? ''}</span>
                <span className="tabular w-12 text-right text-xs text-muted">{formatTime(m.durationMs)}</span>
              </li>
            );
          })}
        </ul>
        {onSaveSmart && q.trim() && saving === null && (
          <button type="button" onClick={() => setSaving(q.trim())} className="flex min-h-11 w-full items-center gap-2 px-5 text-left text-sm font-semibold text-accent hover:bg-white/[0.04]">
            <BoltIcon width={16} height={16} />
            Lagre som smart liste
            <span className="ml-auto truncate text-xs font-normal text-muted">«{q.trim()}» oppdaterer seg selv</span>
          </button>
        )}
        {onSaveSmart && saving !== null && (
          <form
            className="flex gap-2 border-t border-white/[0.06] px-4 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!saving.trim()) return;
              void onSaveSmart(saving.trim(), q.trim()).then(onClose);
            }}
          >
            <label htmlFor="gv-smart-name" className="sr-only">
              Navn på smart liste
            </label>
            <input id="gv-smart-name" autoFocus value={saving} maxLength={80} onChange={(e) => setSaving(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSaving(null))} className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink-strong focus:border-accent/60 focus:outline-none" />
            <button type="submit" className="h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent">
              Lagre
            </button>
          </form>
        )}
        <p className="m-0 px-5 py-2.5 text-[11px] text-muted">↑↓ for å velge · Enter for å spille · Esc for å lukke</p>
      </div>
    </div>
  );
}
