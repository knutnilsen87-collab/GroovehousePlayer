/**
 * Del 3: treffrate for BPM og toneart.
 *
 *   pnpm eval:analysis <mappe> [--truth fixtures/truth.json]   ekte låter mot fasit (mappa leses bare)
 *   pnpm eval:analysis --synthetic                            syntetisk testsamling med kjent fasit
 *
 * Hver fil dekodes én gang, og den gamle metoden (Krumhansl på hele kromagrammet, tempo 90–150) og den nye
 * (HPCP med tuning, bare harmoniske rammer, EDMA-profiler; house-regel 118–132) vurderes på samme data.
 * BPM teller som riktig innenfor ±0,5. Toneart teller som riktig bare ved eksakt Camelot.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { camelotNeighbors, parseFlatName } from '@gv/shared';
import { analyze, ONSET_HOP, ONSET_TRACK_SAMPLES, RATE } from './analyze';
import { findRoot, loadConfig } from './config';
import { FFMPEG, probe, run } from './ffmpeg';
import { camelotOf, estimateKey, estimateKeyEdma, estimateTempo, estimateTempoHouse } from './music';

export interface Truth {
  bpm: number | null;
  camelot: string | null;
}
export interface Prediction {
  bpm: number | null;
  camelot: string | null;
}
export interface Row {
  slug: string;
  truth: Truth;
  old: Prediction;
  next: Prediction;
  harmonicShare: number;
  tuningCents: number;
}

const AUDIO = /\.(wav|aif|aiff|flac|mp3|m4a)$/i;
const hop = RATE / ONSET_HOP;

export const bpmOk = (p: number | null, t: number | null) => p != null && t != null && Math.abs(p - t) <= 0.5;
export const keyOk = (p: string | null, t: string | null) => !!p && !!t && p.toUpperCase() === t.toUpperCase();
/** «Nær»: relativ dur/moll eller kvint (±1 på hjulet) – vanlige, harmløse feil i DJ-sammenheng. */
export const keyNear = (p: string | null, t: string | null) => !!p && !!t && !keyOk(p, t) && camelotNeighbors(t).includes(p.toUpperCase());

export function summarize(rows: Row[]) {
  const withBpm = rows.filter((r) => r.truth.bpm != null);
  const withKey = rows.filter((r) => r.truth.camelot);
  const count = (fn: (r: Row) => boolean, xs: Row[]) => xs.filter(fn).length;
  const side = (which: 'old' | 'next') => ({
    bpm: count((r) => bpmOk(r[which].bpm, r.truth.bpm), withBpm),
    key: count((r) => keyOk(r[which].camelot, r.truth.camelot), withKey),
    near: count((r) => keyNear(r[which].camelot, r.truth.camelot), withKey)
  });
  return { nBpm: withBpm.length, nKey: withKey.length, old: side('old'), next: side('next') };
}
export const line = (s: ReturnType<typeof summarize>, which: 'old' | 'next') =>
  `${s[which].key}/${s.nKey} toneart (${s[which].near} nær), ${s[which].bpm}/${s.nBpm} BPM ±0,5`;

export async function evaluateFile(file: string, truth: Truth, slug: string): Promise<Row> {
  const info = await probe(file);
  const a = await analyze(file, info.durationMs);
  const trackOnset = a.onset.subarray(0, Math.ceil(ONSET_TRACK_SAMPLES / ONSET_HOP));
  const oldTempo = estimateTempo(trackOnset, hop);
  const newTempo = estimateTempoHouse(trackOnset, hop);
  const oldKey = estimateKey(a.chroma);
  const newKey = estimateKeyEdma(a.hpcp);
  return {
    slug,
    truth,
    old: { bpm: oldTempo?.bpm ?? null, camelot: oldKey?.camelot ?? null },
    next: { bpm: newTempo?.bpm ?? null, camelot: newKey?.camelot ?? null },
    harmonicShare: a.harmonicShare,
    tuningCents: newKey?.tuningCents ?? 0
  };
}

// ---------------------------------------------------------------- Syntetisk testsamling

export interface SynthCase {
  name: string;
  pc: number;
  minor: boolean;
  bpm: number;
  detuneCents: number;
  /** Kick på annethvert slag (halvtempo-følelse): naiv analyse gir halv BPM. */
  halfTimeKick: boolean;
  hats: number;
}

