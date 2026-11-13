import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { VaultConfig } from '../src/config';
import { FFMPEG, run } from '../src/ffmpeg';
import type { IngestResult } from '../src/ingest';
import { startWatcher } from '../src/watcher';

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = {
  ports: { server: 41733, dev: 41734 },
  lan: { enabled: false, rememberDays: 30 },
  defaults: { artist: 'Echo Groove', label: 'Groovehouse Records', copyright: '℗ {year} Groovehouse Records' },
  titleCleanup: { remove: ['suno ai', 'suno', 'final', 'stems'] }
};

describe.skipIf(!hasFfmpeg)('watcher (krever ffmpeg)', () => {
  let tmp = '';
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('ingester en ny bounce rett i eksportmappa, men ikke filer som lå der fra før', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-watch-'));
    const exportDir = path.join(tmp, 'REASONDONE');
    const mediaDir = path.join(tmp, 'media');
    await mkdir(exportDir, { recursive: true });
    const tone = (file: string) => run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=110:d=6', '-ac', '2', path.join(exportDir, file)]);
    await tone('Gammel Låt.wav');

    const got: IngestResult[] = [];
    const lines: string[] = [];
    const w = startWatcher({ exportDir, mediaDir, config: cfg, log: (l) => lines.push(l), onIngested: (r) => got.push(r) });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // la chokidar bli klar
      await tone('Would You Run__extended_v2.wav');
      const deadline = Date.now() + 40_000;
      while (got.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
      await w.idle();
    } finally {
      await w.close();
    }
    expect(got.map((g) => `${g.manifest.slug}/${g.manifest.variant}/v${g.manifest.version}`)).toEqual(['would-you-run/extended/v2']);
    expect(got[0]!.manifest.title).toBe('Would You Run');
    const idx = JSON.parse(await readFile(path.join(mediaDir, 'index.json'), 'utf8')) as { assets: Array<{ slug: string }> };
    expect(idx.assets.map((a) => a.slug)).toEqual(['would-you-run']);
  }, 60_000);
});
