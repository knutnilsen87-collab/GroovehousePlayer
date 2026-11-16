import { describe, expect, it } from 'vitest';
import { cleanDisplayTitle, isLandr, titleKey } from '../src/dupes';

describe('tittelrensing for duplikater', () => {
  it('fjerner spornummer, LANDR-merking og kopimerker', () => {
    expect(cleanDisplayTitle('01. Got Something To Say')).toBe('Got Something To Say');
    expect(cleanDisplayTitle('02 — Night Drive')).toBe('Night Drive');
    expect(cleanDisplayTitle('1. Blue Fire')).toBe('Blue Fire');
    expect(cleanDisplayTitle('3.Better Now')).toBe('Better Now');
    expect(cleanDisplayTitle('LANDR-5. It’s Summertime-Balanced-Medium')).toBe("It's Summertime");
    expect(cleanDisplayTitle("It's Summertime 2")).toBe("It's Summertime");
    expect(cleanDisplayTitle('Deep Tools1.6')).toBe('Deep Tools');
    // «(1)C» / «(1)COOL» fra filnavnet er kopimerker; «Pretty Cool» er en ekte tittel
    expect(cleanDisplayTitle('03. WALK LIKE YOU OWN IT (1)C.wav')).toBe('WALK LIKE YOU OWN IT');
    expect(cleanDisplayTitle('02. PAY ATTENTION (1)COOL.wav')).toBe('PAY ATTENTION');
    expect(cleanDisplayTitle('Pretty Cool')).toBe('Pretty Cool');
    expect(cleanDisplayTitle('3.14Ano2')).toBe('3.14Ano2');
    expect(cleanDisplayTitle('1Echo Groove låter__Love me.wav')).toBe('Love me');
    expect(cleanDisplayTitle('1Echo Groove låter Get on the floor.mp3')).toBe('Get on the floor');
  });

  it('lar ekte titler være', () => {
    expect(cleanDisplayTitle('1999')).toBe('1999');
    expect(cleanDisplayTitle('Better Now (Extend)')).toBe('Better Now (Extend)');
    expect(cleanDisplayTitle('Get Up 4 Love')).toBe('Get Up 4 Love'); // tall inni tittelen er ikke kopimerke
    expect(cleanDisplayTitle('2. No Face, All Groove Pt 1')).toBe('No Face, All Groove Pt 1');
    expect(titleKey('No Face, All Groove Pt 1')).not.toBe(titleKey('No Face, All Groove Pt 2'));
    expect(cleanDisplayTitle('Echo Groove - Unique')).toBe('Unique');
    expect(cleanDisplayTitle('1FerdigMix__LANDR-Lost-Balanced-Medium.wav')).toBe('Lost');
  });

  it('samme nøkkel for eksporter av samme låt, også med versjonsord i parentes', () => {
    const k = titleKey("It's Summertime");
    for (const t of ["It's Summertime 2", '5. It’s Summertime', 'LANDR-5. It’s Summertime-Balanced-Medium']) expect(titleKey(t)).toBe(k);
    expect(titleKey('Better Now (Denne)')).toBe(titleKey('3.Better Now'));
    expect(titleKey('Better Now')).not.toBe(titleKey('Better Days'));
  });

  it('kjenner igjen LANDR-mastere', () => {
    expect(isLandr('LANDR-3.Better Now-Balanced-Medium.wav')).toBe(true);
    expect(isLandr('Better Now (Warm-High).wav')).toBe(false);
    expect(isLandr('Better Now-Warm-High.wav')).toBe(true);
    expect(isLandr('Landscape.wav')).toBe(false);
  });
});
