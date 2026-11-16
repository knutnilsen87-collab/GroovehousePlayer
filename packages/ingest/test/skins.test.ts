import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_SKIN_IDS } from '@gv/shared';
import { deleteSkin, readSkins, saveSkin, setSharedSkin } from '../src/skins-store';

/** Del 19: egne skins i data/skins/ og «samme på alle enheter». */
const built = new Set<string>(BUILT_IN_SKIN_IDS);
const mine = { id: 'mitt-rosa', name: 'Mitt rosa', mode: 'fixed', accent: '#FF5FD0', accent2: '#B070FF', background: { base: '#07080B' }, glow: 60 };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'gv-skins-'));

describe('skins-lageret', () => {
  it('lagrer, leser og sletter egne skins (alt ligger på disk, så det overlever omstart)', async () => {
    const dir = tmp();
    await saveSkin(dir, mine, built);
    expect(readdirSync(dir)).toContain('mitt-rosa.json');
    const st = await readSkins(dir);
    expect(st.custom.map((s) => s.id)).toEqual(['mitt-rosa']);
    expect(st.custom[0]!.accent).toBe('#FF5FD0');
    await deleteSkin(dir, 'mitt-rosa');
    expect((await readSkins(dir)).custom).toEqual([]);
  });

  it('nekter å overskrive et ferdig skin og ugyldige verdier', async () => {
    const dir = tmp();
    await expect(saveSkin(dir, { ...mine, id: 'kameleon' }, built)).rejects.toThrow(/ferdig skin/);
    await expect(saveSkin(dir, { ...mine, accent: 'rosa' }, built)).rejects.toThrow(/#RRGGBB/);
    await expect(saveSkin(dir, { ...mine, id: '../ut' }, built)).rejects.toThrow(/ugyldig id/);
  });

  it('«samme på alle enheter» lagres, og nullstilles når skinnet slettes', async () => {
    const dir = tmp();
    await saveSkin(dir, mine, built);
    await setSharedSkin(dir, 'mitt-rosa');
    expect((await readSkins(dir)).shared).toBe('mitt-rosa');
    await deleteSkin(dir, 'mitt-rosa');
    expect((await readSkins(dir)).shared).toBeNull();
    await setSharedSkin(dir, 'oled-svart');
    expect((await readSkins(dir)).shared).toBe('oled-svart');
    await setSharedSkin(dir, null);
    expect((await readSkins(dir)).shared).toBeNull();
  });

  it('en ødelagt fil stopper ikke resten', async () => {
    const dir = tmp();
    await saveSkin(dir, mine, built);
    writeFileSync(path.join(dir, 'odelagt.json'), '{ikke json');
    expect((await readSkins(dir)).custom).toHaveLength(1);
  });
});
