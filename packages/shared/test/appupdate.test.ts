import { describe, expect, it } from 'vitest';
import { bundleVersionAt, minNativeFor, nextVersionCode, shouldOfferApk, shouldTakeBundle } from '../src/appupdate';

describe('oppdatering av appen (del 15)', () => {
  it('bunt-versjon øker med tiden', () => {
    expect(bundleVersionAt(new Date('2026-11-14T15:04:05Z'))).toBe(20261114150405);
    expect(bundleVersionAt(new Date('2026-11-14T15:04:06Z'))).toBeGreaterThan(bundleVersionAt(new Date('2026-11-14T15:04:05Z')));
  });
  it('tar bare nyere bunt, og bare når native er ny nok (minNative)', () => {
    const app = { bundleVersion: 100, versionCode: 50 };
    expect(shouldTakeBundle({ version: 101, minNative: 50 }, app)).toBe(true);
    expect(shouldTakeBundle({ version: 100, minNative: 1 }, app)).toBe(false);
    expect(shouldTakeBundle({ version: 99, minNative: 1 }, app)).toBe(false);
    expect(shouldTakeBundle({ version: 101, minNative: 51 }, app)).toBe(false);
    expect(shouldTakeBundle({ version: 101, minNative: 1 }, { ...app, badBundle: 101 })).toBe(false);
    expect(shouldTakeBundle(null, app)).toBe(false);
  });
  it('«Oppdater»-banner bare for høyere versionCode', () => {
    expect(shouldOfferApk({ versionCode: 51 }, 50)).toBe(true);
    expect(shouldOfferApk({ versionCode: 50 }, 50)).toBe(false);
    expect(shouldOfferApk(null, 50)).toBe(false);
  });
  it('versionCode går aldri ned, selv med færre commits på en annen gren', () => {
    expect(nextVersionCode(null, 47)).toBe(47);
    expect(nextVersionCode(47, 47)).toBe(48);
    expect(nextVersionCode(60, 40)).toBe(61);
    expect(nextVersionCode(10, 80)).toBe(80);
    expect(nextVersionCode(undefined, 0)).toBe(1);
  });
  it('minNative: samme native kode → siste APK, endret native → én over (ingen gammel app tar bunten)', () => {
    expect(minNativeFor(null, 'x')).toBe(1);
    expect(minNativeFor({ versionCode: 48, nativeHash: 'a' }, 'a')).toBe(48);
    expect(minNativeFor({ versionCode: 48, nativeHash: 'a' }, 'b')).toBe(49);
  });
});
