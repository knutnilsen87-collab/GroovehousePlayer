import { describe, expect, it } from 'vitest';
import { mergePoint, resumeOffer, resumeText, validPoint, type PlaybackPoint } from '../src/playback';

const a: PlaybackPoint = { slug: 'live-sett-demo', variant: 'main', positionMs: 62_140, updatedAt: '2026-11-15T10:00:00.000Z', deviceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', deviceLabel: 'PC-en' };
const b: PlaybackPoint = { ...a, positionMs: 90_000, updatedAt: '2026-11-15T10:01:00.000Z', deviceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', deviceLabel: 'Mobilen' };

describe('avspillingsposisjon', () => {
  it('nyeste tidsstempel vinner', () => {
    expect(mergePoint(a, b).deviceId).toBe(b.deviceId);
    expect(mergePoint(b, a).deviceId).toBe(b.deviceId);
    expect(mergePoint(null, a)).toEqual(a);
  });

  it('banner bare når en annen enhet er mer enn 15 sekunder unna', () => {
    expect(resumeOffer(a, b, a.deviceId)?.deviceLabel).toBe('Mobilen');
    expect(resumeOffer(b, a, b.deviceId)).toBeNull();
    expect(resumeOffer({ ...a, positionMs: 80_000, updatedAt: '2026-11-15T10:02:00.000Z' }, { ...b, positionMs: 88_000, updatedAt: '2026-11-15T10:03:00.000Z' }, a.deviceId)).toBeNull();
    expect(resumeText('Live-sett', b)).toBe('Spilte på Mobilen – Live-sett 1:30. Fortsett her?');
  });

  it('avviser ugyldige punkt', () => {
    expect(validPoint(a)).toBe(true);
    expect(validPoint({ ...a, slug: '../x' })).toBe(false);
    expect(validPoint({ ...a, deviceId: 'kort' })).toBe(false);
  });
});
