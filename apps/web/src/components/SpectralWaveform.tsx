import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime, sectionsOf, type Analysis, type AssetMarker } from '@gv/shared/web';
import { downsample } from '../lib/catalog';

interface Props {
  analysis: Analysis | null;
  durationMs: number;
  /** 0..1 */
  progress: number;
  /** false = gull (ingenting spilles ennå), true = coverets farger via CSS-variablene */
  active: boolean;
  height: number;
  markers?: AssetMarker[];
  /** Vis etiketter (Intro, Drop 1 …) over bølgeformen */
  showLabels?: boolean;
  onSeek?: (ratio: number) => void;
  label?: string;
  /** Søylebredde + mellomrom i px */
  barPx?: number;
  /** Opasitet på delen som ikke er spilt ennå (lavere = mer kontrast mot spilt del) */
  unplayedAlpha?: number;
}

/** Bare før CSS-variablene finnes (første frame). Ellers styrer coveret fargene (del 14). */
const NEUTRAL = { low: '#5A6578', mid: '#C8D0DC', high: '#EEF1F5' };

/** Lysere variant av en hex-farge (til diskant-laget), så bølgeformen holder seg i coverets kulør. */
function mixWhite(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#F4F1EA';
  const n = parseInt(m[1]!, 16);
  const ch = (v: number) => Math.round(v + (255 - v) * t);
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

/**
 * Bølgeform i tre frekvensbånd, à la Rekordbox: bass (accent-2), mellomtone (accent), diskant (lys).
 * Alt kommer fra analysis.json – ingen lydanalyse i nettleseren. Tegnes på canvas for ytelse.
 * Spoling via en usynlig <input type="range"> over, så den er tilgjengelig med tastatur og skjermleser.
 */
export function SpectralWaveform({ analysis, durationMs, progress, active, height, markers = [], showLabels = false, onSeek, label = 'Spol', barPx = 3, unplayedAlpha = 0.3 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bars = Math.max(16, Math.floor(width / barPx));
  const data = useMemo(() => {
    const b3 = analysis?.bands3;
    const peaks = analysis?.peaks ?? [];
    return {
      peak: downsample(peaks, bars),
      low: b3 ? downsample(b3.low, bars) : null,
      mid: b3 ? downsample(b3.mid, bars) : null,
      high: b3 ? downsample(b3.high, bars) : null
    };
  }, [analysis, bars]);

  const sections = useMemo(() => sectionsOf(markers), [markers]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const css = getComputedStyle(c);
    const accent = css.getPropertyValue('--accent').trim() || NEUTRAL.mid;
    const col = { low: css.getPropertyValue('--accent-2').trim() || NEUTRAL.low, mid: accent, high: mixWhite(accent, 0.55) };
    const mid = height / 2;
    const bw = Math.max(1, barPx - 1);
    const playedX = progress * width;

    for (let i = 0; i < bars; i++) {
      const x = i * barPx;
      const played = x + bw / 2 <= playedX;
      ctx.globalAlpha = played ? 1 : unplayedAlpha;
      const draw = (v: number, scale: number, color: string) => {
        const h = Math.max(1, v * scale * (height - 2));
        ctx.fillStyle = color;
        ctx.fillRect(x, mid - h / 2, bw, h);
      };
      if (data.low && data.mid && data.high) {
        // Lagvis, største først: bass bakerst, diskant fremst
        draw(Math.pow(data.low[i]!, 0.9), 1, col.low);
        draw(Math.pow(data.mid[i]!, 0.9), 0.78, col.mid);
        draw(Math.pow(data.high[i]!, 1.2), 0.42, col.high);
      } else {
        draw(data.peak[i]!, 1, col.mid);
      }
    }
    ctx.globalAlpha = 1;

    // Seksjonsgrenser
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (const s of sections) {
      if (s.startMs <= 0) continue;
      ctx.fillRect(Math.round((s.startMs / durationMs) * width), 0, 1, height);
    }
    // Spillehode
    if (progress > 0 && progress < 1) {
      ctx.fillStyle = '#F4F1EA';
      ctx.fillRect(Math.round(playedX), 0, 1, height);
    }
  }, [data, width, height, progress, active, sections, durationMs, barPx, bars, unplayedAlpha]);

  const current = sections.filter((s) => s.startMs <= progress * durationMs + 1).pop();

  return (
    <div className="relative w-full" style={{ paddingTop: showLabels && sections.length ? 18 : 0 }}>
      {showLabels && sections.length > 0 && (
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-4">
          {sections.map((s) => (
            <span
              key={`${s.label}-${s.startMs}`}
              className="absolute top-0 truncate whitespace-nowrap pl-1 text-[9px] font-semibold uppercase tracking-[1.2px]"
              style={{
                left: `${(s.startMs / durationMs) * 100}%`,
                maxWidth: `${(((s.endMs ?? durationMs) - s.startMs) / durationMs) * 100}%`,
                color: s === current ? 'var(--accent)' : '#8B93A1'
              }}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div ref={wrap} className="relative w-full" style={{ height }}>
        <canvas ref={canvas} aria-hidden="true" style={{ width: '100%', height }} />
        {onSeek && (
          <>
            <input
              className="seek-overlay"
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(progress * 1000)}
              aria-label={label}
              aria-valuetext={formatTime(progress * durationMs)}
              onChange={(e) => onSeek(Number(e.target.value) / 1000)}
            />
            <span className="seek-focus pointer-events-none absolute inset-0 rounded" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}
