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

// ------------------------------------------------------------------ Del 3: EDMA, tuning og house-tempo

/**
 * Faraldo et al. (2016), «Key Estimation in Electronic Dance Music» – EDMA-profilene, slik de brukes som
 * profil «edma» i Essentia (bare tallene; ingen Essentia-kode er tatt inn).
 */
const EDMA_MAJOR = [1.0, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39];
const EDMA_MINOR = [1.0, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32];

/**
 * Tuning før kromagrammet: finn forskyvningen (i steg på 100/«bøtter per halvtone» cent, ±50) der energien samler seg
 * om halvtonene, og fold 120 bøtter til 12 tonehøydeklasser rundt den.
 */
export function foldHpcp(hpcp: number[]): { chroma: number[]; tuningCents: number } {
  const B = hpcp.length;
  const per = B / 12;
  const at = (i: number) => hpcp[((i % B) + B) % B] ?? 0;
  let bestT = 0;
  let best = -Infinity;
  for (let t = -Math.floor(per / 2); t < Math.ceil(per / 2); t++) {
    let sc = 0;
    for (let s = 0; s < 12; s++) sc += at(s * per + t) + 0.5 * (at(s * per + t - 1) + at(s * per + t + 1));
    // Ved (nesten) likt: minst mulig tuning
    if (sc > best * (1 + 1e-9) || (Math.abs(sc - best) <= best * 1e-9 && Math.abs(t) < Math.abs(bestT))) {
      best = sc;
      bestT = t;
    }
  }
  const chroma = Array.from({ length: 12 }, (_, s) => {
    let sum = 0;
    for (let d = -Math.floor(per / 2); d < Math.ceil(per / 2); d++) sum += at(s * per + bestT + d);
    return sum;
  });
  return { chroma, tuningCents: Math.round((bestT * 100) / per) };
}

/** Del 3: toneart fra HPCP med tuning og EDMA-profiler (i stedet for Krumhansl). */
export function estimateKeyEdma(hpcp: number[]): (MusicalKey & { tuningCents: number }) | null {
  const { chroma, tuningCents } = foldHpcp(hpcp);
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const c = chroma.map((v) => v / total);
  const results: Array<{ pc: number; minor: boolean; r: number }> = [];
  for (let pc = 0; pc < 12; pc++) {
    for (const minor of [false, true]) {
      const prof = minor ? EDMA_MINOR : EDMA_MAJOR;
      results.push({ pc, minor, r: pearson(c, c.map((_, k) => prof[(k - pc + 12) % 12]!)) });
    }
  }
  results.sort((a, b) => b.r - a.r);
  const best = results[0]!;
  const second = results[1]!;
  return {
    name: `${NAMES[best.pc]} ${best.minor ? 'minor' : 'major'}`,
    camelot: camelotOf(best.pc, best.minor),
    confidence: round3(Math.max(0, Math.min(1, (best.r - second.r) * 5 + Math.max(0, best.r) * 0.5))),
    tuningCents
  };
}

/** House-området: ved tydelig puls foretrekkes en oktav-variant her (118–132 BPM). */
export const HOUSE_MIN = 118;
export const HOUSE_MAX = 132;

/**
 * Del 3: tempo med kam over flere slag og house-regel.
 *  - Autokorrelasjonen leses ved 1, 2, 4 og 8 slag (med interpolasjon), så tempoet bestemmes av lange
 *    perioder (presisjon ~1/8 hopp) i stedet for ett enkelt slag.
 *  - BPM søkes 90–150 i steg på 0,05; 118–132 (house) får et lite fortrinn.
 *  - Halv/dobbel tempo som havner i 118–132 velges når pulsen er tydelig og den er nesten like sterk.
 */
export function estimateTempoHouse(onset: Float32Array, hopRate: number): { bpm: number; confidence: number; house: boolean } | null {
  const n = onset.length;
  if (n < hopRate * 8) return null;
  let mean = 0;
  for (const v of onset) mean += v;
  mean /= n;
  const x = Float64Array.from(onset, (v) => v - mean);
  const maxLag = Math.min(n - 1, Math.ceil(((hopRate * 60) / 90) * 8) + 2);
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let k = 0; k + lag < n; k++) sum += x[k]! * x[k + lag]!;
    acf[lag] = sum / (n - lag);
  }
  if (!(acf[0]! > 0)) return null;
  const at = (lag: number) => {
    if (lag >= maxLag) return 0;
    const i = Math.floor(lag);
    const f = lag - i;
    return acf[i]! * (1 - f) + acf[i + 1]! * f;
  };
  const score = (bpm: number) => {
    const beat = (hopRate * 60) / bpm;
    return at(beat) + 0.8 * at(2 * beat) + 0.6 * at(4 * beat) + 0.4 * at(8 * beat);
  };
  let best = -Infinity;
  let bestBpm = 0;
  for (let b = 90; b <= 150; b += 0.05) {
    const sc = score(b) * (b >= HOUSE_MIN && b <= HOUSE_MAX ? 1.1 : 1);
    if (sc > best) {
      best = sc;
      bestBpm = b;
    }
  }
  const confidence = round3(Math.max(0, Math.min(1, at((hopRate * 60) / bestBpm) / acf[0]!)));
  let bpm = bestBpm;
  let house = bpm >= HOUSE_MIN && bpm <= HOUSE_MAX;
  if (!house && confidence >= 0.15) {
    for (const f of [2, 0.5]) {
      const alt = bestBpm * f;
      if (alt >= HOUSE_MIN && alt <= HOUSE_MAX && score(alt) >= 0.7 * score(bestBpm)) {
        bpm = alt;
        house = true;
        break;
      }
    }
  }
  return { bpm: Math.round(bpm * 10) / 10, confidence, house };
}

/**
 * Del 3: tempo per kapittel i et sett (minst 16 s per kapittel). Brukes til å rapportere tempoendringer.
 * `onset` dekker hele settet med `hopRate` verdier per sekund.
 */
export function tempoPerChapter(onset: Float32Array, hopRate: number, chapters: Array<{ startMs: number; endMs?: number | null }>, durationMs: number): Array<number | null> {
  return chapters.map((c) => {
    const a = Math.floor((c.startMs / 1000) * hopRate);
    const b = Math.min(onset.length, Math.floor(((c.endMs ?? durationMs) / 1000) * hopRate));
    if (b - a < hopRate * 16) return null;
    return estimateTempoHouse(onset.subarray(a, b), hopRate)?.bpm ?? null;
  });
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
