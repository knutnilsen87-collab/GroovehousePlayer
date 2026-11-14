import { formatTime, isDraft, keyShort } from '@gv/shared/web';
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
      <span aria-hidden="true" className="rounded border border-white/10 px-1 font-mono text-[9px] tracking-[1px]">
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
  const head = (key: SortKey, name: string, cls = '') => {
    const active = sort?.key === key;
    const ariaSort = active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none';
    return (
      <th scope="col" aria-sort={onSort ? ariaSort : undefined} className={`pb-2.5 font-normal ${cls}`}>
        {onSort ? (
          <button
            type="button"
            onClick={() => onSort(active ? (sort!.dir === 1 ? { key, dir: -1 } : { key: 'none', dir: 1 }) : { key, dir: key === 'bpm' ? -1 : 1 })}
            className={`inline-flex items-center gap-1 uppercase tracking-[0.16em] ${active ? 'text-accent' : 'hover:text-ink-strong'}`}
          >
            {name}
            {active && <ChevronDownIcon width={11} height={11} className={sort!.dir === 1 ? 'rotate-180' : ''} />}
          </button>
        ) : (
          <span className="uppercase tracking-[0.16em]">{name}</span>
        )}
      </th>
    );
  };
  return (
    <div className="gv-panel gv-scroll hidden overflow-x-auto px-4 pb-2 pt-3 lg:block">
      {selected.length > 1 && <p className="m-0 mb-2 text-[11px] text-muted">{selected.length} valgt · dra til en liste i sidemenyen, eller høyreklikk → Legg til i spilleliste · Esc fjerner valget</p>}
      <table aria-label={label} className="w-full min-w-[720px] border-collapse text-[14px]">
        <thead>
          <tr className="text-left font-mono text-[11px] text-soft">
            <th scope="col" className="w-10 pb-2.5 pl-2 font-normal">
              #
            </th>
            <th scope="col" className="w-12 pb-2.5 font-normal">
              <span className="sr-only">Cover</span>
            </th>
            {head('title', 'Tittel')}
            {head('artist', 'Artist', 'w-[16%] hidden 2xl:table-cell')}
            {head('bpm', 'BPM', 'w-20')}
            {head('key', 'Toneart', 'w-24')}
            {head('lufs', 'LUFS', 'w-20')}
            {head('duration', 'Varighet', 'w-24')}
            <th scope="col" className="w-20 pb-2.5 font-normal">
              <span className="sr-only">Handlinger</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
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
                className={`group border-t border-white/[0.05] first:border-t-0 ${
                  isCur ? 'gv-neon-soft bg-accent/[0.16] [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg' : sel ? 'bg-white/[0.07]' : 'hover:bg-white/[0.025]'
                }`}
                style={isCur ? undefined : trackVars(m)}
              >
                <td className="py-1.5 pl-2 font-mono text-[13px] text-muted">{isCur ? <EqIcon playing={playing} width={18} height={18} className="text-accent" /> : i + 1}</td>
                <td className="py-1.5">
                  <button type="button" onClick={() => onPlay(t)} aria-label={`Spill ${m.title}`} className="block">
                    <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={36} rounded={6} draft={isDraft(m)} />
                  </button>
                </td>
                <td className="py-1.5 pr-4">
                  <div className="flex min-w-0 flex-col">
                    <button type="button" onClick={() => onPlay(t)} className={`truncate text-left font-semibold ${isCur ? 'text-ink-strong' : 'text-ink'} hover:underline`}>
                      {m.title}
                      {m.kind === 'set' && <span className="ml-2 rounded border border-white/15 px-1 align-middle font-mono text-[9px] tracking-[1px] text-soft">LIVE</span>}
                      <DraftBadge m={m} className="ml-2" />
                    </button>
                    <VariantSelect t={t} value={a} onChange={(v) => onPlay(t, v)} />
                  </div>
                </td>
                <td className="hidden truncate py-1.5 pr-3 font-mono text-[13px] text-soft 2xl:table-cell">{m.artist ?? 'Echo Groove'}</td>
                <td className="py-1.5 font-mono text-[13px] text-ink">{m.bpm != null ? Math.round(m.bpm) : '–'}</td>
                <td className="py-1.5 font-mono text-[13px] text-ink">
                  {m.key ? (
                    <>
                      {keyShort(m.key.name)} <span className="text-muted">{m.key.camelot}</span>
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="py-1.5 font-mono text-[13px] text-ink">{m.loudness.integratedLufs.toFixed(1)}</td>
                <td className="py-1.5 font-mono text-[13px] text-ink">{formatTime(m.durationMs)}</td>
                <td className="py-1.5 pr-1">
                  <div className="flex items-center justify-end gap-0.5">
                    <HeartButton slug={m.slug} title={m.title} size={18} className="h-8 w-8" />
                    <button
                      type="button"
                      aria-label={`Flere valg for ${m.title}`}
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        onContext(t.slug, { x: r.left - 220, y: r.bottom });
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-soft hover:bg-white/[0.06] hover:text-ink-strong"
                    >
                      <MoreIcon width={17} height={17} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
