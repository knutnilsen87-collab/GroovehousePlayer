import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { paletteFrom } from '../src/cover';
import { camelotColors, renderVaultCover, vaultCoverSvg, type VaultCoverInput } from '../src/vault-cover';

const an = { peaks: Array.from({ length: 400 }, (_, i) => Math.abs(Math.sin(i / 9))), energy: Array.from({ length: 100 }, (_, i) => (i % 10) / 10), spectrum: { bands: 8, frameMs: 100, frames: [[0.9, 0.7, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05]] } };
const input = (o: Partial<VaultCoverInput> = {}): VaultCoverInput => ({ title: 'Signal In My Soul', artist: 'Echo Groove', slug: 'signal-in-my-soul', camelot: '6B', draft: false, analysis: an, ...o });

describe('Vault-cover (del 23 nivå 1)', () => {
  it('samme låt gir alltid samme cover', async () => {
    expect(vaultCoverSvg(input())).toBe(vaultCoverSvg(input()));
    const [a, b] = await Promise.all([renderVaultCover(input(), { size: 600 }), renderVaultCover(input(), { size: 600 })]);
    expect(a.equals(b)).toBe(true);
    const meta = await sharp(await renderVaultCover(input())).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([3000, 3000, 'png']);
  }, 30_000);

  it('farger fra Camelot-hjulet: naboer ligger nær hverandre, dur er lysere enn moll', () => {
    const h = (c: string) => camelotColors(c, 'x').hue;
    expect(Math.abs(h('7B') - h('6B'))).toBe(30);
    expect(h('6A')).toBe(h('6B'));
    expect(camelotColors('6A', 'x').minor).toBe(true);
    expect(camelotColors(null, 'a').known).toBe(false);
    expect(camelotColors(null, 'a').hue).toBe(camelotColors(null, 'a').hue);
    expect(vaultCoverSvg(input({ camelot: '6B' }))).not.toBe(vaultCoverSvg(input({ camelot: '6A' })));
  });

  it('paletten hentes fra det genererte coveret', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gv-vc-'));
    const f = path.join(dir, 'c.png');
    await writeFile(f, await renderVaultCover(input(), { size: 800 }));
    const p = await paletteFrom(f, { minContrast: 4.5 });
    expect(p.source).toBe('cover');
    expect(p.primary).toMatch(/^#[0-9A-F]{6}$/i);
  }, 30_000);

  it('umastrede låter og låter uten analyse får også cover', async () => {
    const buf = await renderVaultCover(input({ draft: true, analysis: null, camelot: null }), { size: 600 });
    expect((await sharp(buf).metadata()).width).toBe(600);
  });
});
