import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyIncoming, createFingerprintStore, createHashCache, createSkippedStore, normTitle, stemReason } from '../src/incoming';
import { sha256File } from '../src/ingest';

/** Sanger som finnes i Vault fra før, importeres ikke på nytt. */
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gv-inc-'));
  const mediaDir = path.join(root, 'media');
  const dataDir = path.join(root, 'data');
  const src = path.join(root, 'eksport');
  await mkdir(src, { recursive: true });
  const existing = path.join(src, 'Blue Fire.wav');
  await writeFile(existing, Buffer.from('RIFF-lyd-blue-fire'));
  const dir = path.join(mediaDir, 'blue-fire', 'main', 'v1001');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ slug: 'blue-fire', variant: null, title: 'Blue Fire', durationMs: 200_000, masterSha256: await sha256File(existing) }));
  await writeFile(path.join(mediaDir, 'index.json'), JSON.stringify({ schema: 1, updatedAt: '', assets: [{ slug: 'blue-fire', variant: null, version: 1001, manifest: 'blue-fire/main/v1001/manifest.json', title: 'Blue Fire', kind: 'track' }] }));
  const ctx = { mediaDir, dataDir, hashes: createHashCache(dataDir), fingerprints: createFingerprintStore(dataDir) };
  return { root, src, existing, ctx, dataDir };
}
const f = (file: string, o: Partial<{ slug: string; title: string; durationMs: number }> = {}) => ({
  file,
  fileName: path.basename(file),
  slug: o.slug ?? 'x',
  variant: null,
  title: o.title ?? 'X',
  durationMs: o.durationMs ?? 123_000,
  status: 'draft' as const
});

describe('duplikatsjekk for overvåkede mapper', () => {
  it('kopi av en låt som finnes (samme lyd) hoppes over stille', async () => {
    const { src, existing, ctx } = await setup();
    const { copyFile } = await import('node:fs/promises');
    const copy = path.join(src, 'Blue Fire - kopi.wav');
    await copyFile(existing, copy);
    expect(await classifyIncoming(ctx, f(copy, { slug: 'blue-fire-kopi', title: 'Blue Fire Kopi' }))).toEqual({ action: 'known', slug: 'blue-fire-kopi' });
  });

  it('samme låt med nytt filnavn / ny eksport havner i lista med hvilken låt den ligner på', async () => {
    const { src, ctx, dataDir } = await setup();
    const renamed = path.join(src, '01. Blue Fire (final).wav');
    await writeFile(renamed, Buffer.from('ny eksport, annen lyd'));
    const v = await classifyIncoming(ctx, f(renamed, { slug: '01-blue-fire-final', title: '01. Blue Fire (final)' }));
    expect(v.action).toBe('listed');
    if (v.action !== 'listed') return;
    expect(v.item).toMatchObject({ matchSlug: 'blue-fire', matchTitle: 'Blue Fire', reason: 'samme-tittel' });
    const store = createSkippedStore(dataDir);
    expect(await store.add(v.item)).toBe(true);
    expect(await store.add({ ...v.item, id: 'annen' })).toBe(false); // samme fil legges ikke inn to ganger
    expect((await store.list()).length).toBe(1);
    expect((await store.take(v.item.id))?.fileName).toBe('01. Blue Fire (final).wav');
    expect(await store.list()).toEqual([]);
  });

  it('samme slug (ny bounce med samme navn) havner også i lista', async () => {
    const { src, ctx } = await setup();
    const again = path.join(src, 'Blue Fire v2.wav');
    await writeFile(again, Buffer.from('ny bounce'));
    const v = await classifyIncoming(ctx, f(again, { slug: 'blue-fire', title: 'Blue Fire' }));
    expect(v.action === 'listed' && v.item.reason).toBe('samme-slug');
  });

  it('ny låt importeres, og åpenbare stems hoppes over', async () => {
    const { src, ctx } = await setup();
    const nyLat = path.join(src, 'Helt Ny.wav');
    await writeFile(nyLat, Buffer.from('ny'));
    expect(await classifyIncoming(ctx, f(nyLat, { slug: 'helt-ny', title: 'Helt Ny' }))).toEqual({ action: 'import' });
    const stem = path.join(src, 'Helt Ny (Vocals).wav');
    await writeFile(stem, Buffer.from('stem'));
    expect((await classifyIncoming(ctx, f(stem, { slug: 'helt-ny-vocals', title: 'Helt Ny Vocals' }))).action).toBe('stem');
  });

  it('kjenner igjen stems uten å ta låttitler som «Bass Don’t Lie»', () => {
    expect(stemReason('Song - Vocals.wav')).toMatch(/stem/);
    expect(stemReason('Song (Acapella).wav')).toMatch(/stem/);
    expect(stemReason('Song_STEMS.wav')).toMatch(/stem/);
    expect(stemReason('Bass Don’t Lie.mp3')).toBeNull();
    expect(stemReason('Bass Don\'t Lie (Bass Only).wav')).toMatch(/stem/);
    expect(stemReason('Song (Instrumental).wav')).toBeNull();
    expect(stemReason('Dark Little Groove.wav')).toBeNull();
    expect(stemReason('Deep Bass.wav')).toBeNull();
    expect(stemReason('Song (Vocals).wav')).toMatch(/stem/);
  });

  it('tittel renses før sammenligning', () => {
    expect(normTitle('01. Blue Fire (final)')).toBe('blue fire');
    expect(normTitle('Blue Fire v2')).toBe('blue fire');
    expect(normTitle('Dub You Down (1)')).toBe('dub you down');
  });
});
