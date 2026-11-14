import { describe, expect, it } from 'vitest';
import { camelotNeighbors, clampRate, formatTimeMs, keyShort, lyricIndexAt, makeLoop, mixesWith, parseLyrics, snapToBeat } from '../src/studio';

describe('LRC (del 14)', () => {
  it('leser tidsstempler, flere per linje, offset og fjerner metadata', () => {
    const p = parseLyrics('﻿[ti:Still Breathing]\n[ar:Echo Groove]\n[offset:+100]\n[00:12.50]Første\n[00:05.00][01:00.123]Refreng\n\n[00:20]Uten brøk');
    expect(p.synced).toBe(true);
    expect(p.lines).toEqual([
      { ms: 4900, text: 'Refreng' },
      { ms: 12400, text: 'Første' },
      { ms: 19900, text: 'Uten brøk' },
      { ms: 60023, text: 'Refreng' }
    ]);
  });
  it('to- og tresifret brøk (hundredeler og tusendeler)', () => {
    expect(parseLyrics('[01:02.5]a\n[01:02.05]b\n[01:02.005]c').lines.map((l) => l.ms)).toEqual([62005, 62050, 62500]);
  });
  it('ren tekst blir usynkronisert, uten tomme linjer i endene', () => {
    const p = parseLyrics('\n\nLinje en\n\nLinje to\n\n');
    expect(p.synced).toBe(false);
    expect(p.lines.map((l) => l.text)).toEqual(['Linje en', '', 'Linje to']);
  });
  it('finner linja som synges nå', () => {
    const { lines } = parseLyrics('[00:01]a\n[00:05]b\n[00:09]c');
    expect(lyricIndexAt(lines, 0)).toBe(-1);
    expect(lyricIndexAt(lines, 1000)).toBe(0);
    expect(lyricIndexAt(lines, 8999)).toBe(1);
    expect(lyricIndexAt(lines, 60_000)).toBe(2);
  });
});

describe('toneart og Camelot', () => {
  it('kort toneart', () => {
    expect(keyShort('A minor')).toBe('Am');
    expect(keyShort('F# major')).toBe('F#');
    expect(keyShort('A# minor')).toBe('Bbm');
    expect(keyShort('E♭ major')).toBe('Eb');
    expect(keyShort('F♯ minor')).toBe('F#m');
    expect(keyShort('8A')).toBe('8A');
    expect(keyShort(null)).toBe('–');
  });
  it('naboer på hjulet, med omløp 12 → 1', () => {
    expect(camelotNeighbors('8A')).toEqual(['8A', '7A', '9A', '8B']);
    expect(camelotNeighbors('12B')).toEqual(['12B', '11B', '1B', '12A']);
    expect(camelotNeighbors('1A')).toContain('12A');
  });
  it('«passer etter denne»: Camelot-nabo og BPM ±3 %', () => {
    const a = { bpm: 125, camelot: '8A' };
    expect(mixesWith(a, { bpm: 128.7, camelot: '9A' })).toBe(true);
    expect(mixesWith(a, { bpm: 129, camelot: '9A' })).toBe(false);
    expect(mixesWith(a, { bpm: 125, camelot: '3A' })).toBe(false);
    expect(mixesWith(a, { bpm: 125, camelot: '8B' })).toBe(true);
    expect(mixesWith(a, { bpm: null, camelot: '8A' })).toBe(false);
  });
});

describe('A·B-løkke og hastighet', () => {
  it('hastighet 0,90–1,10 i steg på 0,01', () => {
    expect(clampRate(1.234)).toBe(1.1);
    expect(clampRate(0.5)).toBe(0.9);
    expect(clampRate(1.004)).toBe(1);
    expect(clampRate(1.016)).toBe(1.02);
    expect(clampRate(NaN)).toBe(1);
  });
  it('fester til takt (120 BPM = 500 ms)', () => {
    expect(snapToBeat(1240, 120)).toBe(1000);
    expect(snapToBeat(1260, 120)).toBe(1500);
    expect(snapToBeat(1260, null)).toBe(1260);
  });
  it('løkke: sortert, festet, minst ett slag, innenfor låta; Shift slår av festing', () => {
    expect(makeLoop(4100, 2100, 60_000, 120)).toEqual({ a: 2000, b: 4000 });
    expect(makeLoop(2100, 2200, 60_000, 120)).toEqual({ a: 2000, b: 2500 });
    expect(makeLoop(2100, 4100, 60_000, 120, false)).toEqual({ a: 2100, b: 4100 });
    expect(makeLoop(59_900, 61_000, 60_000, 120)).toEqual({ a: 59_500, b: 60_000 });
    expect(makeLoop(1000, 1100, 60_000, null)).toEqual({ a: 1000, b: 1250 });
  });
  it('tid med millisekunder', () => {
    expect(formatTimeMs(161_320)).toBe('02:41.320');
    expect(formatTimeMs(384_310)).toBe('06:24.310');
    expect(formatTimeMs(3_761_005)).toBe('1:02:41.005');
  });
});
