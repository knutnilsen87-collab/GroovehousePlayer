import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { barMs, formatTimeMs, markerKey, snapToBar, withEnds, type AssetMarker, type MarkerKind } from '@gv/shared/web';
import type { LoadedAsset } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { SpectralWaveform } from './SpectralWaveform';
import { PlayIcon, TrashIcon } from './Icons';

/**
 * Del 2: rett strukturmarkørene i Studio → Arkiv.
 *  - Dra en markør (fester seg til takt når BPM finnes; Alt-dra = fritt). Dobbeltklikk legger til.
 *  - Gi nytt navn, slett, godkjenn én eller alle.
 *  - Tastatur på en valgt markør: ←/→ én takt, Shift = fire takter, Delete sletter, Enter godkjenner.
 * Lagres i markers.json (overlever ny ingest) og i manifestet (spilleren bruker dem med en gang).
 */
type Edit = AssetMarker & { _id: number };

const KIND_NAME: Record<MarkerKind, string> = { chapter: 'Seksjon', drop: 'DROP', highlight: 'Høydepunkt', clip: 'Klipp' };

export function MarkerEditor({ a, onSaved, onPlayAt }: { a: LoadedAsset; onSaved: () => void; onPlayAt: (ms: number) => void }) {
  const m = a.manifest;
  const nextId = useRef(1);
  const fromManifest = () => m.markers.map((k) => ({ ...k, _id: nextId.current++ }));
  const [items, setItems] = useState<Edit[]>(fromManifest);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; free: boolean } | null>(null);
  const isCur = usePlayer((s) => s.queue[s.index]?.manifest.id === m.id);
  const pos = usePlayer((s) => (s.queue[s.index]?.manifest.id === m.id ? s.positionMs : 0));
  const sorted = useMemo(() => [...items].sort((x, y) => x.startMs - y.startMs), [items]);

  const change = (fn: (xs: Edit[]) => Edit[]) => {
    setItems((xs) => fn(xs));
    setDirty(true);
    setMsg(null);
  };
  /** Flyttet/omdøpt = Knuts egen (manuell og godkjent). */
  const edit = (id: number, patch: Partial<AssetMarker>) => change((xs) => xs.map((x) => (x._id === id ? { ...x, ...patch, source: 'manual', confirmed: true } : x)));
  const clamp = (ms: number) => Math.max(0, Math.min(m.durationMs, ms));
  const msAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * m.durationMs);
  };
  const remove = (x: Edit) => {
    // Et analyseforslag som slettes, skal ikke komme tilbake ved neste ingest
    if (x.source !== 'manual') setDismissed((d) => [...new Set([...d, markerKey(x)])]);
    change((xs) => xs.filter((y) => y._id !== x._id));
    setSelected(null);
  };
  const add = (ms: number) => {
    const id = nextId.current++;
    const n = sorted.filter((x) => x.kind === 'chapter').length + 1;
    change((xs) => [...xs, { _id: id, kind: 'chapter', source: 'manual', startMs: Math.round(snapToBar(ms, m.bpm)), label: `Seksjon ${n}`, confirmed: true }]);
    setSelected(id);
  };
  const onKey = (e: ReactKeyboardEvent, x: Edit) => {
    const step = barMs(m.bpm) * (e.shiftKey ? 4 : 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      edit(x._id, { startMs: Math.round(clamp(snapToBar(x.startMs + (e.key === 'ArrowRight' ? step : -step), m.bpm))) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(x);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      change((xs) => xs.map((y) => (y._id === x._id ? { ...y, confirmed: true } : y)));
    }
  };
  const onPointerDown = (e: ReactPointerEvent, x: Edit) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: x._id, free: e.altKey };
    setSelected(x._id);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const raw = msAt(e.clientX);
    edit(d.id, { startMs: Math.round(d.free || e.altKey ? raw : snapToBar(raw, m.bpm)) });
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const markers = withEnds(items.map(({ _id: _x, ...k }) => k));
      const r = await fetch(`/api/assets/${encodeURIComponent(m.slug)}/${encodeURIComponent(m.variant ?? 'main')}/v${m.version}/markers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markers, dismissed })
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setDirty(false);
      setMsg({ ok: true, text: 'Lagret. Står seg ved ny ingest av samme versjon.' });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const unconfirmed = items.filter((x) => !x.confirmed).length;
  return (
    <section aria-label={`Markører for ${m.title}`} className="flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="gv-label m-0">Markører</h3>
        <span className="font-mono text-[11px] text-muted">
          {m.bpm ? `${m.bpm} BPM · fester seg til takt (Alt = fritt)` : 'ingen BPM – flyttes fritt'} · dobbeltklikk legger til
        </span>
      </div>

      <div
        ref={track}
        className="relative select-none pt-6"
        onDoubleClick={(e) => add(msAt(e.clientX))}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <SpectralWaveform analysis={a.analysis} durationMs={m.durationMs} progress={isCur ? pos / m.durationMs : 0} active height={88} barPx={3} />
        {sorted.map((x) => {
          const left = `${(x.startMs / m.durationMs) * 100}%`;
          const sel = selected === x._id;
          return (
            <button
              key={x._id}
              type="button"
              role="slider"
              aria-label={`${x.label || KIND_NAME[x.kind]} ved ${formatTimeMs(x.startMs)}${x.confirmed ? '' : ', ubekreftet'}. Piltaster flytter én takt, Shift fire.`}
              aria-valuemin={0}
              aria-valuemax={m.durationMs}
              aria-valuenow={x.startMs}
              aria-valuetext={formatTimeMs(x.startMs)}
              onPointerDown={(e) => onPointerDown(e, x)}
              onKeyDown={(e) => onKey(e, x)}
              onFocus={() => setSelected(x._id)}
              className="absolute bottom-0 top-0 w-4 -translate-x-1/2 cursor-ew-resize touch-none focus:outline-none"
              style={{ left }}
            >
              <span aria-hidden="true" className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 ${x.kind === 'drop' ? 'bg-[#FF6B5A]' : x.confirmed ? 'bg-accent' : 'bg-white/60'} ${sel ? 'gv-neon' : ''}`} />
              <span
                aria-hidden="true"
                className={`absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] ${sel ? 'bg-accent text-on-accent' : x.confirmed ? 'bg-accent/20 text-ink-strong' : 'border border-dashed border-white/40 bg-sunken text-soft'}`}
              >
                {x.label || KIND_NAME[x.kind]}
              </span>
            </button>
          );
        })}
      </div>

      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {sorted.map((x) => (
          <li key={x._id} className={`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 ${selected === x._id ? 'bg-accent/[0.08]' : ''}`}>
            <span className="w-20 font-mono text-xs text-soft">{formatTimeMs(x.startMs).slice(0, 9)}</span>
            <span className="w-20 text-[11px] text-muted">{KIND_NAME[x.kind]}</span>
            <input
              value={x.label ?? ''}
              onChange={(e) => edit(x._id, { label: e.target.value.slice(0, 40) })}
              onFocus={() => setSelected(x._id)}
              aria-label={`Navn på markøren ved ${formatTimeMs(x.startMs)}`}
              className="h-8 min-w-[120px] flex-1 rounded-md border border-white/10 bg-sunken px-2 text-sm text-ink focus:border-accent/60 focus:outline-none"
            />
            <span className={`text-[11px] ${x.source === 'manual' ? 'text-accent' : 'text-muted'}`}>{x.source === 'manual' ? 'manuell' : x.source === 'live_log' ? 'live-logg' : 'forslag'}</span>
            {x.confirmed ? (
              <span className="w-24 text-[11px] text-accent">✓ godkjent</span>
            ) : (
              <button type="button" onClick={() => change((xs) => xs.map((y) => (y._id === x._id ? { ...y, confirmed: true } : y)))} className="h-8 w-24 rounded-full border border-accent/50 text-[11px] font-semibold text-accent">
                Godkjenn
              </button>
            )}
            <button type="button" onClick={() => onPlayAt(x.startMs)} aria-label={`Spill fra ${x.label || 'markøren'}`} className="flex h-8 w-8 items-center justify-center rounded-full text-soft hover:text-ink-strong">
              <PlayIcon width={14} height={14} />
            </button>
            <button type="button" onClick={() => remove(x)} aria-label={`Slett ${x.label || 'markøren'}`} className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:text-[#FF8A7A]">
              <TrashIcon width={14} height={14} />
            </button>
          </li>
        ))}
        {sorted.length === 0 && <li className="text-sm text-muted">Ingen markører. Dobbeltklikk i bølgeformen for å legge til.</li>}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!dirty || busy} onClick={() => void save()} className="h-9 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40">
          Lagre markører
        </button>
        <button type="button" disabled={!unconfirmed} onClick={() => change((xs) => xs.map((y) => ({ ...y, confirmed: true })))} className="h-9 rounded-full border border-white/15 px-3 text-sm text-ink disabled:opacity-40">
          Godkjenn alle{unconfirmed ? ` (${unconfirmed})` : ''}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setItems(fromManifest());
              setDismissed([]);
              setDirty(false);
            }}
            className="h-9 rounded-full px-3 text-sm text-muted hover:text-ink"
          >
            Angre endringer
          </button>
        )}
        {msg && <span className={`text-xs ${msg.ok ? 'text-accent' : 'text-[#FF8A7A]'}`}>{msg.text}</span>}
      </div>
    </section>
  );
}
