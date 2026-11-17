import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize } from '../src/stem-analysis';

/**
 * Del 20 A: groove-målene på syntetiske signaler med kjent fasit (krever Python-miljøet .venv-lyrics med numpy/scipy).
 * Swing 0/10/20 % innen ±2 %, tempo innen 0,1 BPM, første slag innen ±10 ms, og vokalkartet.
 */
const root = path.resolve(__dirname, '..', '..', '..');
const python = path.join(root, '.venv-lyrics', 'Scripts', 'python.exe');
const script = path.resolve(__dirname, '..', 'scripts', 'test_groove.py');

describe.runIf(existsSync(python))('groove-analyse (syntetisk, krever .venv-lyrics)', () => {
  it('swing, tempo, første slag og vokal treffer fasiten', { timeout: 120_000 }, () => {
    const r = spawnSync(python, [script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!) as Record<string, unknown>;
    expect(Math.abs((out.swing0 as number) - 0)).toBeLessThanOrEqual(2);
    expect(Math.abs((out.swing10 as number) - 10)).toBeLessThanOrEqual(2);
    expect(Math.abs((out.swing20 as number) - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs((out.gridBpm as number) - 124)).toBeLessThanOrEqual(0.1);
    expect(Math.abs((out.firstBeatMs as number) - 500)).toBeLessThanOrEqual(10);
    expect(out.vocals).toEqual([
      [4000, 9000],
      [15000, 22000]
    ]);
  });
});

describe('sammendraget i manifestet', () => {
  it('tar med det settbyggeren trenger og runder vokaltidene', () => {
    const s = summarize(
      {
        schema: 1,
        grid: { bpm: 124, firstDownbeatMs: 480, bars: [480, 2416], barBpm: [124] },
        groove: { swing: 11.3, density: 0.6, fourOnFloor: true, hats: 0.4 },
        bass: { sub: 0.5, sustain: 0.7, introActive: false, outroActive: true },
        vocals: [[1000.4, 5000.6]],
        vocalShare: 0.4,
        ends: { intro: 32, outro: 16, introNoBass: 16, outroNoBass: 8 }
      },
      '2026-11-17T00:00:00.000Z'
    );
    expect(s).toMatchObject({ v: 1, swing: 11.3, fourOnFloor: true, bassOutro: true, introBars: 32, outroBars: 16, vocals: [[1000, 5001]], firstDownbeatMs: 480, gridBpm: 124 });
  });
});
