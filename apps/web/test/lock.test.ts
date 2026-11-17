import { describe, expect, it } from 'vitest';
import { resolveEntries, type PlaylistEntry } from '@gv/shared/web';
import { entriesToSave, newlyLocked } from '../src/lib/lock';

/** Del 27 pkt. 7–8: en låst v3 i et sett overlever en ny bounce (v4); «følg nyeste» oppdateres. */
const asset = (version: number) => ({ manifest: { slug: 'blue-fire', variant: null, version, title: 'Blue Fire', createdAt: `2026-11-0${version}`, durationMs: 1, kind: 'track' } });
const entry = (id: string, version: number | null): PlaylistEntry => ({ id, slug: 'blue-fire', variant: null, version, addedAt: '2026-11-01' }) as PlaylistEntry;

describe('versjonslås', () => {
  it('v4 endrer ikke en låst v3, mens «følg nyeste» går til v4', () => {
    const v3 = asset(3);
    const v4 = asset(4);
    // Etter ny bounce: katalogen viser v4 som hovedversjon; v3 finnes fortsatt i media/
    const tracks = [{ slug: 'blue-fire', main: v4, variants: [v4] }];
    const find = (_s: string, _v: string | null, version: number) => (version === 3 ? v3 : version === 4 ? v4 : undefined);
    const [locked, follow] = resolveEntries([entry('a', 3), entry('b', null)], tracks, find);
    expect(locked!.asset!.manifest.version).toBe(3);
    expect(follow!.asset!.manifest.version).toBe(4);
  });

  it('i et sett låses versjonen som vises; vanlige lister følger nyeste', () => {
    const items = [{ slug: 'blue-fire', variant: null, version: null, shown: { version: 3, title: 'Blue Fire', variantLabel: null } }];
    expect(entriesToSave(items, 'set')).toEqual([{ slug: 'blue-fire', variant: null, version: 3 }]);
    expect(entriesToSave(items, null)).toEqual([{ slug: 'blue-fire', variant: null, version: null }]);
    expect(entriesToSave(items, 'album')).toEqual([{ slug: 'blue-fire', variant: null, version: null }]);
  });

  it('en eksplisitt lås beholdes, og bare nye låser bekreftes', () => {
    const items = [
      { slug: 'a', variant: null, version: 2, shown: { version: 5, title: 'A', variantLabel: null } },
      { slug: 'b', variant: 'extended', version: null, shown: { version: 1, title: 'B', variantLabel: 'Extended' } }
    ];
    expect(entriesToSave(items, 'set').map((e) => e.version)).toEqual([2, 1]);
    expect(newlyLocked(items, 'set')).toEqual([{ title: 'B', variantLabel: 'Extended', version: 1 }]);
    expect(newlyLocked(items, null)).toEqual([]);
  });

  it('bare slug, variant og versjon sendes til serveren (ikke tittel eller utkast-merke)', () => {
    const saved = entriesToSave([{ slug: 'a', variant: null, draft: true, shown: { version: 1, title: 'A', variantLabel: null } }], 'set');
    expect(Object.keys(saved[0]!).sort()).toEqual(['slug', 'variant', 'version']);
  });
});
