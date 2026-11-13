import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '@gv/shared/web';
import { assetUrl, variantName, type LoadedAsset } from '../lib/catalog';
import { CoverArt } from './CoverArt';

/**
 * Ctrl/Cmd + K. Skriv «126», «8A», «sett», «extended» eller deler av tittelen – alle ord må treffe.
 *  - 2–3 sifre (evt. med desimal) = BPM ± 1,5
 *  - 1–12 + A/B = Camelot-toneart
 *  - sett/set/live = bare live-sett, låt/track = bare låter
 */
export function matches(a: LoadedAsset, query: string): boolean {
  const m = a.manifest;
  const hay = [m.title, m.slug, m.variantLabel, m.artist, m.venue, m.key?.name].filter(Boolean).join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => {
      if (/^\d{2,3}([.,]\d)?$/.test(tok)) return m.bpm != null && Math.abs(m.bpm - Number(tok.replace(',', '.'))) <= 1.5;
      if (/^(1[0-2]|[1-9])[ab]$/.test(tok)) return m.key?.camelot.toLowerCase() === tok;
      if (['sett', 'set', 'live'].includes(tok)) return m.kind === 'set';
      if (['låt', 'lat', 'track', 'låter'].includes(tok)) return m.kind === 'track';
      return hay.includes(tok);
    });
}

export function CommandPalette({ open, onClose, assets, onPick }: { open: boolean; onClose: () => void; assets: LoadedAsset[]; onPick: (list: LoadedAsset[], i: number) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (q.trim() ? assets.filter((a) => matches(a, q)) : assets).slice(0, 30), [assets, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
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
      <div role="dialog" aria-modal="true" aria-label="Søk i katalogen" className="w-full max-w-[620px] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl">
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
                <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={36} rounded={6} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold text-ink-strong">
                    {m.title}
                    {m.variant && <span className="font-normal text-muted"> · {variantName(a)}</span>}
                  </span>
                  <span className="text-[11px] text-muted">{m.kind === 'set' ? 'Live-sett' : 'Låt'}</span>
                </span>
                <span className="tabular hidden text-xs text-muted sm:block">{m.bpm ? `${m.bpm} BPM` : ''}</span>
                <span className="tabular w-8 text-right text-xs font-semibold text-champagne">{m.key?.camelot ?? ''}</span>
                <span className="tabular w-12 text-right text-xs text-muted">{formatTime(m.durationMs)}</span>
              </li>
            );
          })}
        </ul>
        <p className="m-0 border-t border-white/[0.06] px-5 py-2.5 text-[11px] text-muted">↑↓ for å velge · Enter for å spille · Esc for å lukke</p>
      </div>
    </div>
  );
}
