import { describe, expect, it } from 'vitest';
import { carryMarkers, markerKey, mergeMarkers, snapToBar, validateMarkers, type MarkersFile } from '../src/markers';
import type { AssetMarker } from '../src/types';

const ch = (label: string, startMs: number, extra: Partial<AssetMarker> = {}): AssetMarker => ({ kind: 'chapter', source: 'analysis', startMs, label, confirmed: false, ...extra });
const analysis = [ch('Intro', 0), ch('Build', 30_000), ch('Drop 1', 60_000), ch('Break', 90_000), ch('Drop 2', 120_000), ch('Outro', 150_000)];
const file = (markers: AssetMarker[], dismissed: string[] = []): MarkersFile => ({ schema: 1, updatedAt: '2026-11-14T00:00:00Z', markers, dismissed });

describe('sammenslåing av analyseforslag og Knuts rettelser (del 2)', () => {
  it('uten markers.json: forslagene, med endMs til neste seksjon', () => {
    const r = mergeMarkers(analysis, null);
    expect(r.map((m) => m.label)).toEqual(['Intro', 'Build', 'Drop 1', 'Break', 'Drop 2', 'Outro']);
    expect(r[2]!.endMs).toBe(90_000);
    expect(r[5]!.endMs).toBeUndefined();
  });

  it('flyttet Drop 1 (manuell) overlever, og forslaget med samme navn kommer ikke tilbake', () => {
    const moved = ch('Drop 1', 64_000, { source: 'manual', confirmed: true });
    const r = mergeMarkers(analysis, file([ch('Intro', 0), ch('Build', 30_000), moved]));
    const drops = r.filter((m) => m.label === 'Drop 1');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ startMs: 64_000, source: 'manual', confirmed: true });
    expect(r.find((m) => m.label === 'Build')!.endMs).toBe(64_000);
  });

  it('godkjent forslag beholdes; ubekreftede erstattes av nye forslag', () => {
    const r = mergeMarkers([ch('Intro', 0), ch('Build', 31_000)], file([ch('Intro', 0, { confirmed: true }), ch('Build', 29_000)]));
    expect(r.find((m) => m.label === 'Intro')!.confirmed).toBe(true);
    expect(r.find((m) => m.label === 'Build')!.startMs).toBe(31_000); // nytt forslag, ikke den gamle ubekreftede
  });

  it('slettede forslag kommer ikke tilbake; nye forslag nær en manuell markør droppes', () => {
    const r = mergeMarkers(analysis, file([ch('Hook', 60_400, { source: 'manual', confirmed: true })], [markerKey(ch('Outro', 0))]));
    expect(r.some((m) => m.label === 'Outro')).toBe(false);
    expect(r.some((m) => m.label === 'Drop 1')).toBe(false); // 400 ms fra «Hook»
    expect(r.some((m) => m.label === 'Hook')).toBe(true);
  });

  it('ny versjon: rettelsene overføres som ubekreftede, kartlagt mot naboseksjonene', () => {
    const prev = { durationMs: 180_000, markers: mergeMarkers(analysis, file([ch('Build', 30_000, { confirmed: true }), ch('Drop 1', 64_000, { source: 'manual', confirmed: true })])) };
    // v2 har 10 s lengre intro: analysen finner Build ved 40 s
    const nextAnalysis = analysis.map((m) => (m.startMs ? { ...m, startMs: m.startMs + 10_000 } : m));
    const r = carryMarkers(prev, { durationMs: 190_000, markers: nextAnalysis });
    const d1 = r.find((m) => m.label === 'Drop 1')!;
    expect(d1.confirmed).toBe(false);
    expect(d1.source).toBe('manual');
    // 34 s etter Build i v1 (av 30 s seksjon … kartlagt proporsjonalt) → nær 74 s i v2
    expect(Math.abs(d1.startMs - 74_000)).toBeLessThan(1500);
    expect(r.filter((m) => m.label === 'Drop 1')).toHaveLength(1);
    // samme lengde → samme tid
    expect(carryMarkers(prev, { durationMs: 180_000, markers: analysis }).find((m) => m.label === 'Drop 1')!.startMs).toBe(64_000);
  });

  it('validering og takt-festing', () => {
    expect(validateMarkers([{ kind: 'chapter', startMs: 5000, label: ' Drop  1 ', confirmed: true }], 10_000)).toMatchObject({ ok: true, markers: [{ label: 'Drop 1', source: 'manual', confirmed: true }] });
    expect(validateMarkers([{ kind: 'chapter', startMs: 20_000, label: 'X' }], 10_000).ok).toBe(false);
    expect(validateMarkers([{ kind: 'chapter', startMs: 1, label: '' }], 10_000).ok).toBe(false);
    expect(validateMarkers([{ kind: 'boom', startMs: 1 }], 10_000).ok).toBe(false);
    expect(validateMarkers('nei', 10_000).ok).toBe(false);
    expect(snapToBar(62_900, 120)).toBe(62_000); // takt = 2 s ved 120 BPM
    expect(snapToBar(63_100, 120)).toBe(64_000);
    expect(snapToBar(63_100, null)).toBe(63_100);
  });
});
