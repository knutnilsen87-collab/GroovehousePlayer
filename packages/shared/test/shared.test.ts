import { describe, expect, it } from 'vitest';
import { choosePalette, contrastOnObsidian } from '../src/palette';
import { FALLBACK_PALETTE } from '../src/theme';
import { parseMasterName, slugify, titleFromSlug, formatTime } from '../src/naming';
import { computeCoverage } from '../src/coverage';

describe('choosePalette', () => {
  it('velger den mest levende fargen, ikke den mest dominerende', () => {
    const p = choosePalette([
      { hex: '#101114', population: 1 }, // nesten svart, dominerende
      { hex: '#3a3d44', population: 0.6 },
      { hex: '#0aa9c4', population: 0.15 } // cyan, liten men levende
    ]);
    expect(p.source).toBe('cover');
    // Kulør skal være i cyan-området
    const n = parseInt(p.primary.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
  });

  it('løfter mørke farger til ≥ 4.5:1 mot obsidian', () => {
    const p = choosePalette([{ hex: '#1a237e', population: 1 }]); // mørk blå
    expect(contrastOnObsidian(p.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it('faller tilbake til standardfargen cyan (ikke gull) for fargeløse cover', () => {
    const p = choosePalette([
      { hex: '#111111', population: 1 },
      { hex: '#888888', population: 0.5 },
      { hex: '#eeeeee', population: 0.2 }
    ]);
    expect(p).toEqual(FALLBACK_PALETTE);
    expect(p.primary).toBe('#01E6FC');
  });

  it('gir sekundærfarge og lesbar tekstfarge', () => {
    const p = choosePalette([
      { hex: '#ff2d95', population: 0.4 },
      { hex: '#6a1bff', population: 0.3 }
    ]);
    expect(p.secondary).toMatch(/^#[0-9a-f]{6}$/);
    expect(['#07080B', '#F4F1EA']).toContain(p.onPrimary);
  });
});

describe('parseMasterName', () => {
  it('leser versjon fra _vN', () => {
    expect(parseMasterName('would-you-run', 'would-you-run_v3.wav')).toEqual({ slug: 'would-you-run', variant: null, version: 3, slugMismatch: false });
  });
  it('mangler versjon → v1', () => {
    expect(parseMasterName('blue-fire', 'blue-fire.wav').version).toBe(1);
  });
  it('mappenavnet vinner ved avvik', () => {
    const r = parseMasterName('blue-fire', 'Blue Fire FINAL_v2.wav');
    expect(r.slug).toBe('blue-fire');
    expect(r.version).toBe(2);
    expect(r.slugMismatch).toBe(true);
  });
  it('leser variant fra __variant', () => {
    expect(parseMasterName('would-you-run', 'would-you-run__Extended Mix_v2.wav')).toEqual({ slug: 'would-you-run', variant: 'extended-mix', version: 2, slugMismatch: false });
    expect(parseMasterName('would-you-run', 'would-you-run__vip-dub.wav')).toMatchObject({ variant: 'vip-dub', version: 1 });
    expect(parseMasterName('would-you-run', 'would-you-run__main_v4.wav')).toMatchObject({ variant: null, version: 4 });
  });
  it('slugify håndterer norske tegn', () => {
    expect(slugify('Sjø og Lærkø Ås')).toBe('sjo-og-laerko-as');
  });
  it('lager titler og tid', () => {
    expect(titleFromSlug('would-you-run')).toBe('Would You Run');
    expect(formatTime(372000)).toBe('6:12');
    expect(formatTime(3725000)).toBe('1:02:05');
  });
});

describe('computeCoverage', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 10, 13, 22, 0, s)).toISOString();
  it('spiller, spoler tilbake til droppet og lytter ferdig', () => {
    const dur = 372_000;
    const c = computeCoverage(
      [
        { event: 'open', positionMs: 0, at: t(0) },
        { event: 'play', positionMs: 0, at: t(1) },
        { event: 'seek', positionMs: 105_000, toMs: 80_000, at: t(2) },
        { event: 'ended', positionMs: dur, at: t(3) }
      ],
      dur,
      48
    );
    expect(c.finished).toBe(true);
    expect(c.heardRatio).toBe(1);
    // Bøtter mellom 1:20 og 1:45 er spilt to ganger
    const bucketMs = dur / 48;
    expect(c.plays[Math.floor(90_000 / bucketMs)]).toBe(2);
    expect(c.plays[0]).toBe(1);
  });
  it('falt av midt i låta', () => {
    const c = computeCoverage(
      [
        { event: 'play', positionMs: 0, at: t(0) },
        { event: 'heartbeat', positionMs: 108_000, at: t(1) }
      ],
      372_000
    );
    expect(c.finished).toBe(false);
    expect(c.stoppedAtMs).toBe(108_000);
    expect(c.heardRatio).toBeGreaterThan(0.25);
    expect(c.heardRatio).toBeLessThan(0.32);
  });
});

import { mapPositionBetweenVariants, nextSectionStart, prevSectionStart, sectionAt } from '../src/sections';
import type { AssetMarker } from '../src/types';

describe('sections', () => {
  const ch = (startMs: number, endMs: number, label: string): AssetMarker => ({ kind: 'chapter', source: 'analysis', startMs, endMs, label, confirmed: false });
  const radio = [ch(0, 10_000, 'Intro'), ch(10_000, 40_000, 'Drop 1'), ch(40_000, 60_000, 'Break'), ch(60_000, 90_000, 'Drop 2')];
  const ext = [ch(0, 30_000, 'Intro'), ch(30_000, 90_000, 'Drop 1'), ch(90_000, 120_000, 'Break'), ch(120_000, 180_000, 'Drop 2')];

  it('finner del og hopper', () => {
    expect(sectionAt(radio, 45_000)?.label).toBe('Break');
    expect(nextSectionStart(radio, 45_000)).toBe(60_000);
    expect(nextSectionStart(radio, 70_000)).toBeNull();
    expect(prevSectionStart(radio, 45_000)).toBe(40_000);
    expect(prevSectionStart(radio, 41_000)).toBe(10_000);
  });

  it('variantbytte lander i samme del', () => {
    // Halvveis i Drop 1 i radio → halvveis i Drop 1 i extended
    expect(mapPositionBetweenVariants({ markers: radio, durationMs: 90_000 }, { markers: ext, durationMs: 180_000 }, 25_000)).toBe(60_000);
  });
});
