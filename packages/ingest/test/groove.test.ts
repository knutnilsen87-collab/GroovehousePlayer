import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize, vocalsFromWords, withWordVocals } from '../src/stem-analysis';

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

describe('vokalkart fra ordtidene i teksten', () => {
  it('slår sammen ord med korte pauser og fjerner små biter', () => {
    const words = [
      { start: 8.0, end: 8.4 },
      { start: 8.6, end: 9.1 },
      { start: 10.0, end: 12.0 },
      { start: 30.0, end: 30.3 },
      { start: 60.0, end: 61.0 },
      { start: 62.0, end: 64.0 }
    ];
    expect(vocalsFromWords(words)).toEqual([
      [8000, 12000],
      [60000, 64000]
    ]);
  });
  it('gir ren intro/outro i takter fra første og siste ord, og beholder bass/groove', () => {
    const g = summarize({ schema: 1, grid: { bpm: 120, firstDownbeatMs: 0, bars: [0], barBpm: [] }, groove: { swing: 5, density: 0.5, fourOnFloor: true, hats: 0.4 }, bass: { sub: 0.5, sustain: 0.6, introActive: true, outroActive: true }, vocals: [[0, 200_000]], vocalShare: 1, ends: { intro: 0, outro: 0, introNoBass: 8, outroNoBass: 8 } });
    const w = withWordVocals(g, [[32_000, 150_000]], 200_000);
    // 120 BPM = 2 s per takt: første ord etter 16 takter, siste slutter 25 takter før slutt → 24
    expect(w.introBars).toBe(16);
    expect(w.outroBars).toBe(24);
    expect(w.introNoBass).toBe(8);
    expect(w.vocalSource).toBe('words');
    expect(w.swing).toBe(5);
  });
});