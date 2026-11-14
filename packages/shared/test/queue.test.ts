import { describe, expect, it } from 'vitest';
import { enqueue, fromStored, insertNext, moveAt, removeAt, toStored } from '../src/queue';

const s = (queue: string[], index: number) => ({ queue, index });

describe('køen', () => {
  it('spill neste og legg til i køen', () => {
    expect(insertNext(s(['a', 'b', 'c'], 0), ['x', 'y'])).toEqual(s(['a', 'x', 'y', 'b', 'c'], 0));
    expect(insertNext(s([], 0), ['x'])).toEqual(s(['x'], 0));
    expect(enqueue(s(['a', 'b'], 1), ['x'])).toEqual(s(['a', 'b', 'x'], 1));
    expect(enqueue(s([], 0), ['x'])).toEqual(s(['x'], 0));
  });

  it('fjern: plassen følger låta som spilles, og den kan ikke fjernes', () => {
    expect(removeAt(s(['a', 'b', 'c', 'd'], 2), 0)).toEqual(s(['b', 'c', 'd'], 1));
    expect(removeAt(s(['a', 'b', 'c', 'd'], 2), 3)).toEqual(s(['a', 'b', 'c'], 2));
    expect(removeAt(s(['a', 'b', 'c'], 1), 1)).toEqual(s(['a', 'b', 'c'], 1));
    expect(removeAt(s(['a'], 0), 5)).toEqual(s(['a'], 0));
  });

  it('flytt: låta som spilles beholder rollen sin', () => {
    expect(moveAt(s(['a', 'b', 'c', 'd'], 1), 3, 2)).toEqual(s(['a', 'b', 'd', 'c'], 1));
    expect(moveAt(s(['a', 'b', 'c', 'd'], 1), 0, 3)).toEqual(s(['b', 'c', 'd', 'a'], 0));
    expect(moveAt(s(['a', 'b', 'c', 'd'], 2), 3, 0)).toEqual(s(['d', 'a', 'b', 'c'], 3));
    expect(moveAt(s(['a', 'b', 'c', 'd'], 1), 1, 3)).toEqual(s(['a', 'c', 'd', 'b'], 3));
  });

  it('lagres og gjenopprettes; borte-elementer hoppes over og plassen justeres', () => {
    const a = (slug: string, version = 1) => ({ manifest: { slug, variant: null, version } });
    const stored = toStored([a('x'), a('borte'), a('y', 2), a('z')], 2, 61_234.6);
    expect(stored).toEqual({ v: 1, items: [{ slug: 'x', variant: null, version: 1 }, { slug: 'borte', variant: null, version: 1 }, { slug: 'y', variant: null, version: 2 }, { slug: 'z', variant: null, version: 1 }], index: 2, positionMs: 61_235 });
    const back = fromStored(stored, (slug, _v, version) => (slug === 'borte' ? undefined : `${slug}@${version}`));
    expect(back).toEqual({ queue: ['x@1', 'y@2', 'z@1'], index: 1, positionMs: 61_235 });
    // Låta som spilte er borte: står på neste, fra start
    expect(fromStored({ ...stored, index: 1 }, (slug) => (slug === 'borte' ? undefined : slug))).toEqual({ queue: ['x', 'y', 'z'], index: 1, positionMs: 0 });
    expect(fromStored(null, () => 'x')).toBeNull();
  });
});
