import { spawn } from 'node:child_process';
import { fft } from './analyze';
import { FFMPEG } from './ffmpeg';

/**
 * Lydlikhet for duplikatsjekken: kromagram over tid. Lyden dekodes mono 8 kHz, hver ramme (4096 prøver
 * ≈ 0,5 s) gir 12 tonehøydeklasser (110–2000 Hz), og rammene midles i vinduer på 4 s. To filer er samme
 * låt når varigheten er lik (±2 s) og kromagrammene korrelerer over terskelen. Uavhengig av filnavn,
 * mastering og nivå (hvert vindu normaliseres).
 */

const RATE = 8000;
const N = 4096;
const WINDOW_FRAMES = 8; // 8 × 0,512 s ≈ 4 s
const MAX_SECONDS = 600;

export interface Fingerprint {
  durationMs: number;
  /** Vinduer × 12, normalisert (L2) og kvantisert 0–255, base64. */
  chroma: string;
}

function chromaFrame(buf: Float32Array, re: Float64Array, im: Float64Array, out: Float64Array) {
  for (let k = 0; k < N; k++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (N - 1)));
    re[k] = buf[k]! * hann;
    im[k] = 0;
  }
  fft(re, im);
  const lo = Math.ceil((110 * N) / RATE);
  const hi = Math.floor((2000 * N) / RATE);
  for (let k = lo; k <= hi; k++) {
    const f = (k * RATE) / N;
    const pc = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
    out[pc] = out[pc]! + re[k]! * re[k]! + im[k]! * im[k]!;
  }
}

/** Fingeravtrykk for en lydfil (dekodes med ffmpeg, maks 10 min). */
export function fingerprintFile(file: string): Promise<Fingerprint> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-t', String(MAX_SECONDS), '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { windowsHide: true });
    const frame = new Float32Array(N);
    let fill = 0;
    let samples = 0;
    let rest: Buffer = Buffer.alloc(0);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let acc = new Float64Array(12);
    let inWindow = 0;
    const windows: number[][] = [];
    const flushWindow = () => {
      const norm = Math.sqrt(acc.reduce((a, v) => a + v * v, 0)) || 1;
      windows.push([...acc].map((v) => v / norm));
      acc = new Float64Array(12);
      inWindow = 0;
    };
    p.stdout.on('data', (chunk: Buffer) => {
      const data: Buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const n = Math.floor(data.length / 4);
      for (let i = 0; i < n; i++) {
        frame[fill++] = data.readFloatLE(i * 4);
        if (fill === N) {
          chromaFrame(frame, re, im, acc);
          fill = 0;
          if (++inWindow === WINDOW_FRAMES) flushWindow();
        }
      }
      samples += n;
      rest = data.subarray(n * 4);
    });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && !windows.length) return reject(new Error(err.trim() || `ffmpeg ${code}`));
      if (inWindow > 2) flushWindow();
      const bytes = Buffer.from(windows.flatMap((w) => w.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255))));
      resolve({ durationMs: Math.round((samples / RATE) * 1000), chroma: bytes.toString('base64') });
    });
  });
}

function decode(fp: Fingerprint): number[][] {
  const b = Buffer.from(fp.chroma, 'base64');
  const out: number[][] = [];
  for (let i = 0; i + 12 <= b.length; i += 12) out.push([...b.subarray(i, i + 12)].map((v) => v / 255));
  return out;
}

/** Varighet for duplikatsjekken: fingeravtrykket dekker maks 10 min, så lengre filer sammenlignes på metadata. */
export const SAME_DURATION_MS = 2000;
export const SIMILARITY_THRESHOLD = 0.93;

/**
 * Likhet 0–1: gjennomsnittlig cosinus mellom vinduene, beste forskyvning innenfor ±2 vinduer (≈ ±8 s),
 * så en litt annerledes start (stillhet, intro) ikke ødelegger. 0 hvis varigheten avviker mer enn ±2 s.
 */
export function similarity(a: Fingerprint, b: Fingerprint, durationA = a.durationMs, durationB = b.durationMs): number {
  if (Math.abs(durationA - durationB) > SAME_DURATION_MS) return 0;
  const A = decode(a);
  const B = decode(b);
  if (A.length < 4 || B.length < 4) return 0;
  let best = 0;
  for (let off = -2; off <= 2; off++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < A.length; i++) {
      const j = i + off;
      if (j < 0 || j >= B.length) continue;
      let dot = 0;
      for (let k = 0; k < 12; k++) dot += A[i]![k]! * B[j]![k]!;
      sum += dot;
      n++;
    }
    if (n >= Math.min(A.length, B.length) * 0.8) best = Math.max(best, sum / n);
  }
  return best;
}
