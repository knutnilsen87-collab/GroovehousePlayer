import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { curveAt, explainTransition, type CurveKind, type SbTrack } from '@gv/shared/web';
import type { LoadedAsset } from '../lib/catalog';
import { trackVars } from './Draft';

/**
 * Del 20 D pkt. 16: settet som tidslinje. x = tid, y = energi 1–10.
 *  - Låtene er blokker i coverfargen (aksenten fra skinnet), overgangene flater farget etter score.
 *  - Målkurven har håndtak som kan dras opp og ned; slipper du, bygges settet på nytt etter den nye kurven
 *    (låste plasser beholdes), så settbyggeren finner låter som treffer den nye toppen.
 *  - Dra en blokk sidelengs for å flytte låta.
 *  - BPM-linje og toneart under.
 * Bare SVG og pekerhendelser – ingen lyd.
 */
const W = 1000;
const H = 220;
const TOP = 10;
const PLOT = 150; // høyden på energidelen
const QUALITY = { good: 'var(--accent)', ok: '#F5C84B', poor: '#FF6B5A' } as const;

export function EnergyTimeline({
  tracks,
  byId,
  curve,
  custom,
  onCurve,
  onMove
}: {
  tracks: SbTrack[];
  byId: Map<string, LoadedAsset>;
  curve: CurveKind;
  custom: number[];
  /** Ny målkurve (punkter 1–10) når et håndtak er sluppet. */
  onCurve: (points: number[]) => void;
  /** Flytt låt fra plass i til plass j. */
  onMove: (i: number, j: number) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const total = tracks.reduce((s, t) => s + t.durationMs, 0) || 1;
  const points = curve === 'custom' && custom.length >= 2 ? custom : Array.from({ length: 9 }, (_, i) => Math.round(curveAt(curve, i / 8) * 10) / 10);
  const [drag, setDrag] = useState<{ kind: 'point'; i: number; pts: number[] } | { kind: 'track'; i: number; dx: number; x0: number } | null>(null);
  const shown = drag?.kind === 'point' ? drag.pts : points;
  const yOf = (e: number) => TOP + PLOT - (e / 10) * PLOT;
  const toSvg = (ev: ReactPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  };
  let at = 0;
  const blocks = tracks.map((t, i) => {
    const x = (at / total) * W;
    const w = (t.durationMs / total) * W;
    at += t.durationMs;
    return { t, i, x, w };
  });
  const bpms = tracks.map((t) => t.bpm).filter((b): b is number => b != null);
  const bLo = Math.min(...bpms, 118) - 1;
  const bHi = Math.max(...bpms, 132) + 1;
  const bpmY = (b: number) => TOP + PLOT + 18 + (1 - (b - bLo) / (bHi - bLo)) * 26;

  return (
    <div className="flex flex-col gap-1">
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="h-56 w-full touch-none select-none"
        role="img"
        aria-label="Energitidslinje: låtene som blokker, målkurven med håndtak, overgangene farget etter score, og BPM under"
        onPointerMove={(ev) => {
          if (!drag) return;
          const p = toSvg(ev);
          if (drag.kind === 'point') {
            const e = Math.max(1, Math.min(10, Math.round(((TOP + PLOT - p.y) / PLOT) * 10 * 2) / 2));
            setDrag({ ...drag, pts: drag.pts.map((v, k) => (k === drag.i ? e : v)) });
          } else setDrag({ ...drag, dx: p.x - drag.x0 });
        }}
        onPointerUp={() => {
          if (!drag) return;
          if (drag.kind === 'point') onCurve(drag.pts);
          else {
            const b = blocks[drag.i]!;
            const mid = b.x + b.w / 2 + drag.dx;
            const j = blocks.findIndex((x) => mid >= x.x && mid < x.x + x.w);
            if (j >= 0 && j !== drag.i) onMove(drag.i, j);
          }
          setDrag(null);
        }}
        onPointerLeave={() => setDrag(null)}
      >
        {/* Rutenett 1–10 */}
        {[2, 4, 6, 8, 10].map((e) => (
          <line key={e} x1={0} x2={W} y1={yOf(e)} y2={yOf(e)} stroke="rgba(255,255,255,0.06)" />
        ))}
        {/* Låtblokker i coverfargen */}
        {blocks.map(({ t, i, x, w }) => {
          const a = byId.get(t.id);
          const dx = drag?.kind === 'track' && drag.i === i ? drag.dx : 0;
          return (
            <g key={`${t.id}-${i}`} style={a ? (trackVars(a.manifest) as CSSProperties) : undefined} transform={`translate(${dx},0)`} className="cursor-grab">
              <rect
                x={x + 1}
                y={yOf(t.energy)}
                width={Math.max(2, w - 2)}
                height={TOP + PLOT - yOf(t.energy)}
                rx={4}
                style={{ fill: 'color-mix(in srgb, var(--accent) 50%, transparent)', stroke: 'var(--accent)', strokeOpacity: 0.6 }}
                onPointerDown={(ev) => {
                  (ev.target as Element).setPointerCapture?.(ev.pointerId);
                  setDrag({ kind: 'track', i, dx: 0, x0: toSvg(ev).x });
                }}
              >
                <title>{`${i + 1}. ${t.title} – energi ${t.energy.toFixed(1)} · ${t.bpm?.toFixed(1) ?? '–'} BPM · ${t.camelot ?? '–'}`}</title>
              </rect>
              {w > 46 && (
                <text x={x + 5} y={TOP + PLOT - 6} fontSize={13} fill="#F5F7FA" style={{ pointerEvents: 'none' }}>
                  {i + 1}
                </text>
              )}
            </g>
          );
        })}
        {/* Overgangene: flate mellom blokkene, farget etter score */}
        {blocks.slice(0, -1).map(({ t, x, w }, i) => {
          const next = tracks[i + 1]!;
          const q = explainTransition(t, next).quality;
          return <rect key={`tr-${i}`} x={x + w - 6} y={TOP + PLOT + 3} width={12} height={8} rx={2} style={{ fill: QUALITY[q] }}>
            <title>{`Overgang ${i + 1}→${i + 2}: ${q === 'good' ? 'god' : q === 'ok' ? 'grei' : 'svak'}`}</title>
          </rect>;
        })}
        {/* Målkurven med håndtak */}
        <polyline points={shown.map((e, k) => `${(k / (shown.length - 1)) * W},${yOf(e)}`).join(' ')} fill="none" stroke="#F5F7FA" strokeWidth={2.5} strokeDasharray="8 6" opacity={0.85} style={{ pointerEvents: 'none' }} />
        {shown.map((e, k) => (
          <circle
            key={k}
            cx={(k / (shown.length - 1)) * W}
            cy={yOf(e)}
            r={drag?.kind === 'point' && drag.i === k ? 13 : 10}
            fill="#F5F7FA"
            stroke="#07080B"
            strokeWidth={2}
            className="cursor-ns-resize"
            role="slider"
            tabIndex={0}
            aria-label={`Målkurve punkt ${k + 1} av ${shown.length}`}
            aria-valuemin={1}
            aria-valuemax={10}
            aria-valuenow={e}
            onPointerDown={(ev) => {
              (ev.target as Element).setPointerCapture?.(ev.pointerId);
              setDrag({ kind: 'point', i: k, pts: [...points] });
            }}
            onKeyDown={(ev) => {
              if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
              ev.preventDefault();
              onCurve(points.map((v, j) => (j === k ? Math.max(1, Math.min(10, v + (ev.key === 'ArrowUp' ? 0.5 : -0.5))) : v)));
            }}
          />
        ))}
        {/* BPM-linje og toneart under */}
        <polyline points={blocks.filter((b) => b.t.bpm).map((b) => `${b.x + b.w / 2},${bpmY(b.t.bpm!)}`).join(' ')} fill="none" stroke="rgba(245,247,250,0.55)" strokeWidth={1.5} />
        {blocks.map(({ t, x, w }, i) =>
          w > 34 ? (
            <text key={`k-${i}`} x={x + w / 2} y={H - 4} fontSize={12} textAnchor="middle" fill="#C6CDD9" style={{ pointerEvents: 'none' }}>
              {t.camelot ?? '–'}
            </text>
          ) : null
        )}
      </svg>
      <p className="m-0 font-mono text-[11px] text-muted">
        Dra punktene på den stiplede kurven for ny bølge (settet bygges på nytt, låste plasser beholdes) · dra en låt sidelengs for å flytte den · linja under er BPM ({Math.round(bLo + 1)}–{Math.round(bHi - 1)}), tegnene er toneart.
      </p>
    </div>
  );
}
