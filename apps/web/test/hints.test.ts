import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Del 27 pkt. 16: stille hint – én gang per enhet, «Vis hint igjen» nullstiller alle (også DJ-låsen). */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.resetModules();
});

describe('stille hint', () => {
  it('vises til de lukkes, og huskes per enhet uten sensitive data', async () => {
    const { useHints } = await import('../src/lib/hints');
    expect(useHints.getState().seen['save-to-list']).toBe(false);
    useHints.getState().dismiss('save-to-list');
    expect(useHints.getState().seen['save-to-list']).toBe(true);
    expect([...store.entries()]).toEqual([['gv:hint:save-to-list', '1']]);
    // Ny innlasting (ny økt) leser det samme
    vi.resetModules();
    const again = await import('../src/lib/hints');
    expect(again.useHints.getState().seen).toEqual({ 'save-to-list': true, 'dj-lock': false, unmastered: false });
  });

  it('«Vis hint igjen» nullstiller alle, også forklaringen av DJ-låsen', async () => {
    store.set('gv:hint:dj-lock', '1');
    store.set('gv:hint:unmastered', '1');
    store.set('gv:skin', 'kameleon');
    const { useHints } = await import('../src/lib/hints');
    const { lockExplained } = await import('../src/components/DjLock');
    expect(lockExplained()).toBe(true);
    useHints.getState().reset();
    expect(lockExplained()).toBe(false);
    expect(Object.values(useHints.getState().seen).every((v) => !v)).toBe(true);
    expect(store.get('gv:skin')).toBe('kameleon');
  });

  it('hintene er ikke modale og tar ikke fokus', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/components/Hint.tsx'), 'utf8');
    expect(src).toContain('role="status"');
    expect(src).not.toMatch(/aria-modal|useDialog|\.focus\(/);
  });
});
