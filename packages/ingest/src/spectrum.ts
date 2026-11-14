import { spawn } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_VERSION, type Analysis, type AssetManifest, type SourceFormat, type Spectrum48Info } from '@gv/shared';
import { FFMPEG, FFPROBE, run } from './ffmpeg';
import { findMaster } from './share';

/**
 * Del 14: spekteret til «Spektrum (Hz)»-panelet, uten Web Audio.
 * 48 logaritmiske bånd 20 Hz–20 kHz, 20 bilder/s, én byte per bånd (0–255).
 * Regnes fra masteren i 44,1 kHz (analysen ellers går i 22 kHz og når bare 11 kHz).
 * Lagres som rå Uint8 i `spectrum48.bin` ved siden av analysis.json (3 min ≈ 170 kB, 2 t-sett ≈ 7 MB),
 * så analysis.json holder seg liten og spekteret bare hentes når panelet vises.
 */
export const SPECTRUM48: Omit<Spectrum48Info, 'frames' | 'file'> = { bands: 48, fps: 20, minHz: 20, maxHz: 20000 };
export const SPECTRUM48_FILE = 'spectrum48.bin';
const SR = 44100;
const N = 4096;
const HOP = SR / SPECTRUM48.fps; // 2205 samples = 50 ms
/** Under dette (dB under toppen) er båndet tomt. */
const FLOOR_DB = 60;
/** Musikk faller ca. 3 dB per oktav; løft diskanten tilsvarende så spekteret ser «flatt» ut som i en analysator. */
const TILT_DB_PER_OCT = 3;

/** Båndkanter (Hz), 49 stykker. */
export function bandEdges(bands = SPECTRUM48.bands, lo = SPECTRUM48.minHz, hi = SPECTRUM48.maxHz): number[] {
  return Array.from({ length: bands + 1 }, (_, b) => lo * Math.pow(hi / lo, b / bands));
}
/** Midtfrekvens (geometrisk) per bånd – til aksen i UI-et og testene. */
export function bandCenters(bands = SPECTRUM48.bands): number[] {
  const e = bandEdges(bands);
  return Array.from({ length: bands }, (_, b) => Math.sqrt(e[b]! * e[b + 1]!));
}

// Forhåndsregnet vindu og twiddles for raskere FFT (sett på 2 timer = 144 000 rammer)
const hann = Float64Array.from({ length: N }, (_, k) => 0.5 * (1 - Math.cos((2 * Math.PI * k) / (N - 1))));
const cosT = Float64Array.from({ length: N / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / N));
const sinT = Float64Array.from({ length: N / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / N));
const rev = (() => {
  const r = new Uint32Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let x = i;
    let y = 0;
    for (let b = 0; b < bits; b++) {
      y = (y << 1) | (x & 1);
      x >>= 1;
    }
    r[i] = y;
  }
  return r;
})();

function fftMag(frame: Float64Array, out: Float64Array, re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < N; i++) {
    re[rev[i]!] = frame[i]! * hann[i]!;
    im[rev[i]!] = 0;
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const step = N / len;
    for (let a = 0; a < N; a += len) {
      for (let k = 0; k < half; k++) {
        const cr = cosT[k * step]!;
        const ci = sinT[k * step]!;
        const x = a + k;
        const y = x + half;
        const tr = re[y]! * cr - im[y]! * ci;
        const ti = re[y]! * ci + im[y]! * cr;
        re[y] = re[x]! - tr;
        im[y] = im[x]! - ti;
        re[x] = re[x]! + tr;
        im[x] = im[x]! + ti;
      }
    }
  }
  for (let k = 0; k < N / 2; k++) out[k] = re[k]! * re[k]! + im[k]! * im[k]!;
}

/** Effekt per bånd fra ett effektspekter. Smale bånd i bassen (smalere enn en FFT-bin) leser nærmeste bin. */
const binHz = SR / N;
const ranges = (() => {
  const e = bandEdges();
  return Array.from({ length: SPECTRUM48.bands }, (_, b) => {
    const lo = e[b]! / binHz;
    const hi = e[b + 1]! / binHz;
    const a = Math.max(1, Math.floor(lo));
    const z = Math.max(a + 1, Math.min(N / 2, Math.ceil(hi)));
    return [a, z] as const;
  });
})();
const tilt = bandCenters().map((f) => TILT_DB_PER_OCT * Math.log2(f / 1000));

