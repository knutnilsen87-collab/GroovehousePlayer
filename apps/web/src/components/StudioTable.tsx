import { useEffect, useRef, useState } from 'react';
import { bpmUncertain, formatTime, isDraft, isReleased, keyShort } from '@gv/shared/web';
import { assetUrl, variantName, type LoadedAsset, type Track } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { DRAG_ITEMS } from './Playlists';
import type { AddItem } from '../lib/playlists';
import { CoverArt } from './CoverArt';
import { DraftBadge, trackVars } from './Draft';
import { HeartButton } from './Deck';
import { ChevronDownIcon, EqIcon, MoreIcon } from './Icons';

export type SortKey = 'none' | 'title' | 'artist' | 'bpm' | 'key' | 'lufs' | 'duration';
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

/** Sorterer låtene (BPM, toneart via Camelot, LUFS …). Køen følger rekkefølgen du ser. */
export function sortTracks(tracks: Track[], s: Sort): Track[] {
  if (s.key === 'none') return tracks;
  const val = (t: Track): number | string => {
    const m = t.main.manifest;
    switch (s.key) {
      case 'title':
        return m.title.toLowerCase();
      case 'artist':
        return (m.artist ?? '').toLowerCase();
      case 'bpm':
        return m.bpm ?? -1;
      case 'key': {
        const c = /^(\d+)([AB])$/.exec(m.key?.camelot ?? '');
        return c ? Number(c[1]) * 2 + (c[2] === 'B' ? 1 : 0) : 99;
      }
      case 'lufs':
        return m.loudness.integratedLufs;
      case 'duration':
        return m.durationMs;
    }
    return 0;
  };
  return [...tracks].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * s.dir;
  });
}

export function VariantSelect({ t, value, onChange }: { t: Track; value: LoadedAsset; onChange: (v: LoadedAsset) => void }) {
  if (t.variants.length < 2) return null;
  return (
    <label className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span className="sr-only">Variant av {t.main.manifest.title}</span>
      <span className="relative inline-flex items-center">
        <select
          value={value.manifest.id}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange(t.variants.find((v) => v.manifest.id === e.target.value)!)}
          className="appearance-none bg-transparent pr-4 text-[11px] text-soft focus:outline-none"
        >
          {t.variants.map((v) => (
            <option key={v.manifest.id} value={v.manifest.id} className="bg-surface text-ink">
              {variantName(v)} · {formatTime(v.manifest.durationMs)}
            </option>
          ))}
        </select>
        <ChevronDownIcon width={12} height={12} className="pointer-events-none absolute right-0 text-soft" />
      </span>
      <span aria-hidden="true" className="rounded bg-white/[0.04] px-1 font-mono text-[11px] tracking-[1px]">
        {t.variants.length} VAR
      </span>
    </label>
  );
}

/**
 * Del 14: låttabellen under dekket. Kolonner: #, cover, tittel, artist, BPM (sorterbar), toneart, LUFS,
 * varighet, hjerte og «⋯». Raden som spilles får aksent-bakgrunn og equalizer-ikon i stedet for nummeret.
 * Desktop: klikk velger, Ctrl/Shift = flervalg, dra til en liste, høyreklikk = «⋯».
 */
