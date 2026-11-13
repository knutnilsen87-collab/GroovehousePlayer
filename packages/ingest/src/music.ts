import type { AssetMarker, MusicalKey } from '@gv/shared';
import { percentile, round3 } from './analyze';

// ------------------------------------------------------------------ Tempo

/**
 * Tempo fra onset-fluksen med autokorrelasjon (90–150 BPM).
 * Hver kandidat forsterkes av dobbel periode (kam), og ved oktavtvil foretrekkes
 * 115–135 BPM, der house og tech house ligger.
 */
export function estimateTempo(onset: Float32Array, hopRate: number): { bpm: number; confidence: number } | null {
  const n = onset.length;
  if (n < hopRate * 8) return null; // under 8 s er for lite
  let mean = 0;
  for (const v of onset) mean += v;
  mean /= n;
  const x = Float64Array.from(onset, (v) => v - mean);

  const acf = (lag: number) => {
    let s = 0;
    for (let k = 0; k + lag < n; k++) s += x[k]! * x[k + lag]!;
    return s / (n - lag);
  };
  const zero = acf(0);
  if (zero <= 0) return null;

  const minLag = Math.floor((hopRate * 60) / 150);
  const maxLag = Math.ceil((hopRate * 60) / 90);
  const cache = new Map<number, number>();
  const A = (lag: number) => {
    if (!cache.has(lag)) cache.set(lag, acf(lag));
    return cache.get(lag)!;
  };

  let best = -Infinity;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (hopRate * 60) / lag;
    const prior = bpm >= 115 && bpm <= 135 ? 1.15 : 1;
    const score = (A(lag) + 0.5 * A(lag * 2)) * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;

  // Parabolsk interpolasjon rundt toppen for presisjon under én hopp-lengde
  const y0 = A(bestLag - 1), y1 = A(bestLag), y2 = A(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const lag = bestLag + offset;
  const bpm = Math.round(((hopRate * 60) / lag) * 10) / 10;
  return { bpm, confidence: round3(Math.max(0, Math.min(1, y1 / zero))) };
}

// ------------------------------------------------------------------ Toneart

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export function camelotOf(pc: number, minor: boolean): string {
  return `${(minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[pc]}${minor ? 'A' : 'B'}`;
}

/** Krumhansl–Schmuckler: korrelerer kromagrammet mot dur/moll-profiler i alle 12 tonearter. */
export function estimateKey(chroma: number[]): MusicalKey | null {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const c = chroma.map((v) => v / total);
  const results: Array<{ pc: number; minor: boolean; r: number }> = [];
  for (let pc = 0; pc < 12; pc++) {
    for (const minor of [false, true]) {
      const prof = minor ? MINOR : MAJOR;
      const rotated = c.map((_, k) => prof[(k - pc + 12) % 12]!);
      results.push({ pc, minor, r: pearson(c, rotated) });
    }
  }
  results.sort((a, b) => b.r - a.r);
  const best = results[0]!;
  const second = results[1]!;
  return {
    name: `${NAMES[best.pc]} ${best.minor ? 'minor' : 'major'}`,
    camelot: camelotOf(best.pc, best.minor),
    confidence: round3(Math.max(0, Math.min(1, (best.r - second.r) * 5 + Math.max(0, best.r) * 0.5)))
  };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < n; k++) {
    num += (a[k]! - ma) * (b[k]! - mb);
    da += (a[k]! - ma) ** 2;
    db += (b[k]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// ------------------------------------------------------------------ Struktur

interface Segment {
  start: number; // ms
  end: number;
  high: boolean;
}

/**
 * Deler en låt i Intro / Build / Drop N / Break / Outro ut fra energikurven.
 * Grenser snappes til takt når BPM er kjent. Alt merkes source "analysis", confirmed false –
 * dette er forslag du godkjenner eller flytter i Command Center.
 */
export function segmentStructure(energy: number[], durationMs: number, bpm: number | null): AssetMarker[] {
  const n = energy.length;
  if (n < 20 || durationMs < 45_000) return [];
  const per = durationMs / n;

  // Glatt ~4 s
  const w = Math.max(1, Math.round(4000 / per / 2));
  const smooth = energy.map((_, k) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, k - w); j <= Math.min(n - 1, k + w); j++) {
      s += energy[j]!;
      c++;
    }
    return s / c;
  });

  const p25 = percentile(smooth, 0.25);
  const p90 = percentile(smooth, 0.9);
  if (p90 - p25 < 0.12) return []; // flat låt: ingen tydelig struktur
  const hiT = p25 + 0.6 * (p90 - p25);
  const loT = p25 + 0.4 * (p90 - p25);

  // Hysterese
  const states: boolean[] = [];
  let high = smooth[0]! > hiT;
  for (const v of smooth) {
    if (!high && v > hiT) high = true;
    else if (high && v < loT) high = false;
    states.push(high);
  }

  let segs: Segment[] = [];
  let startIdx = 0;
  for (let k = 1; k <= n; k++) {
    if (k === n || states[k] !== states[startIdx]) {
      segs.push({ start: startIdx * per, end: k * per, high: states[startIdx]! });
      startIdx = k;
    }
  }

  // Snapp til takt og slå sammen korte deler (< 8 takter eller 12 s)
  const bar = bpm ? (4 * 60_000) / bpm : null;
  const snap = (ms: number) => (bar ? Math.round(ms / bar) * bar : ms);
  const minLen = bar ? Math.max(12_000, 8 * bar) : 12_000;
  segs = segs.map((s, k) => ({ ...s, start: k === 0 ? 0 : snap(s.start), end: k === segs.length - 1 ? durationMs : snap(s.end) }));
  let merged = true;
  while (merged && segs.length > 1) {
    merged = false;
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]!;
      if (s.end - s.start < minLen) {
        const into = k > 0 ? k - 1 : k + 1;
        const t = segs[into]!;
        t.start = Math.min(t.start, s.start);
        t.end = Math.max(t.end, s.end);
        segs.splice(k, 1);
        merged = true;
        break;
      }
    }
    // Slå sammen naboer med samme tilstand
    for (let k = segs.length - 1; k > 0; k--) {
      if (segs[k]!.high === segs[k - 1]!.high) {
        segs[k - 1]!.end = segs[k]!.end;
        segs.splice(k, 1);
      }
    }
  }

  // Etiketter. En lang lav del rett før en drop får sine siste 8 takter som «Build».
  const buildLen = bar ? 8 * bar : 15_000;
  const out: Array<{ start: number; end: number; label: string; drop: boolean }> = [];
  let drops = 0;
  const lastHighIdx = segs.map((s) => s.high).lastIndexOf(true);
  segs.forEach((s, k) => {
    if (s.high) {
      drops++;
      out.push({ start: s.start, end: s.end, label: `Drop ${drops}`, drop: true });
      return;
    }
    const base = k === 0 ? 'Intro' : k > lastHighIdx ? 'Outro' : 'Break';
    const beforeDrop = segs[k + 1]?.high === true;
    if (beforeDrop && s.end - s.start >= buildLen * 3) {
      out.push({ start: s.start, end: s.end - buildLen, label: base, drop: false });
      out.push({ start: s.end - buildLen, end: s.end, label: 'Build', drop: false });
    } else {
      out.push({ start: s.start, end: s.end, label: beforeDrop && base === 'Break' ? 'Break' : base, drop: false });
    }
  });
  if (drops === 0) return [];

  const markers: AssetMarker[] = out.map((o) => ({
    kind: 'chapter',
    source: 'analysis',
    startMs: Math.round(o.start),
    endMs: Math.round(o.end),
    label: o.label,
    confirmed: false
  }));
  for (const o of out.filter((x) => x.drop)) {
    markers.push({ kind: 'drop', source: 'analysis', startMs: Math.round(o.start), label: o.label.toUpperCase(), confirmed: false });
  }
  return markers;
}