/** dB per bånd (med tilt) for ett vindu. Eksportert for testene. */
export function bandDb(frame: Float64Array): Float64Array {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const pow = new Float64Array(N / 2);
  fftMag(frame, pow, re, im);
  return powToDb(pow);
}
function powToDb(pow: Float64Array, out = new Float64Array(SPECTRUM48.bands)): Float64Array {
  for (let b = 0; b < SPECTRUM48.bands; b++) {
    const [a, z] = ranges[b]!;
    let s = 0;
    for (let k = a; k < z; k++) s += pow[k]!;
    out[b] = 10 * Math.log10(s / (z - a) + 1e-20) + tilt[b]!;
  }
  return out;
}

/**
 * Strømmer masteren fra ffmpeg (mono, 44,1 kHz) og lager Uint8-rammene.
 * Normalisert mot 99,5-persentilen over hele låta, gulv 60 dB under.
 */
export function analyzeSpectrum48(file: string, durationMs: number): Promise<{ data: Buffer; info: Spectrum48Info }> {
  const total = Math.max(1, Math.round((durationMs / 1000) * SR));
  const nFrames = Math.max(1, Math.ceil(total / HOP));
  const db = new Float32Array(nFrames * SPECTRUM48.bands);
  const ring = new Float64Array(N); // de siste N samplene
  const frame = new Float64Array(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const pow = new Float64Array(N / 2);
  const bandsOut = new Float64Array(SPECTRUM48.bands);
  let w = 0; // skriveposisjon i ringen
  let i = 0; // samplenummer
  let f = 0; // rammenummer
  let carry: Buffer | null = null;

  const emit = () => {
    // Ramme f er sentrert på f·HOP: bruk de N siste samplene (vinduet ligger litt etter, < 50 ms)
    for (let k = 0; k < N; k++) frame[k] = ring[(w + k) % N]!;
    fftMag(frame, pow, re, im);
    powToDb(pow, bandsOut);
    db.set(bandsOut, f * SPECTRUM48.bands);
    f++;
  };

  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { windowsHide: true });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', (e) => reject(new Error(`Fant ikke ffmpeg: ${e.message}`)));
    p.stdout.on('data', (chunk: Buffer) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      carry = usable < buf.length ? buf.subarray(usable) : null;
      for (let o = 0; o < usable; o += 4) {
        ring[w] = buf.readFloatLE(o);
        w = (w + 1) % N;
        i++;
        if (i % HOP === 0 && f < nFrames) emit();
      }
    });
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg-spektrum feilet: ${stderr.slice(-800)}`));
      while (f < nFrames) emit(); // hale (stillhet fylles inn)
      // Normaliser: 99,5-persentil av de hørbare verdiene = 255, 60 dB under = 0
      const sample: number[] = [];
      const stride = Math.max(1, Math.floor(db.length / 200_000));
      for (let k = 0; k < db.length; k += stride) sample.push(db[k]!);
      sample.sort((a, b) => a - b);
      const top = sample[Math.floor(sample.length * 0.995)] ?? 0;
      const data = Buffer.alloc(db.length);
      for (let k = 0; k < db.length; k++) {
        const v = (db[k]! - (top - FLOOR_DB)) / FLOOR_DB;
        data[k] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      resolve({ data, info: { ...SPECTRUM48, frames: nFrames, file: SPECTRUM48_FILE } });
    });
  });
}

// ---------------------------------------------------------------- Kildeformat (del 14 pkt. 18)

const CONTAINERS: Record<string, string> = { '.wav': 'WAV', '.aif': 'AIFF', '.aiff': 'AIFF', '.flac': 'FLAC', '.mp3': 'MP3', '.m4a': 'AAC', '.ogg': 'OGG' };

/** «WAV 24-bit / 48 kHz», «WAV 32-bit float / 44,1 kHz». Desimalkomma (norsk). */
export function formatSourceLabel(f: Omit<SourceFormat, 'label'>): string {
  const khz = (f.sampleRate / 1000).toLocaleString('nb-NO', { maximumFractionDigits: 1 });
  const depth = f.bitDepth ? `${f.bitDepth}-bit${f.float ? ' float' : ''}` : null;
  return [f.container, [depth, `${khz} kHz`].filter(Boolean).join(' / ')].filter(Boolean).join(' ');
}

/** Leser formatet fra en lydfil. `nameForContainer` = opprinnelig filnavn (masteren i media er FLAC uansett kilde). */
export async function probeSourceFormat(file: string, nameForContainer: string | null = file): Promise<SourceFormat> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,sample_fmt,bits_per_raw_sample,bits_per_sample', '-of', 'json', file]);
  const s = (JSON.parse(stdout) as { streams?: Array<{ codec_name?: string; sample_rate?: string; sample_fmt?: string; bits_per_raw_sample?: string; bits_per_sample?: number }> }).streams?.[0] ?? {};
  const float = /^(flt|dbl)/.test(s.sample_fmt ?? '') || /^pcm_f/.test(s.codec_name ?? '');
  const lossy = /^(mp3|aac|vorbis|opus)/.test(s.codec_name ?? '');
  const bitDepth = lossy ? null : Number(s.bits_per_raw_sample) || Number(s.bits_per_sample) || (float ? 32 : /^s16/.test(s.sample_fmt ?? '') ? 16 : /^s32/.test(s.sample_fmt ?? '') ? 24 : null);
  const container = nameForContainer ? (CONTAINERS[path.extname(nameForContainer).toLowerCase()] ?? null) : null;
  const base = { container, bitDepth, float, sampleRate: Number(s.sample_rate) || 44100 };
  return { ...base, label: formatSourceLabel(base) };
}

// ---------------------------------------------------------------- Fyll inn for eldre versjoner

/**
 * Del 14: fyller inn spectrum48 og kildeformat for versjoner ingestet før analyseversjon 2.
 * Leser bare Vaults egen master (master.flac/.wav i media/), aldri eksportmappa. Ingen ny HLS-koding.
 * Skriver atomisk (tmp + rename), så en avbrutt kjøring ikke etterlater halve filer.
 */
export async function backfillAnalysis(o: {
  mediaDir: string;
  /** data/sources.json-oppføringer (for filtypen til kildefila). */
  sources: Record<string, { fileName?: string }>;
  force?: boolean;
  onItem?: (key: string, status: 'done' | 'current' | 'nomaster', detail?: string) => void;
}): Promise<{ done: number; current: number; missing: number }> {
  const idx = JSON.parse(await readFile(path.join(o.mediaDir, 'index.json'), 'utf8')) as { assets: Array<{ slug: string; variant: string | null; version: number; manifest: string }> };
  const r = { done: 0, current: 0, missing: 0 };
  const writeAtomic = async (file: string, data: string | Buffer) => {
    await writeFile(`${file}.tmp`, data);
    // Windows: fila kan være åpen et øyeblikk (serveren leser den, antivirus) → prøv igjen
    for (let n = 0; ; n++) {
      try {
        await rename(`${file}.tmp`, file);
        return;
      } catch (err) {
        if (!/EPERM|EBUSY|EACCES/.test(String((err as NodeJS.ErrnoException).code))) throw err;
        // Målfila kan ha en hardlenke et annet sted (f.eks. Google Drive sin opplastingsmappe) som holdes åpen.
        // Fjern bare oppføringen i media/ og legg den nye på plass; den andre lenken blir stående urørt.
        if (n === 3) await unlink(file).catch(() => {});
        if (n >= 20) throw err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  };
  for (const a of idx.assets) {
    const key = `${a.slug}::${a.variant ?? 'main'}::v${a.version}`;
    const vdir = path.join(o.mediaDir, path.dirname(a.manifest));
    const manifestFile = path.join(o.mediaDir, a.manifest);
    const m = JSON.parse(await readFile(manifestFile, 'utf8')) as AssetManifest;
    const analysisFile = path.join(vdir, m.files.analysis);
    const an = JSON.parse(await readFile(analysisFile, 'utf8')) as Analysis;
    if (!o.force && (an.version ?? 1) >= ANALYSIS_VERSION && an.spectrum48 && m.sourceFormat) {
      r.current++;
      o.onItem?.(key, 'current');
      continue;
    }
    const master = findMaster(vdir);
    if (!master) {
      r.missing++;
      o.onItem?.(key, 'nomaster');
      continue;
    }
    const spec = await analyzeSpectrum48(master, m.durationMs);
    // Masteren i media er FLAC (eller WAV ved flyttall); filtypen til kilden står i sources.json.
    const fmt = await probeSourceFormat(master, o.sources[key]?.fileName ?? (master.endsWith('.wav') ? master : null));
    await writeAtomic(path.join(vdir, SPECTRUM48_FILE), spec.data);
    await writeAtomic(analysisFile, JSON.stringify({ ...an, version: ANALYSIS_VERSION, spectrum48: spec.info }));
    await writeAtomic(manifestFile, JSON.stringify({ ...m, sourceFormat: fmt }, null, 2));
    r.done++;
    o.onItem?.(key, 'done', `${spec.info.frames} rammer · ${fmt.label}`);
  }
  return r;
}