export function StudioTable({
  tracks,
  onPlay,
  selected,
  onSelect,
  itemsFor,
  onContext,
  sort,
  onSort,
  limit,
  label = 'Låter'
}: {
  tracks: Track[];
  onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void;
  selected: string[];
  onSelect: (slug: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  itemsFor: (slug: string) => AddItem[];
  onContext: (slug: string, at: { x: number; y: number }) => void;
  sort?: Sort;
  onSort?: (s: Sort) => void;
  limit?: number;
  label?: string;
}) {
  const { queue, index, playing } = usePlayer();
  const cur = queue[index];
  const rows = limit ? tracks.slice(0, limit) : tracks;
  const wrapRef = useRef<HTMLDivElement>(null);
  const ROW_H = 58;
  const virtualize = !limit && rows.length > 50;
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(rows.length, 32)]);

  useEffect(() => {
    if (!virtualize) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight || 900;
      const topOffset = Math.max(0, -rect.top);
      const start = Math.max(0, Math.floor(topOffset / ROW_H) - 12);
      const end = Math.min(rows.length, Math.ceil((topOffset + vh) / ROW_H) + 16);
      setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
    };
    update();
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [virtualize, rows.length]);

  const [vStart, vEnd] = virtualize ? [Math.min(range[0], rows.length), Math.min(Math.max(range[1], range[0] + 24), rows.length)] : [0, rows.length];
  const visibleRows = virtualize ? rows.slice(vStart, vEnd) : rows;
  const topPad = virtualize ? vStart * ROW_H : 0;
  const bottomPad = virtualize ? Math.max(0, (rows.length - vEnd) * ROW_H) : 0;

  const head = (key: SortKey, name: string, cls = '') => {
    const active = sort?.key === key;
    const ariaSort = active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none';
    return (
      <th scope="col" aria-sort={onSort ? ariaSort : undefined} className={`pb-3 font-semibold ${cls}`}>
        {onSort ? (
          <button
            type="button"
            onClick={() => onSort(active ? (sort!.dir === 1 ? { key, dir: -1 } : { key: 'none', dir: 1 }) : { key, dir: key === 'bpm' ? -1 : 1 })}
            className={`inline-flex items-center gap-1 font-label text-[11px] font-bold uppercase tracking-[0.16em] ${active ? 'text-accent' : 'text-muted hover:text-ink-strong'}`}
          >
            {name}
            {active && <ChevronDownIcon width={11} height={11} className={sort!.dir === 1 ? 'rotate-180' : ''} />}
          </button>
        ) : (
          <span className="font-label text-[11px] font-bold uppercase tracking-[0.16em] text-muted">{name}</span>
        )}
      </th>
    );
  };
  return (
    <div ref={wrapRef} className="gv-panel gv-scroll hidden overflow-x-auto px-4 pb-3 pt-3.5 lg:block">
      {selected.length > 1 && <p className="m-0 mb-2 text-[11px] text-soft">{selected.length} valgt · dra til en liste i sidemenyen, eller høyreklikk → Legg til i spilleliste · Esc fjerner valget</p>}
      <table aria-label={label} className="w-full min-w-[720px] border-collapse text-[14px]">
        <thead>
          <tr className="text-left font-label text-[11px] font-bold text-muted">
            <th scope="col" className="w-10 pb-3 pl-2.5 font-semibold">
              #
            </th>
            <th scope="col" className="w-12 pb-3 font-semibold">
              <span className="sr-only">Cover</span>
            </th>
            {head('title', 'Tittel')}
            {head('artist', 'Artist', 'w-[18%] hidden xl:table-cell')}
            {head('bpm', 'BPM', 'w-20')}
            {head('key', 'Toneart', 'w-24')}
            {head('lufs', 'LUFS', 'w-20')}
            {head('duration', 'Varighet', 'w-24')}
            <th scope="col" className="w-20 pb-3 font-semibold">
              <span className="sr-only">Handlinger</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {topPad > 0 && (
            <tr aria-hidden="true">
              <td colSpan={9} style={{ height: topPad, padding: 0 }} />
            </tr>
          )}
          {visibleRows.map((t, idx) => {
            const i = vStart + idx;
            const isCur = cur?.manifest.slug === t.slug;
            const a = isCur ? cur! : t.main;
            const m = a.manifest;
            const sel = selected.includes(t.slug);
            return (
              <tr
                key={t.slug}
                draggable
                aria-selected={sel}
                aria-current={isCur ? 'true' : undefined}
                onDragStart={(e) => {
                  if (!sel) onSelect(t.slug, { ctrlKey: false, metaKey: false, shiftKey: false });
                  const items = itemsFor(t.slug);
                  e.dataTransfer.setData(DRAG_ITEMS, JSON.stringify(items));
                  e.dataTransfer.setData('text/plain', items.length > 1 ? `${items.length} låter` : m.title);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button,select,input,a')) return;
                  onSelect(t.slug, e);
                }}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest('button,select,input,a')) return;
                  onPlay(t);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContext(t.slug, { x: e.clientX, y: e.clientY });
                }}
                className={`group transition-colors [&>td:last-child]:rounded-r-lg ${
                  isCur ? 'bg-accent/[0.05] [&>td:first-child]:shadow-[inset_2px_0_0_var(--accent)]' : sel ? 'bg-white/[0.08] [&>td:first-child]:rounded-l-lg' : 'hover:bg-white/[0.035] [&>td:first-child]:rounded-l-lg'
                }`}
                style={isCur ? undefined : trackVars(m)}
              >
                <td className="py-2.5 pl-2.5 font-mono text-[13px] text-soft">{isCur ? <EqIcon playing={playing} width={18} height={18} className="text-accent" /> : i + 1}</td>
                <td className="py-2.5">
                  <button type="button" onClick={() => onPlay(t)} aria-label={`Spill ${m.title}`} className="block">
                    <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={38} rounded={7} draft={isDraft(m)} released={isReleased(m)} />
                  </button>
                </td>
                <td className="py-2.5 pr-4">
                  <div className="flex min-w-0 flex-col">
                    <button type="button" onClick={() => onPlay(t)} className={`truncate text-left text-[14.5px] ${isCur ? 'font-bold text-accent' : 'font-semibold text-ink-strong'} hover:underline`}>
                      {m.title}
                      {m.kind === 'set' && <span className="ml-2 rounded bg-white/[0.08] px-1 align-middle font-label text-[11px] font-bold tracking-[0.14em] text-soft">LIVE</span>}
                      <DraftBadge m={m} className="ml-2" />
                    </button>
                    <VariantSelect t={t} value={a} onChange={(v) => onPlay(t, v)} />
                  </div>
                </td>
                <td className="hidden truncate py-2.5 pr-3 text-[13.5px] font-normal text-soft xl:table-cell">{m.artist ?? 'Echo Groove'}</td>
                <td className="py-2.5 font-mono text-[13.5px] font-medium text-ink-strong">{m.bpm != null ? <span title={bpmUncertain(m) ? 'Usikker BPM – sjekk med øret' : undefined}>{bpmUncertain(m) ? '≈' : ''}{Math.round(m.bpm)}</span> : '–'}</td>
                <td className="py-2.5 font-mono text-[13.5px] font-medium text-ink-strong">
                  {m.key ? (
                    <>
                      {keyShort(m.key.name)} <span className="font-normal text-soft">{m.key.camelot}</span>
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="py-2.5 font-mono text-[13.5px] font-medium text-ink-strong">{m.loudness.integratedLufs.toFixed(1)}</td>
                <td className="py-2.5 font-mono text-[13.5px] font-medium text-ink-strong">{formatTime(m.durationMs)}</td>
                <td className="py-2.5 pr-1.5">
                  <div className="flex items-center justify-end gap-0.5">
                    <HeartButton
                      slug={m.slug}
                      title={m.title}
                      size={18}
                      className={`h-8 w-8 transition-opacity ${isCur ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-pressed:opacity-100'}`}
                    />
                    <button
                      type="button"
                      aria-label={`Flere valg for ${m.title}`}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        onContext(t.slug, { x: r.left - 220, y: r.bottom });
                      }}
                      className={`flex h-8 w-8 items-center justify-center rounded-full text-soft transition-opacity hover:bg-white/[0.06] hover:text-ink-strong ${
                        isCur ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'
                      }`}
                    >
                      <MoreIcon width={17} height={17} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {bottomPad > 0 && (
            <tr aria-hidden="true">
              <td colSpan={9} style={{ height: bottomPad, padding: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
