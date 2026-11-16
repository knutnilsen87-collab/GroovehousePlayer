import { spawn } from 'node:child_process';
import type { Analysis } from '@gv/shared';
import { FFMPEG } from './ffmpeg';

export const RATE = 22050;
const FFT_SIZE = 4096;
const BANDS = 8;
/** Hopp for onset-konvolutten (tempo): 128 samples ≈ 5,8 ms */
export const ONSET_HOP = 128;
/** Låter: tempo fra de første 6 minuttene. Sett: hele lengden (del 3: tempo per kapittel). */
export const ONSET_TRACK_SAMPLES = 6 * 60 * RATE;
/** Del 3: HPCP med 240 bøtter per oktav (5 cent), for tuning-estimat før folding til 12 tonehøyder. */
export const HPCP_BINS = 240;
/** Rammer med høyere spektral flathet (trommer, støy) tas ikke med i tonearts-analysen. */
const FLATNESS_MAX = 0.35;
const SUB_FRAME_MS = 50;

export interface AnalysisResult {
  analysis: Analysis;
  /** Første tydelige transient i de første 20 s (ms), brukt som sync-anker for live-logger. */
  firstTransientMs: number | null;
  /** Positiv fluks i bass-konvolutten, ett tall per ONSET_HOP. Til tempoestimat. */
  onset: Float32Array;
  /** Akkumulert kromagram (12 tonehøydeklasser, C = 0) – den opprinnelige metoden (alle bins, alle rammer). */
  chroma: number[];
  /** Del 3: HPCP (240 per oktav, C = 0): bare harmoniske rammer, spektraltopper med harmonisk vekting. */
  hpcp: number[];
  /** Andel rammer som var harmoniske nok til å telle i HPCP. */
  harmonicShare: number;
}

/** Enkel ett-pols lavpass. Kaskadér for brattere filter. */
function lpCoef(fc: number): number {
  return Math.exp((-2 * Math.PI * fc) / RATE);
}

/**
 * Strømmer mono PCM fra ffmpeg og bygger alt visualiseringen og musikkanalysen trenger
 * i ett pass, uten å holde fila i minnet (viktig for 2-timers sett):
 * bølgeform, 3-bånds bølgeform, energikurve, spektrum, sub-bass-konvolutt, onset og kroma.
 */
