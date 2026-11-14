import { describe, expect, it } from 'vitest';
import { estimateShareBytes, formatBytes, sanitizeFileName, shareFileName, shareText } from '../src/share';

describe('deling: filnavn', () => {
  it('fjerner ulovlige Windows-tegn, men beholder æøå og apostrofer', () => {
    expect(sanitizeFileName('Hva: «Kjærlighet»? <ja>/nei\\ | *')).toBe('Hva «Kjærlighet» ja nei');
    expect(sanitizeFileName("I'll Keep It Real")).toBe("I'll Keep It Real");
    expect(sanitizeFileName('Blåbær på Ørje...  ')).toBe('Blåbær på Ørje');
    expect(sanitizeFileName('tab\tog\nlinjeskift')).toBe('tab og linjeskift');
    expect(sanitizeFileName('CON')).toBe('Groovehouse CON');
  });

  it('«Echo Groove - Tittel (Variant).m4a»', () => {
    expect(shareFileName({ artist: 'Echo Groove', title: 'Eyes On You', kind: 'full' })).toBe('Echo Groove - Eyes On You.m4a');
    expect(shareFileName({ artist: 'Echo Groove', title: 'Blue Fire', variantLabel: 'Extended Mix', kind: 'full' })).toBe('Echo Groove - Blue Fire (Extended Mix).m4a');
    expect(shareFileName({ title: "Whatchu Talkin' Bout?", kind: 'wav' })).toBe("Echo Groove - Whatchu Talkin' Bout.wav");
    expect(shareFileName({ title: 'Feel Good', kind: 'preview' })).toBe('Echo Groove - Feel Good (smakebit).m4a');
  });
});

describe('deling: tekst', () => {
  it('er «Echo Groove – Tittel · Groovehouse Records» og inneholder aldri vertsnavn eller IP', () => {
    expect(shareText({ artist: 'Echo Groove', title: 'Eyes On You' })).toBe('Echo Groove – Eyes On You · Groovehouse Records');
    for (const evil of ['https://pc.tail1234.ts.net/media', 'pc.tail1234.ts.net', 'http://10.0.0.47:41733/', '192.168.1.20', 'vault.local', 'ftp://x.example/y']) {
      const t = shareText({ title: `Låt ${evil} slutt` });
      expect(t, evil).not.toMatch(/ts\.net|\d+\.\d+\.\d+\.\d+|:\/\/|\.local\b/);
      expect(t).toContain('Låt');
      expect(t).toContain('slutt');
    }
  });
});

describe('deling: størrelse', () => {
  it('anslår størrelsen før nedlasting', () => {
    expect(estimateShareBytes('full', { durationMs: 240_000 })).toBe(7_880_000);
    expect(estimateShareBytes('wav', { durationMs: 1_000, sampleRate: 44_100, channels: 2 })).toBe(176_444);
    expect(formatBytes(7_880_000)).toBe('8 MB');
    expect(formatBytes(1_250_000_000)).toBe('1,3 GB');
  });
});