export const SYNTH_CASES: SynthCase[] = [
  { name: 'a-moll-124', pc: 9, minor: true, bpm: 124, detuneCents: 0, halfTimeKick: false, hats: 0.12 },
  { name: 'c-moll-126', pc: 0, minor: true, bpm: 126, detuneCents: 0, halfTimeKick: false, hats: 0.12 },
  { name: 'f-moll-122', pc: 5, minor: true, bpm: 122, detuneCents: 0, halfTimeKick: false, hats: 0.25 },
  { name: 'g-moll-128', pc: 7, minor: true, bpm: 128, detuneCents: 30, halfTimeKick: false, hats: 0.12 },
  { name: 'd-moll-125', pc: 2, minor: true, bpm: 125, detuneCents: -35, halfTimeKick: false, hats: 0.12 },
  { name: 'eb-moll-130', pc: 3, minor: true, bpm: 130, detuneCents: 0, halfTimeKick: true, hats: 0 },
  { name: 'bb-moll-123', pc: 10, minor: true, bpm: 123, detuneCents: 0, halfTimeKick: false, hats: 0.35 },
  { name: 'e-moll-127', pc: 4, minor: true, bpm: 127, detuneCents: 25, halfTimeKick: true, hats: 0.2 },
  { name: 'c-dur-124', pc: 0, minor: false, bpm: 124, detuneCents: 0, halfTimeKick: false, hats: 0.12 },
  { name: 'g-dur-126', pc: 7, minor: false, bpm: 126, detuneCents: 0, halfTimeKick: true, hats: 0 },
  { name: 'eb-dur-121', pc: 3, minor: false, bpm: 121, detuneCents: -30, halfTimeKick: false, hats: 0.25 },
  { name: 'a-dur-129', pc: 9, minor: false, bpm: 129, detuneCents: 0, halfTimeKick: false, hats: 0.3 },
  // Vanskelige: mye støy (hihat) og feilstemming nær en halv halvtone
  { name: 'fiss-moll-124-stoy', pc: 6, minor: true, bpm: 124, detuneCents: 0, halfTimeKick: false, hats: 0.8 },
  { name: 'h-moll-126-pluss45', pc: 11, minor: true, bpm: 126, detuneCents: 45, halfTimeKick: false, hats: 0.12 },
  { name: 'd-dur-125-minus45', pc: 2, minor: false, bpm: 125, detuneCents: -45, halfTimeKick: false, hats: 0.12 },
  { name: 'giss-moll-128-stoy', pc: 8, minor: true, bpm: 128, detuneCents: 40, halfTimeKick: true, hats: 0.7 }
];

const freq = (midi: number, cents: number) => 440 * Math.pow(2, (midi - 69 + cents / 100) / 12);

/**
 * ffmpeg-uttrykk som ligner house: i–i–VI–VII (moll) eller I–I–IV–V (dur) over en bass-pedal på
 * grunntonen, kick på hvert slag (eller annethvert ved halvtempo) og offbeat-hihat.
 */
export function synthExpr(c: SynthCase): string {
  const r = c.pc;
  const prog = c.minor
    ? [[0, 3, 7], [0, 3, 7], [8, 12, 15], [10, 14, 17]]
    : [[0, 4, 7], [0, 4, 7], [5, 9, 12], [7, 11, 14]];
  const chord = (iv: number[]) =>
    [...iv.map((x) => 60 + r + x), 36 + r + iv[0]!]
      .map((m) => {
        const f = freq(m, c.detuneCents).toFixed(3);
        return `0.06*(sin(2*PI*${f}*t)+0.5*sin(4*PI*${f}*t)+0.25*sin(6*PI*${f}*t))`;
      })
      .join('+');
  const beat = 60 / c.bpm;
  const P = 8 * beat;
  const m = `mod(t,${(4 * P).toFixed(5)})`;
  const harm = `if(lt(${m},${P.toFixed(5)}),${chord(prog[0]!)},if(lt(${m},${(2 * P).toFixed(5)}),${chord(prog[1]!)},if(lt(${m},${(3 * P).toFixed(5)}),${chord(prog[2]!)},${chord(prog[3]!)})))`;
  const kp = (c.halfTimeKick ? 2 : 1) * beat;
  const km = `mod(t,${kp.toFixed(5)})`;
  const kick = `0.8*sin(2*PI*(45+90*exp(-35*${km}))*${km})*exp(-9*${km})`;
  const hat = `${c.hats}*(random(0)*2-1)*exp(-70*mod(t+${(beat / 2).toFixed(5)},${beat.toFixed(5)}))`;
  const pedal = freq(36 + r, c.detuneCents).toFixed(3);
  const bass = `0.12*(sin(2*PI*${pedal}*t)+0.3*sin(4*PI*${pedal}*t))`;
  return `${harm}+${bass}+${kick}+${hat}`;
}

