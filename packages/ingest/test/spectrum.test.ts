import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANALYSIS_VERSION } from '@gv/shared';
import { FFMPEG, run } from '../src/ffmpeg';
import { analyzeSpectrum48, backfillAnalysis, bandCenters, bandEdges, formatSourceLabel, probeSourceFormat, SPECTRUM48 } from '../src/spectrum';
import { makeMasterCopy } from '../src/share';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gv-spec-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tone = async (name: string, args: string[]) => {
  const f = path.join(dir, name);
  await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', ...args, f]);
  return f;
};
const peakBand = (data: Buffer, frame: number) => {
  const row = data.subarray(frame * 48, frame * 48 + 48);
  return row.indexOf(Math.max(...row));
};

describe('spectrum48 (del 14)', () => {
  it('har 48 logaritmiske bånd fra 20 Hz til 20 kHz', () => {
    const e = bandEdges();
    expect(e).toHaveLength(49);
    expect(e[0]).toBeCloseTo(20, 6);
    expect(e[48]).toBeCloseTo(20000, 6);
    // Like forhold mellom alle kanter (logaritmisk)
    const ratio = e[1]! / e[0]!;
    for (let b = 1; b < 48; b++) expect(e[b + 1]! / e[b]!).toBeCloseTo(ratio, 9);
    expect(bandCenters()).toHaveLength(48);
  });

  it('20 bilder/s, én byte per bånd, og en ren tone havner i riktig bånd', async () => {
    const f = await tone('sine1k.wav', ['-i', 'sine=frequency=1000:duration=3:sample_rate=44100', '-c:a', 'pcm_s16le']);
    const { data, info } = await analyzeSpectrum48(f, 3000);
    expect(info).toMatchObject({ ...SPECTRUM48, frames: 60, file: 'spectrum48.bin' });
    expect(data.length).toBe(60 * 48);
    const centers = bandCenters();
    const b = peakBand(data, 30);
    // 1 kHz ligger i båndet med midtfrekvens nærmest 1 kHz (± ett bånd pga. vinduslekkasje)
    const want = centers.reduce((best, c, i) => (Math.abs(Math.log(c / 1000)) < Math.abs(Math.log(centers[best]! / 1000)) ? i : best), 0);
    expect(Math.abs(b - want)).toBeLessThanOrEqual(1);
    expect(data[30 * 48 + b]).toBeGreaterThan(200);
  });

  it('høye frekvenser over 11 kHz kommer med (analysen går i 44,1 kHz)', async () => {
    const f = await tone('sine15k.wav', ['-i', 'sine=frequency=15000:duration=2:sample_rate=44100', '-c:a', 'pcm_s16le']);
    const { data } = await analyzeSpectrum48(f, 2000);
    expect(bandCenters()[peakBand(data, 20)]!).toBeGreaterThan(12000);
  });

  it('kildeformat: «WAV 24-bit / 48 kHz», flyttall og desimalkomma', async () => {
    const f = await tone('fmt.wav', ['-i', 'sine=frequency=440:duration=1:sample_rate=48000', '-c:a', 'pcm_s24le']);
    expect((await probeSourceFormat(f)).label).toBe('WAV 24-bit / 48 kHz');
    const g = await tone('fmt-f.wav', ['-i', 'sine=frequency=440:duration=1:sample_rate=44100', '-c:a', 'pcm_f32le']);
    expect((await probeSourceFormat(g)).label).toBe('WAV 32-bit float / 44,1 kHz');
    expect(formatSourceLabel({ container: null, bitDepth: 16, float: false, sampleRate: 44100 })).toBe('16-bit / 44,1 kHz');
  });

  it('backfill: fyller inn fra master.flac, beholder kildens filtype og hopper over oppdaterte', async () => {
    const media = path.join(dir, 'media');
    const vdir = path.join(media, 'blue-fire', 'main', 'v1');
    await mkdir(vdir, { recursive: true });
    const src = await tone('Blue Fire.wav', ['-i', 'sine=frequency=440:duration=2:sample_rate=48000', '-c:a', 'pcm_s24le']);
    await makeMasterCopy(src, vdir);
    await writeFile(path.join(vdir, 'manifest.json'), JSON.stringify({ slug: 'blue-fire', variant: null, version: 1, durationMs: 2000, files: { analysis: 'analysis.json' } }));
    await writeFile(path.join(vdir, 'analysis.json'), JSON.stringify({ schema: 1, durationMs: 2000, peaks: [1] }));
    await writeFile(path.join(media, 'index.json'), JSON.stringify({ assets: [{ slug: 'blue-fire', variant: null, version: 1, manifest: 'blue-fire/main/v1/manifest.json' }] }));
    const sources = { 'blue-fire::main::v1': { fileName: 'Blue Fire.wav' } };

    const r1 = await backfillAnalysis({ mediaDir: media, sources });
    expect(r1).toEqual({ done: 1, current: 0, missing: 0 });
    const an = JSON.parse(await readFile(path.join(vdir, 'analysis.json'), 'utf8'));
    expect(an.version).toBe(ANALYSIS_VERSION);
    expect(an.peaks).toEqual([1]); // resten av analysen er urørt
    expect(an.spectrum48.frames).toBe(40);
    expect((await readFile(path.join(vdir, 'spectrum48.bin'))).length).toBe(40 * 48);
    const m = JSON.parse(await readFile(path.join(vdir, 'manifest.json'), 'utf8'));
    expect(m.sourceFormat.label).toBe('WAV 24-bit / 48 kHz');

    const r2 = await backfillAnalysis({ mediaDir: media, sources });
    expect(r2).toEqual({ done: 0, current: 1, missing: 0 });
  });
});
