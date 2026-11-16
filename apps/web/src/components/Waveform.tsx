import { useMemo } from 'react';
import { downsample } from '../lib/catalog';

interface Props {
  peaks: number[];
  bars?: number;
  height?: number;
  /** 0..1 */
  progress: number;
  /** false = gull (før avspilling), true = coverfarge via --accent */
  active: boolean;
  markers?: Array<{ pct: number; label: string }>;
  onSeek?: (ratio: number) => void;
  label?: string;
}

/**
 * Bølgeform fra forhåndsberegnede peaks (analysis.json). Ingen lydanalyse i nettleseren.
 * Spoling via en usynlig <input type="range"> over søylene, så den er tilgjengelig med tastatur.
 */
export function Waveform({ peaks, bars = 64, height = 56, progress, active, markers = [], onSeek, label = 'Seek' }: Props) {
  const heights = useMemo(() => downsample(peaks, bars).map((v) => Math.max(0.1, Math.pow(v, 0.8))), [peaks, bars]);

  return (
    <div className="relative flex items-center gap-[2px]" style={{ height }}>
      {heights.map((h, i) => {
        const played = (i + 0.5) / bars <= progress;
        return (
          <span
            key={i}
            aria-hidden="true"
            className={`flex-1 rounded-[2px] transition-colors duration-300 ${played ? 'gv-wave-played' : ''}`}
            style={{ height: Math.round(h * height), ...(played ? {} : { backgroundColor: 'rgba(255,255,255,0.14)' }) }}
          />
        );
      })}
      {markers.map((m) => (
        <span
          key={`${m.label}-${m.pct}`}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-10"
          style={{ left: `${m.pct * 100}%` }}
        >
          <span className="absolute inset-y-0 -left-px w-[1.5px] rounded-full" style={{ background: 'color-mix(in srgb, var(--accent) 65%, transparent)' }} />
          <span
            className="absolute -top-3.5 -translate-x-1/2 whitespace-nowrap rounded bg-sunken/95 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.2px] text-ink-strong shadow-sm"
            style={{ border: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)', color: 'var(--accent)' }}
          >
            {m.label}
          </span>
        </span>
      ))}
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
            onChange={(e) => onSeek(Number(e.target.value) / 1000)}
          />
          <span className="seek-focus pointer-events-none absolute inset-0 rounded" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
