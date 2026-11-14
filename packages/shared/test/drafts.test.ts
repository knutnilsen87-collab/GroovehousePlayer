import { describe, expect, it } from 'vitest';
import { draftTitle, flowBetween, isDraft, matchesStatus, planStats, preferredVersion, statusOf, toDraftVersion, versionName } from '../src/drafts';

describe('utkast (del 16)', () => {
  it('egne versjonsnumre som ikke kolliderer med release', () => {
    expect(toDraftVersion(3)).toBe(1003);
    expect(statusOf({ version: 3 })).toBe('release');
    expect(statusOf({ version: 1003 })).toBe('draft');
    expect(statusOf({ version: 1003, status: 'release' })).toBe('release'); // gjort release-klar i Studio
    expect(versionName({ version: 1003 })).toBe('Utkast v3');
    expect(versionName({ version: 2 })).toBe('v2');
    expect(isDraft({ version: 1001 })).toBe(true);
  });
  it('«følg nyeste» foretrekker release, ellers nyeste utkast', () => {
    expect(preferredVersion([{ version: 1004 }, { version: 2 }, { version: 1 }])!.version).toBe(2);
    expect(preferredVersion([{ version: 1004 }, { version: 1002 }])!.version).toBe(1004);
    expect(preferredVersion([])).toBeUndefined();
  });
  it('filter: release-klar, utkast, alle', () => {
    expect(matchesStatus({ version: 2 }, 'release')).toBe(true);
    expect(matchesStatus({ version: 1002 }, 'release')).toBe(false);
    expect(matchesStatus({ version: 1002 }, 'draft')).toBe(true);
    expect(matchesStatus({ version: 1002 }, 'all')).toBe(true);
  });
  it('flyt i planer: grønn harmonisk, gul ±1, rød brudd eller over 6 % tempo', () => {
    expect(flowBetween({ bpm: 124, camelot: '8A' }, { bpm: 125, camelot: '8B' })).toBe('green');
    expect(flowBetween({ bpm: 124, camelot: '8A' }, { bpm: 125, camelot: '9A' })).toBe('yellow');
    expect(flowBetween({ bpm: 124, camelot: '8A' }, { bpm: 125, camelot: '3B' })).toBe('red');
    expect(flowBetween({ bpm: 124, camelot: '8A' }, { bpm: 135, camelot: '8A' })).toBe('red');
    expect(flowBetween({ bpm: 124, camelot: '8A' }, { bpm: 62, camelot: '8A' })).toBe('green'); // halvt tempo
    expect(flowBetween({ bpm: 124, camelot: null }, { bpm: 124, camelot: '8A' })).toBe('unknown');
  });
  it('«2 av 7 mastret», total tid og flyt', () => {
    const r = (status: 'release' | 'draft') => ({ status, durationMs: 60_000, bpm: 124, camelot: '8A' });
    const s = planStats([r('draft'), r('release'), r('draft'), r('draft'), r('release'), r('draft'), r('draft')]);
    expect(s).toMatchObject({ total: 7, mastered: 2, durationMs: 420_000 });
    expect(s.flows).toHaveLength(6);
  });
  it('tittel ved deling av utkast', () => {
    expect(draftTitle('Night Drive')).toBe('Night Drive (Utkast)');
    expect(draftTitle('Night Drive (Utkast)')).toBe('Night Drive (Utkast)');
  });
});