export function analyze(file: string, durationMs: number, opts: { peaks?: number; energy?: number; onProgress?: (fraction: number) => void } = {}): Promise<AnalysisResult> {
  const nPeaks = opts.peaks ?? 2000;
  const nEnergy = opts.energy ?? 1000;
  const totalSamples = Math.max(1, Math.round((durationMs / 1000) * RATE));
  const frameMs = Math.max(250, Math.round(durationMs / 1500));
  const frameStride = Math.round((frameMs / 1000) * RATE);
  const subFrame = (SUB_FRAME_MS / 1000) * RATE;
  const nSub = Math.ceil(totalSamples / subFrame) + 1;

  const peaks = new Float32Array(nPeaks);
  const pLow = new Float32Array(nPeaks);
  const pMid = new Float32Array(nPeaks);
  const pHigh = new Float32Array(nPeaks);
  const sumSq = new Float64Array(nEnergy);
  const count = new Uint32Array(nEnergy);
  const subSq = new Float64Array(nSub);
  const subN = new Uint32Array(nSub);
  const onsetEnv = new Float32Array(Math.ceil(totalSamples / ONSET_HOP) + 2);
  const chroma = new Array<number>(12).fill(0);
  const hpcp = new Array<number>(HPCP_BINS).fill(0);
  const hpcpAll = new Array<number>(HPCP_BINS).fill(0);
  const tally = { harmonic: 0, total: 0 };
  const frames: number[][] = [];
  const fftBuf = new Float32Array(FFT_SIZE);

  // Filtertilstand
  const aLow = lpCoef(150);
  const aHigh = lpCoef(2500);
  const aSub = lpCoef(80);
  const aEnv = lpCoef(20);
  let low1 = 0, low2 = 0, hiLp = 0, sub1 = 0, sub2 = 0, env = 0;
  let hopAcc = 0, hopN = 0, hopIdx = 0;

  let fftFill = 0;
  let collecting = false;
  let nextFrameAt = 0;
  let firstTransient: number | null = null;
  const transientLimit = 20 * RATE;
  let i = 0;
  let carry: Buffer | null = null;

  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', (e) => reject(new Error(`Fant ikke ffmpeg: ${e.message}`)));

    p.stdout.on('data', (chunk: Buffer) => {
      opts.onProgress?.(Math.min(1, i / totalSamples));
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      carry = usable < buf.length ? buf.subarray(usable) : null;
      for (let o = 0; o < usable; o += 4, i++) {
        const x = buf.readFloatLE(o);
        const ax = Math.abs(x);

        // Filtre: lav (< 150 Hz, 2. orden), høy (> 2,5 kHz), sub (< 80 Hz, 2. orden)
        low1 = (1 - aLow) * x + aLow * low1;
        low2 = (1 - aLow) * low1 + aLow * low2;
        hiLp = (1 - aHigh) * x + aHigh * hiLp;
        const high = x - hiLp;
        const mid = x - low2 - high;
        sub1 = (1 - aSub) * x + aSub * sub1;
        sub2 = (1 - aSub) * sub1 + aSub * sub2;

        const pb = Math.min(nPeaks - 1, Math.floor((i * nPeaks) / totalSamples));
        if (ax > peaks[pb]!) peaks[pb] = ax;
        const al = Math.abs(low2), am = Math.abs(mid), ah = Math.abs(high);
        if (al > pLow[pb]!) pLow[pb] = al;
        if (am > pMid[pb]!) pMid[pb] = am;
        if (ah > pHigh[pb]!) pHigh[pb] = ah;

        const eb = Math.min(nEnergy - 1, Math.floor((i * nEnergy) / totalSamples));
        sumSq[eb] = sumSq[eb]! + x * x;
        count[eb] = count[eb]! + 1;

        const sb = Math.floor(i / subFrame);
        if (sb < nSub) {
          subSq[sb] = subSq[sb]! + sub2 * sub2;
          subN[sb] = subN[sb]! + 1;
        }

        // Onset-konvolutt: glattet |bass| per hopp
        {
          env = (1 - aEnv) * Math.abs(low2) + aEnv * env;
          hopAcc += env;
          if (++hopN === ONSET_HOP) {
            onsetEnv[hopIdx++] = hopAcc / ONSET_HOP;
            hopAcc = 0;
            hopN = 0;
          }
        }

        if (firstTransient === null && i < transientLimit && ax > 0.5) firstTransient = Math.round((i / RATE) * 1000);

        if (!collecting && i >= nextFrameAt) {
          collecting = true;
          fftFill = 0;
        }
        if (collecting) {
          fftBuf[fftFill++] = x;
          if (fftFill === FFT_SIZE) {
            frames.push(analyseFrame(fftBuf, chroma, hpcp, hpcpAll, tally));
            collecting = false;
            nextFrameAt += frameStride;
          }
        }
      }
    });

    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg-analyse feilet: ${stderr.slice(-800)}`));
      const peakMax = maxOf(peaks);
      const rms = Array.from(sumSq, (s, k) => (count[k]! > 0 ? Math.sqrt(s / count[k]!) : 0));
      const rmsMax = Math.max(1e-6, ...rms);
      const bandMax = new Array(BANDS).fill(1e-9) as number[];
      for (const f of frames) f.forEach((v, b) => (bandMax[b] = Math.max(bandMax[b]!, v)));

      // Sub-bass: RMS per 50 ms, normalisert mot 99-persentilen (så et enkelt klikk ikke flater ut alt)
      const subRms = Array.from(subSq, (s, k) => (subN[k]! > 0 ? Math.sqrt(s / subN[k]!) : 0));
      const subRef = percentile(subRms, 0.99) || 1e-6;
      const subBytes = Buffer.from(subRms.map((v) => Math.min(255, Math.round((v / subRef) * 255))));

      // Positiv fluks av onset-konvolutten
      const used = onsetEnv.subarray(0, hopIdx);
      const onset = new Float32Array(used.length);
      for (let k = 1; k < used.length; k++) onset[k] = Math.max(0, used[k]! - used[k - 1]!);

      resolve({
        firstTransientMs: firstTransient,
        onset,
        chroma,
        // For få harmoniske rammer (f.eks. bare trommer): bruk alle, heller enn ingenting
        hpcp: tally.harmonic >= Math.max(8, tally.total * 0.1) ? hpcp : hpcpAll,
        harmonicShare: tally.total ? round3(tally.harmonic / tally.total) : 0,
        analysis: {
          schema: 1,
          durationMs,
          peaks: Array.from(peaks, (v) => round3(v / peakMax)),
          energy: rms.map((v) => round3(v / rmsMax)),
          spectrum: { bands: BANDS, frameMs, frames: frames.map((f) => f.map((v, b) => round3(v / bandMax[b]!))) },
          bands3: {
            low: normalize(pLow),
            mid: normalize(pMid),
            high: normalize(pHigh)
          },
          sub: { frameMs: SUB_FRAME_MS, b64: subBytes.toString('base64') }
        }
      });
    });
  });
}

/** Bånd-energier for spektrumvisning + akkumulering av kroma (150 Hz – 5 kHz) for toneart. */
function analyseFrame(frame: Float32Array, chroma: number[], hpcp: number[], hpcpAll: number[], tally: { harmonic: number; total: number }): number[] {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let k = 0; k < FFT_SIZE; k++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (FFT_SIZE - 1)));
    re[k] = frame[k]! * hann;
  }
  fft(re, im);
  const half = FFT_SIZE / 2;
  const mag = new Float64Array(half);
  for (let k = 1; k < half; k++) mag[k] = Math.hypot(re[k]!, im[k]!);

  const binHz = RATE / FFT_SIZE;
  for (let k = Math.ceil(150 / binHz); k < Math.min(half, Math.floor(5000 / binHz)); k++) {
    const f = k * binHz;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pc] = chroma[pc]! + mag[k]! * mag[k]!;
  }
  accumulateHpcp(mag, binHz, hpcp, hpcpAll, tally);

  const nyq = RATE / 2;
  const edges = Array.from({ length: BANDS + 1 }, (_, b) => 40 * Math.pow(nyq / 40, b / BANDS));
  const out: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const lo = Math.max(1, Math.floor((edges[b]! / nyq) * half));
    const hi = Math.max(lo + 1, Math.floor((edges[b + 1]! / nyq) * half));
    let s = 0;
    for (let k = lo; k < hi; k++) s += mag[k] ?? 0;
    out.push(s / (hi - lo));
  }
  return out;
}

/**
 * Del 3: HPCP-bidrag fra én ramme. Bare rammer som er harmoniske nok (lav spektral flathet, altså ikke
 * trommer/støy), bare spektraltopper (−40 dB under rammens sterkeste), frekvens finjustert med
 * parabelinterpolasjon, og hver topp gir bidrag til mulige grunntoner f/h (h = 1–4) med fallende vekt.
 */
function accumulateHpcp(mag: Float64Array, binHz: number, hpcp: number[], hpcpAll: number[], tally: { harmonic: number; total: number }) {
  const lo = Math.ceil(100 / binHz);
  const hi = Math.min(mag.length - 2, Math.floor(5000 / binHz));
  let logSum = 0;
  let sum = 0;
  let max = 0;
  for (let k = lo; k <= hi; k++) {
    const p = mag[k]! * mag[k]! + 1e-12;
    logSum += Math.log(p);
    sum += p;
    if (mag[k]! > max) max = mag[k]!;
  }
  const n = hi - lo + 1;
  if (!(max > 0) || n <= 0) return;
  const flatness = Math.exp(logSum / n) / (sum / n);
  tally.total++;
  const harmonic = flatness <= FLATNESS_MAX;
  if (harmonic) tally.harmonic++;
  const thr = max * 0.01;
  for (let k = lo + 1; k < hi; k++) {
    const b = mag[k]!;
    if (b < thr || b <= mag[k - 1]! || b < mag[k + 1]!) continue;
    const a = mag[k - 1]!;
    const c = mag[k + 1]!;
    const d = a - 2 * b + c;
    const off = d !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
    const f = (k + off) * binHz;
    const amp = b - 0.25 * (a - c) * off;
    for (let h = 1; h <= 4; h++) {
      const f0 = f / h;
      if (f0 < 55) break;
      const midi = 69 + 12 * Math.log2(f0 / 440);
      const idx = ((Math.round(midi * (HPCP_BINS / 12)) % HPCP_BINS) + HPCP_BINS) % HPCP_BINS;
      const w = amp * Math.pow(0.6, h - 1);
      hpcpAll[idx] = hpcpAll[idx]! + w;
      if (harmonic) hpcp[idx] = hpcp[idx]! + w;
    }
  }
}

/** In-place radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let a = 1, j = 0; a < n; a++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (a < j) {
      [re[a], re[j]] = [re[j]!, re[a]!];
      [im[a], im[j]] = [im[j]!, im[a]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let a = 0; a < n; a += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const x = a + k;
        const y = x + len / 2;
        const tr = re[y]! * cr - im[y]! * ci;
        const ti = re[y]! * ci + im[y]! * cr;
        re[y] = re[x]! - tr;
        im[y] = im[x]! - ti;
        re[x] = re[x]! + tr;
        im[x] = im[x]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function maxOf(a: Float32Array): number {
  let m = 1e-6;
  for (const v of a) if (v > m) m = v;
  return m;
}

function normalize(a: Float32Array): number[] {
  const ref = percentile(Array.from(a), 0.995) || 1e-6;
  return Array.from(a, (v) => round3(Math.min(1, v / ref)));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