export async function makeSynth(dir: string, c: SynthCase, seconds = 40): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${c.name}.wav`);
  if (!existsSync(file)) await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=exprs='${synthExpr(c)}':s=22050:d=${seconds}`, '-ac', '2', '-c:a', 'pcm_s16le', file]);
  return file;
}

// ---------------------------------------------------------------- CLI

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : AUDIO.test(f) ? [p] : [];
  });
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const show = (p: Prediction, t: Truth) =>
  `${p.bpm ?? '–'}${t.bpm != null ? (bpmOk(p.bpm, t.bpm) ? '✓' : '✗') : ''} ${p.camelot ?? '–'}${t.camelot ? (keyOk(p.camelot, t.camelot) ? '✓' : keyNear(p.camelot, t.camelot) ? '≈' : '✗') : ''}`;

export function report(rows: Row[], title: string) {
  console.log(`\n${title}\n`);
  console.log(`${pad('låt', 30)} ${pad('fasit', 12)} ${pad('gammel', 16)} ${pad('ny', 16)} harmonisk  tuning`);
  for (const r of rows) {
    console.log(`${pad(r.slug, 30)} ${pad(`${r.truth.bpm ?? '?'} ${r.truth.camelot ?? '?'}`, 12)} ${pad(show(r.old, r.truth), 16)} ${pad(show(r.next, r.truth), 16)} ${String(Math.round(r.harmonicShare * 100)).padStart(5)} %  ${r.tuningCents > 0 ? '+' : ''}${r.tuningCents} c`);
  }
  const s = summarize(rows);
  console.log(`\nFør (Krumhansl, tempo 90–150): ${line(s, 'old')}`);
  console.log(`Nå  (HPCP + tuning + EDMA, house 118–132): ${line(s, 'next')}`);
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--synthetic')) {
    const dir = path.join(os.tmpdir(), 'gv-eval-synth-v2');
    const rows: Row[] = [];
    for (const c of SYNTH_CASES) {
      const file = await makeSynth(dir, c);
      rows.push(await evaluateFile(file, { bpm: c.bpm, camelot: camelotOf(c.pc, c.minor) }, c.name));
    }
    report(rows, `Syntetisk testsamling (${rows.length} filer, ${dir})`);
    return;
  }
  const folder = args.find((a) => !a.startsWith('--'));
  const root = findRoot(process.cwd());
  const ti = args.indexOf('--truth');
  const truthFile = path.resolve(root, ti >= 0 ? args[ti + 1]! : 'fixtures/truth.json');
  if (!folder) {
    console.log('Bruk: pnpm eval:analysis <mappe> [--truth fixtures/truth.json]  eller  pnpm eval:analysis --synthetic');
    process.exitCode = 1;
    return;
  }
  const truth = existsSync(truthFile) ? ((JSON.parse(readFileSync(truthFile, 'utf8')) as { tracks?: Record<string, Truth> }).tracks ?? {}) : {};
  const cfg = loadConfig(root);
  const files = walk(path.resolve(folder));
  const rows: Row[] = [];
  for (const f of files) {
    const slug = parseFlatName(path.basename(f), cfg.titleCleanup).slug;
    const t = truth[slug] ?? { bpm: null, camelot: null };
    process.stdout.write(`  · ${path.basename(f)}\n`);
    rows.push(await evaluateFile(f, t, slug));
  }
  const filled = Object.values(truth).filter((t) => t.bpm != null || t.camelot).length;
  report(rows, `${files.length} filer i ${folder} · fasit for ${filled} låter (${path.relative(root, truthFile)})`);
  if (!filled) console.log('\nIngen fasit fylt inn ennå: åpne fixtures/truth.json og skriv BPM og Camelot for 5–10 låter du kjenner.');
}

if (process.argv[1] && /eval\.ts$/.test(process.argv[1])) void main();
