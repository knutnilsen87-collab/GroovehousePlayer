import { describe, expect, it } from 'vitest';
import { liveLogToMarkers } from '../src/livelog';
import { camelotOf, estimateKey, estimateTempo, segmentStructure } from '../src/music';

describe('liveLogToMarkers', () => {
  const log = {
    schema: 1 as const,
    events: [
      { tMs: 1000, type: 'sync' as const },
      { tMs: 5000, type: 'track' as const, slug: 'blue-fire', label: 'Blue Fire' },
      { tMs: 300000, type: 'track' as const, slug: 'would-you-run' },
      { tMs: 400000, type: 'highlight' as const, label: 'Publikum tar av' }
    ]
  };
  it('forskyver alle markører etter sync-klikket i lyden', () => {
    const r = liveLogToMarkers(log, 3_600_000, 4500, 0);
    expect(r.synced).toBe(true);
    expect(r.offsetMs).toBe(3500);
    expect(r.markers[0]).toMatchObject({ kind: 'chapter', startMs: 8500, endMs: 303500, refSlug: 'blue-fire', confirmed: true });
    expect(r.markers[1]).toMatchObject({ startMs: 303500, endMs: 3_600_000, label: 'would-you-run' });
    expect(r.markers[2]).toMatchObject({ kind: 'highlight', startMs: 403500 });
  });
  it('uten funnet klikk: ingen forskyvning, ubekreftet', () => {
    const r = liveLogToMarkers(log, 3_600_000, null, 0);
    expect(r.synced).toBe(false);
    expect(r.markers.every((m) => !m.confirmed)).toBe(true);
  });
  it('manuell forskyvning legges på toppen', () => {
    expect(liveLogToMarkers(log, 3_600_000, 4500, -500).offsetMs).toBe(3000);
  });
});

describe('estimateTempo', () => {
  const hopRate = 22050 / 128;
  const pulses = (bpm: number, seconds: number) => {
    const n = Math.round(seconds * hopRate);
    const a = new Float32Array(n);
    const period = (60 / bpm) * hopRate;
    for (let t = 0; t < n; t += period) a[Math.round(t)] = 1;
    return a;
  };
  it.each([124, 125.5, 126, 128, 122])('finner %s BPM', (bpm) => {
    const r = estimateTempo(pulses(bpm, 60), hopRate);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - bpm)).toBeLessThan(0.6);
  });
  it('for kort lydklipp gir null', () => {
    expect(estimateTempo(pulses(125, 3), hopRate)).toBeNull();
  });
});

describe('estimateKey', () => {
  it('A-moll-treklang gir 8A', () => {
    const chroma = new Array(12).fill(0.02);
    chroma[9] = 1; // A
    chroma[0] = 0.8; // C
    chroma[4] = 0.9; // E
    const k = estimateKey(chroma);
    expect(k?.camelot).toBe('8A');
    expect(k?.name).toBe('A minor');
  });
  it('Camelot-hjulet', () => {
    expect(camelotOf(0, false)).toBe('8B'); // C dur
    expect(camelotOf(7, true)).toBe('6A'); // G moll
    expect(camelotOf(6, false)).toBe('2B'); // F# dur
  });
  it('stillhet gir null', () => {
    expect(estimateKey(new Array(12).fill(0))).toBeNull();
  });
});

describe('segmentStructure', () => {
  // 4 min: intro 0–60 s lav, drop 60–120 høy, break 120–160 lav, drop 160–220 høy, outro 220–240 lav
  const dur = 240_000;
  const energy = Array.from({ length: 1000 }, (_, i) => {
    const t = (i / 1000) * dur;
    return t < 60_000 ? 0.3 : t < 120_000 ? 0.95 : t < 160_000 ? 0.35 : t < 220_000 ? 0.95 : 0.3;
  });
  it('finner intro, build, drops, break og outro', () => {
    const m = segmentStructure(energy, dur, 125);
    const labels = m.filter((x) => x.kind === 'chapter').map((x) => x.label);
    expect(labels).toEqual(['Intro', 'Build', 'Drop 1', 'Break', 'Drop 2', 'Outro']);
    const drop1 = m.find((x) => x.label === 'Drop 1')!;
    expect(Math.abs(drop1.startMs - 60_000)).toBeLessThan(2500);
    expect(m.filter((x) => x.kind === 'drop')).toHaveLength(2);
    expect(m.every((x) => x.confirmed === false && x.source === 'analysis')).toBe(true);
  });
  it('flat energi gir ingen struktur', () => {
    expect(segmentStructure(new Array(1000).fill(0.5), dur, 125)).toEqual([]);
  });
});
