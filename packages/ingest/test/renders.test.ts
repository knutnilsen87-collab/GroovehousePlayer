import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type VaultConfig } from '../src/config';
import { FFMPEG, probe, run } from '../src/ffmpeg';
import { ingestRelease } from '../src/ingest';
import { measureQuality, recipeFor, renderTransition } from '../src/renders';
import { scanFlat } from '../src/sources';

/** Del 20 C: ferdigmikset overgang med kvalitetssjekk (krever ffmpeg). */
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = { ...DEFAULTS, defaults: { artist: 'Echo Groove', label: null, copyright: null } };

describe('kvalitetssjekken (ren)', () => {
  const RATE = 11025;
  const clicks = (bpm: number, seconds: number, shiftMs = 0) => {
    const x = new Int16Array(seconds * RATE);
    const p = (60 / bpm) * RATE;
    for (let k = 0; k * p < x.length; k++) {
      const s = Math.round(k * p + (shiftMs / 1000) * RATE);
      for (let j = 0; j < 200 && s + j < x.length; j++) if (s + j >= 0) x[s + j] = Math.round(20000 * Math.exp(-j / 40) * Math.sin(j / 3));
    }
    return x;
  };
  it('taktene treffer: avvik under 15 ms', () => {
    const q = measureQuality(clicks(124, 40), clicks(124, 40, 3), 10, 15, false, 'bass-swap');
    expect(q.offsetMs).not.toBeNull();
    expect(q.offsetMs!).toBeLessThan(15);
    expect(q.ok).toBe(true);
  });
  it('40 ms forskyvning stryker, og vokal oppå vokal stryker', () => {
    expect(measureQuality(clicks(124, 40), clicks(124, 40, 40), 10, 15, false, 'bass-swap').ok).toBe(false);
    expect(measureQuality(clicks(124, 40), clicks(124, 40), 10, 15, true, 'bass-swap').notes).toContain('Vokal oppå vokal');
  });
  it('oppskriften følger presetet, og korte overganger uten preset blir echo out', () => {
    expect(recipeFor('bass-swap-16', 'blend')).toBe('bass-swap');
    expect(recipeFor('cut-on-drop', 'short')).toBe('cut');
    expect(recipeFor('ukjent', 'short')).toBe('echo-out');
  });
});

describe.skipIf(!hasFfmpeg)('rendering (krever ffmpeg)', () => {
  let tmp = '';
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });
  it('lager forhåndsvisning med B tempojustert på taktene (< 15 ms) og kvalitetssjekk', { timeout: 180_000 }, async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-render-'));
    const src = path.join(tmp, 'src');
    const mediaDir = path.join(tmp, 'media');
    const dataDir = path.join(tmp, 'data');
    await mkdir(src, { recursive: true });
    const kick = (bpm: number) => `0.9*sin(2*PI*55*mod(t,60/${bpm}))*exp(-mod(t,60/${bpm})*28)+0.25*sin(2*PI*7000*mod(t,30/${bpm}))*exp(-mod(t,30/${bpm})*300)`;
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${kick(124)}':s=44100:d=150`, '-ac', '2', path.join(src, 'Track A.wav')]);
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${kick(126)}':s=44100:d=150`, '-ac', '2', path.join(src, 'Track B.wav')]);
    const scan = await scanFlat(src, cfg);
    for (const r of scan.releases) await ingestRelease(r, { mediaDir, config: cfg, status: 'release' });
    const t0 = Date.now();
    const r = await renderTransition({ mediaDir, dataDir, from: { slug: 'track-a', variant: null, version: 1 }, to: { slug: 'track-b', variant: null, version: 1 }, preset: 'bass-swap-16', noAlternative: true });
    const ms = Date.now() - t0;
    console.log(`overgang: ${(ms / 1000).toFixed(1)} s, takt-avvik ${r.quality.offsetMs} ms`);
    const file = path.join(dataDir, 'renders', r.file);
    expect(existsSync(file)).toBe(true);
    const info = await probe(file);
    expect(info.durationMs).toBeGreaterThan(20_000);
    expect(info.durationMs).toBeLessThan(70_000);
    expect(r.quality.offsetMs).not.toBeNull();
    expect(r.quality.offsetMs!).toBeLessThan(15);
    expect(ms).toBeLessThan(30_000);
    // Samme overgang igjen kommer fra cachen
    const again = await renderTransition({ mediaDir, dataDir, from: { slug: 'track-a', variant: null, version: 1 }, to: { slug: 'track-b', variant: null, version: 1 }, preset: 'bass-swap-16', noAlternative: true });
    expect(again.id).toBe(r.id);
  });
});
