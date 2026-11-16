import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { beatMs, formatTimeMs, sectionsOf, type Loop } from '@gv/shared/web';
import { downsample, useFullAsset, type LoadedAsset } from '../lib/catalog';
import { useSpectrum } from '../lib/library';
import { getPositionMs, usePlayer } from '../lib/player';

/**
 * Del 14: bølgeform, bølgeform-zoom og spektrum på canvas. Alt drives av forhåndsberegnet analyse
 * (ingen Web Audio), posisjonen leses fra motoren i hver frame, og tegningen pauses når panelet
 * ikke er synlig (skjult fane, rullet bort, annen fane i panelet).
 */

// ---------------------------------------------------------------- Felles

function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(200,208,220,${a})`;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Aksentfargene fra CSS-variablene (coveret). Leses på nytt når paletten byttes. */
function accentOf(el: Element) {
  const css = getComputedStyle(el);
  return { a: css.getPropertyValue('--accent').trim() || '#C8D0DC', b: css.getPropertyValue('--accent-2').trim() || '#5A6578' };
}

/** Lerret i riktig oppløsning (devicePixelRatio) som følger størrelsen på boksen. */
function useCanvasSize() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e!.contentRect.width), h: Math.floor(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}
function prep(c: HTMLCanvasElement, w: number, h: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * Kjører `draw` i hver frame mens lerretet er synlig og musikken spiller; ellers én gang ved endring.
 * Pauses når nettleserfanen er skjult eller lerretet er utenfor skjermen.
 */
function useFrames(ref: React.RefObject<HTMLCanvasElement>, draw: (now: number) => void, deps: unknown[]) {
  const playing = usePlayer((s) => s.playing);
  const positionMs = usePlayer((s) => s.positionMs);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting && document.visibilityState === 'visible'));
    io.observe(el);
    const onVis = () => setVisible(document.visibilityState === 'visible' && el.getClientRects().length > 0);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ref]);
  useEffect(() => {
    if (!visible) return;
    if (!playing) {
      drawRef.current(performance.now());
      return;
    }
    let raf = 0;
    const loop = (t: number) => {
      drawRef.current(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, playing, playing ? 0 : positionMs, ...deps]);
}

/**
 * Høyder med kontrast: ferdigmiksede låter har nesten konstante topper, så rå peaks blir en grå blokk.
 * Blander energi (RMS) og topper, normaliserer mot 5.–99,5. persentil og løfter forskjellene.
 */
function shaped(asset: LoadedAsset, n: number): number[] {
  const an = asset.analysis;
  if (!an) return new Array(n).fill(0.1);
  const peaks = downsample(an.peaks ?? [], n);
  const energy = an.energy?.length ? downsample(an.energy, n) : peaks;
  const norm = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const lo = s[Math.floor(s.length * 0.05)] ?? 0;
    const hi = s[Math.floor(s.length * 0.995)] ?? 1;
    return xs.map((x) => Math.min(1, Math.max(0, (x - lo) / Math.max(1e-6, hi - lo))));
  };
  const e = norm(energy);
  const p = norm(peaks);
  return e.map((v, i) => 0.06 + 0.94 * Math.pow(0.65 * v + 0.35 * p[i]!, 1.35));
}

/** Posisjonen i låta (samme låt som spilles, ellers 0). */
const posFor = (a: LoadedAsset) => {
  const s = usePlayer.getState();
  return s.queue[s.index]?.manifest.id === a.manifest.id ? getPositionMs() : 0;
};

// ---------------------------------------------------------------- Stor bølgeform

/** Del 22: stolpene i den store bølgeformen (fra Knuts utkast): 3 px bredde, 2 px mellomrom, 2 px avrunding. */
export const WAVE_BAR = 3;
export const WAVE_GAP = 2;
export const WAVE_RADIUS = 2;
/** Antall stolper som får plass i en bredde, kant til kant. */
export const waveBarCount = (w: number) => Math.max(16, Math.floor((w + WAVE_GAP) / (WAVE_BAR + WAVE_GAP)));

/** Stolpene som én sti (bygges når bredde/høyde/låt endres, ikke i hver frame). Vertikalt normalisert: høyeste stolpe fyller hele høyden. */
function barPath(bars: number[], height: number): Path2D {
  const p = new Path2D();
  const max = Math.max(1e-6, ...bars);
  const mid = height / 2;
  const round = typeof p.roundRect === 'function';
  bars.forEach((v, i) => {
    const h = Math.max(2, (v / max) * height);
    const x = i * (WAVE_BAR + WAVE_GAP);
    if (round) p.roundRect(x, mid - h / 2, WAVE_BAR, h, Math.min(WAVE_RADIUS, h / 2));
    else p.rect(x, mid - h / 2, WAVE_BAR, h);
  });
  return p;
}

/**
 * Del 22: stolpe-bølgeform fra analysis.json (ingen Web Audio), kant til kant. Uspilt del i aksent-2 på 30 %,
 * spilt del i aksent på 90 % (Echo Groove Nights: gradient), skarpt hvitt spillehode med svak glød og et
 * glød-lag bak som tennes når avspillingen går. `children` legges oppå (tidene i hjørnene).
 * Klikk = spol. Dra = sett A·B-løkke (festes til takter; hold Shift for å slå av).
 * Tastatur: ←/→ 5 s, Shift+←/→ 1 s.
 */
export function BigWaveform({ asset: assetIn, height = 120, loop, onSeek, onLoop, children }: { asset: LoadedAsset; height?: number; loop: Loop | null; onSeek: (ms: number) => void; onLoop: (a: number, b: number, snap: boolean) => void; children?: React.ReactNode }) {
  // Full analyse (analysis.json) hentes når låta vises; til da tegnes den lette fra katalogen
  const asset = useFullAsset(assetIn);
  const { ref, w } = useCanvasSize();
  const m = asset.manifest;
  const dur = m.durationMs;
  const bars = useMemo(() => shaped(asset, waveBarCount(w)), [asset, w]);
  const path = useMemo(() => barPath(bars, height), [bars, height]);
  const sections = useMemo(() => sectionsOf(m.markers), [m.markers]);
  const drag = useRef<{ x0: number; x: number; moved: boolean } | null>(null);
  const [, force] = useState(0);
  const colors = useRef<{ a: string; b: string } | null>(null);
  useEffect(() => {
    colors.current = null;
  }, [asset]);
  const isCur = usePlayer((s) => s.queue[s.index]?.manifest.id === m.id);
  const playing = usePlayer((s) => s.playing) && isCur;

  useFrames(
    ref,
    () => {
      const c = ref.current;
      if (!c || !w) return;
      const ctx = prep(c, w, height);
      const col = (colors.current ??= accentOf(c));
      const pos = posFor(asset);
      const px = Math.min(w, (pos / dur) * w);
      // A·B-løkke
      const l = drag.current?.moved ? { a: (Math.min(drag.current.x0, drag.current.x) / w) * dur, b: (Math.max(drag.current.x0, drag.current.x) / w) * dur } : loop;
      if (l) {
        const x0 = (l.a / dur) * w;
        const x1 = (l.b / dur) * w;
        ctx.fillStyle = rgba(col.a, 0.12);
        ctx.fillRect(x0, 0, x1 - x0, height);
        ctx.fillStyle = rgba(col.a, 0.8);
        ctx.fillRect(x0, 0, 1, height);
        ctx.fillRect(x1 - 1, 0, 1, height);
      }
      // Uspilt: aksent-2 på ca. 30 %
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, 0, w - px, height);
      ctx.clip();
      ctx.fillStyle = rgba(col.b, 0.3);
      ctx.fill(path);
      ctx.restore();
      // Spilt: aksent på ca. 90 % (gradient-skin: aksent → aksent-2 nedover)
      if (px > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, px, height);
        ctx.clip();
        if (document.documentElement.dataset.wave === 'gradient') {
          const g = ctx.createLinearGradient(0, 0, 0, height);
          g.addColorStop(0, rgba(col.a, 0.9));
          g.addColorStop(1, rgba(col.b, 0.9));
          ctx.fillStyle = g;
        } else ctx.fillStyle = rgba(col.a, 0.9);
        ctx.fill(path);
        ctx.restore();
      }
      // Seksjonsstreker
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      for (const s of sections) if (s.startMs > 0) ctx.fillRect(Math.round((s.startMs / dur) * w), 0, 1, 5);
      // Spillehode: 2 px hvitt med svak glød
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,0.7)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(Math.max(0, Math.min(w - 2, Math.round(px) - 1)), 0, 2, height);
      ctx.restore();
    },
    [w, height, path, loop, asset]
  );

  const ratioAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 1000 : 5000;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      onSeek(Math.min(dur, Math.max(0, posFor(asset) + (e.key === 'ArrowRight' ? step : -step))));
    }
  };
  const pos = usePlayer((s) => s.positionMs);
  return (
    <div className="relative" style={{ height }}>
    <span aria-hidden="true" className="gv-wave-glow" data-on={playing ? 'true' : 'false'} />
    <canvas
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={`Spol i ${m.title}. Dra for å sette A·B-løkke.`}
      aria-valuemin={0}
      aria-valuemax={Math.round(dur / 1000)}
      aria-valuenow={Math.round(pos / 1000)}
      aria-valuetext={formatTimeMs(pos)}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const x = ratioAt(e.clientX) * w;
        drag.current = { x0: x, x, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.x = ratioAt(e.clientX) * w;
        if (Math.abs(d.x - d.x0) > 6) d.moved = true;
        if (d.moved) force((n) => n + 1);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) onLoop((Math.min(d.x0, d.x) / w) * dur, (Math.max(d.x0, d.x) / w) * dur, !e.shiftKey);
        else onSeek(ratioAt(e.clientX) * dur);
        force((n) => n + 1);
      }}
      className="relative block w-full cursor-pointer touch-none"
      style={{ height }}
    />
    {children && <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 font-mono text-[13px] text-ink-strong [text-shadow:0_1px_6px_rgba(0,0,0,0.85)]">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Bølgeform-zoom

/**
 * Vindu rundt spillehodet (standard ±8 s, 2–30 s med hjul eller klyp). Dra for å spole.
 * Takt-rutenett ut fra BPM (tydeligere strek hver 4. slag) og seksjonsmarkørene.
 */
export function ZoomWaveform({ asset: assetIn, height = 96, onSeek }: { asset: LoadedAsset; height?: number; onSeek: (ms: number) => void }) {
  // Full analyse (analysis.json) hentes når låta vises; til da tegnes den lette fra katalogen
  const asset = useFullAsset(assetIn);
  const { ref, w } = useCanvasSize();
  const m = asset.manifest;
  const [half, setHalf] = useState(8000);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  const pinch = useRef<Map<number, number>>(new Map());
  const pinchStart = useRef<{ d: number; half: number } | null>(null);
  const [offset, setOffset] = useState(0);
  // Full oppløsning (2000 punkter) med samme kontrastkurve som den store bølgeformen
  const peaks = useMemo(() => shaped(asset, asset.analysis?.peaks?.length ?? 0), [asset]);
  const sections = useMemo(() => sectionsOf(m.markers), [m.markers]);
  const colors = useRef<{ a: string; b: string } | null>(null);
  useEffect(() => {
    colors.current = null;
  }, [asset]);

  useFrames(
    ref,
    () => {
      const c = ref.current;
      if (!c || !w || !peaks.length) return;
      const ctx = prep(c, w, height);
      const col = (colors.current ??= accentOf(c));
      const center = posFor(asset) + offset;
      const t0 = center - half;
      const msPerPx = (2 * half) / w;
      const binMs = m.durationMs / peaks.length;
      const mid = height / 2;
      // Takt-rutenett
      if (m.bpm) {
        const b = beatMs(m.bpm);
        const first = Math.ceil(t0 / b);
        for (let k = first; k * b <= t0 + 2 * half; k++) {
          const x = (k * b - t0) / msPerPx;
          ctx.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
          ctx.fillRect(Math.round(x), 0, 1, height);
        }
      }
      // Bølgeform: fortid i aksent, framtid dempet
      const step = 2;
      for (let x = 0; x < w; x += step) {
        const t = t0 + x * msPerPx;
        if (t < 0 || t > m.durationMs) continue;
        const i = t / binMs;
        const i0 = Math.floor(i);
        const v = (peaks[i0] ?? 0) * (1 - (i - i0)) + (peaks[i0 + 1] ?? 0) * (i - i0);
        const h = Math.max(1, v * (height - 8));
        ctx.fillStyle = x < w / 2 ? col.a : rgba(col.a, 0.42);
        ctx.fillRect(x, mid - h / 2, step - 0.5, h);
      }
      // Seksjoner
      ctx.font = '600 11px "Geist Mono", monospace';
      for (const s of sections) {
        const x = (s.startMs - t0) / msPerPx;
        if (x < -40 || x > w) continue;
        ctx.fillStyle = rgba(col.a, 0.9);
        ctx.fillRect(Math.round(x), 0, 1, height);
        ctx.fillStyle = '#E9ECF2';
        ctx.fillText((s.label ?? '').toUpperCase(), x + 3, 10);
      }
      // Spillehode
      ctx.fillStyle = '#F5F7FA';
      ctx.fillRect(Math.round(w / 2) - 1, 0, 2, height);
    },
    [w, height, half, offset, asset]
  );

  const clampHalf = (v: number) => Math.min(15_000, Math.max(1000, v));
  return (
    <div className="flex flex-col gap-1.5">
      <canvas
        ref={ref}
        aria-label={`Bølgeform-zoom, vindu ±${Math.round(half / 1000)} s. Dra for å spole, hjul for å zoome.`}
        onWheel={(e) => setHalf((h) => clampHalf(h * (e.deltaY > 0 ? 1.15 : 1 / 1.15)))}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pinch.current.set(e.pointerId, e.clientX);
          if (pinch.current.size === 2) {
            const [a, b] = [...pinch.current.values()] as [number, number];
            pinchStart.current = { d: Math.abs(a - b) || 1, half };
            drag.current = null;
          } else drag.current = { x: e.clientX, offset: 0 };
        }}
        onPointerMove={(e) => {
          if (pinch.current.has(e.pointerId)) pinch.current.set(e.pointerId, e.clientX);
          if (pinchStart.current && pinch.current.size === 2) {
            const [a, b] = [...pinch.current.values()] as [number, number];
            setHalf(clampHalf((pinchStart.current.half * pinchStart.current.d) / (Math.abs(a - b) || 1)));
            return;
          }
          const d = drag.current;
          if (!d || !w) return;
          setOffset(-((e.clientX - d.x) * (2 * half)) / w);
        }}
        onPointerUp={(e) => {
          pinch.current.delete(e.pointerId);
          if (pinch.current.size < 2) pinchStart.current = null;
          if (drag.current && offset) onSeek(Math.min(m.durationMs, Math.max(0, posFor(asset) + offset)));
          drag.current = null;
          setOffset(0);
        }}
        className="block w-full cursor-grab touch-none rounded-md active:cursor-grabbing"
        style={{ height }}
      />
      <div className="flex justify-between font-mono text-[11px] text-muted">
        <span>−{(half / 1000).toFixed(0)} s</span>
        <span>{m.bpm ? `${m.bpm} BPM · takt-rutenett` : 'uten BPM'}</span>
        <span>+{(half / 1000).toFixed(0)} s</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Spektrum

const AXIS = [20, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 20_000];
const axisLabel = (f: number) => (f >= 1000 ? `${f / 1000}K` : String(f));

/**
 * 48 bånd fra `spectrum48.bin`, valgt ut fra avspillingsposisjonen (ingen lydanalyse i nettleseren,
 * virker likt i Android-appen der lyden spilles native). Rask stigning, langsomt fall.
 */
export function SpectrumView({ asset: assetIn, height = 120 }: { asset: LoadedAsset; height?: number }) {
  // Full analyse (analysis.json) hentes når låta vises; til da tegnes den lette fra katalogen
  const asset = useFullAsset(assetIn);
  const { ref, w } = useCanvasSize();
  const spec = useSpectrum(asset);
  const shown = useRef<Float32Array>(new Float32Array(48));
  const last = useRef(0);
  const colors = useRef<{ a: string; b: string } | null>(null);
  useEffect(() => {
    colors.current = null;
  }, [asset]);

  useFrames(
    ref,
    (now) => {
      const c = ref.current;
      if (!c || !w || !spec) return;
      const ctx = prep(c, w, height);
      const col = (colors.current ??= accentOf(c));
      const n = spec.bands;
      if (shown.current.length !== n) shown.current = new Float32Array(n);
      const dt = Math.min(0.1, Math.max(0, (now - last.current) / 1000));
      last.current = now;
      const f = (posFor(asset) / 1000) * spec.fps;
      const i0 = Math.min(spec.frames - 1, Math.max(0, Math.floor(f)));
      const i1 = Math.min(spec.frames - 1, i0 + 1);
      const fr = Math.min(1, Math.max(0, f - i0));
      const playing = usePlayer.getState().playing;
      const gap = 2;
      const bw = (w - gap * (n - 1)) / n;
      const grad = ctx.createLinearGradient(0, height, 0, 0);
      grad.addColorStop(0, rgba(col.b, 0.85));
      grad.addColorStop(0.55, col.a);
      grad.addColorStop(1, rgba(col.a, 0.95));
      ctx.save();
      ctx.shadowColor = rgba(col.a, 0.6);
      ctx.shadowBlur = 8;
      ctx.fillStyle = grad;
      ctx.beginPath();
      for (let b = 0; b < n; b++) {
        const target = ((spec.data[i0 * n + b] ?? 0) * (1 - fr) + (spec.data[i1 * n + b] ?? 0) * fr) / 255;
        const cur = shown.current[b]!;
        // Rask stigning, langsomt fall (≈ 1,4 av full høyde per sekund). Pauset: vis rammen som den er.
        const v = !playing ? target : target > cur ? cur + (target - cur) * 0.65 : Math.max(target, cur - 1.4 * dt);
        shown.current[b] = v;
        const h = Math.max(1.5, v * (height - 2));
        ctx.rect(b * (bw + gap), height - h, bw, h);
      }
      ctx.fill();
      ctx.restore();
    },
    [w, height, spec, asset]
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative" style={{ height }}>
        <canvas ref={ref} aria-label="Spektrum (Hz) for låta som spilles" className="block h-full w-full" />
        {spec === undefined || spec === null ? (
          <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] text-muted">{spec === null ? 'Analyserer…' : 'Laster spektrum…'}</span>
        ) : null}
      </div>
      <div className="relative h-3 font-mono text-[11px] text-muted" aria-hidden="true">
        {AXIS.map((f, i) => (
          <span key={f} className={`absolute ${i === 0 ? '' : i === AXIS.length - 1 ? '-translate-x-full' : '-translate-x-1/2'}`} style={{ left: `${(Math.log(f / 20) / Math.log(1000)) * 100}%` }}>
            {axisLabel(f)}
          </span>
        ))}
      </div>
    </div>
  );
}
