import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULTS, type VaultConfig } from '../src/config';
import { FFMPEG, run } from '../src/ffmpeg';
import { ingestRelease, PROGRESS_FILE, progressPercent } from '../src/ingest';
import { scanFlat } from '../src/sources';

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = { ...DEFAULTS, exportDir: null };

describe('fremdrift for lange sett (del 4)', () => {
  it('vektet prosent, aldri 100 før alt er ferdig', () => {
    expect(progressPercent({ analyse: 0, spektrum: 0, hls: 0, lufs: 0, master: 0 })).toBe(0);
    expect(progressPercent({ analyse: 1, spektrum: 1, hls: 0.5, lufs: 1, master: 1 })).toBe(80);
    expect(progressPercent({ analyse: 1, spektrum: 1, hls: 1, lufs: 1, master: 1 })).toBe(99);
  });

  let tmp = '';
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it.skipIf(!hasFfmpeg)('sett over 20 min: stigende prosent i rapporten og i media/ingest-progress.json, som fjernes etterpå', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gv-progress-'));
    const exportDir = path.join(tmp, 'export');
    const mediaDir = path.join(tmp, 'media');
    await mkdir(exportDir, { recursive: true });
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=110:d=1260:sample_rate=22050', '-ac', '1', path.join(exportDir, 'Long Set.wav')]);
    const release = (await scanFlat(exportDir, cfg)).releases[0]!;
    const seen: number[] = [];
    let fileSeen = false;
    const [res] = await ingestRelease(release, {
      mediaDir,
      config: cfg,
      report: (step, status, detail) => {
        if (status !== 'progress') return;
        seen.push(parseInt(detail ?? '', 10));
        if (existsSync(path.join(mediaDir, PROGRESS_FILE))) fileSeen = true;
      }
    });
    expect(res!.manifest.kind).toBe('set');
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
    expect(seen[seen.length - 1]).toBe(100);
    expect(fileSeen).toBe(true);
    expect(existsSync(path.join(mediaDir, PROGRESS_FILE))).toBe(false);
  }, 240_000);

  it.skipIf(!hasFfmpeg)('korte låter: ingen fremdrift', async () => {
    const exportDir = path.join(tmp, 'export2');
    await mkdir(exportDir, { recursive: true });
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=5', '-ac', '2', path.join(exportDir, 'Short.wav')]);
    const release = (await scanFlat(exportDir, cfg)).releases[0]!;
    let progress = 0;
    await ingestRelease(release, { mediaDir: path.join(tmp, 'media2'), config: cfg, report: (_s, status) => void (status === 'progress' && progress++) });
    expect(progress).toBe(0);
  }, 120_000);
});
