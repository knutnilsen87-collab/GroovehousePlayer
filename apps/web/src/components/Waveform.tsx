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
  const playedColor = active ? 'var(--accent)' : '#F0C030';

  return (
    <div className="relative flex items-center gap-[2px]" style={{ height }}>
      {heights.map((h, i) => {
        const played = (i + 0.5) / bars <= progress;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="flex-1 rounded-[2px] transition-colors duration-300"
            style={{ height: Math.round(h * height), backgroundColor: played ? playedColor : 'rgba(255,255,255,0.14)' }}
          />
        );
      })}
      {markers.map((m) => (
        <span
          key={`${m.label}-${m.pct}`}
          aria-hidden="true"
          className="absolute -top-3 -translate-x-1/2 text-[8px] font-semibold tracking-[1.5px]"
          style={{ left: `${m.pct * 100}%`, color: active ? 'var(--accent)' : '#F0C030' }}
        >
          {m.label}
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
