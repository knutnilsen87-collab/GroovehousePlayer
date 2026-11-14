import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveEntries, smartListAssets, type Playlist } from '@gv/shared';
import { createApiHandler } from '../src/api';
import { updateCatalog } from '../src/ingest';

let tmp: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-playlists-'));
  await mkdir(path.join(tmp, 'media'), { recursive: true });
  const api = createApiHandler({ mediaDir: path.join(tmp, 'media'), dataDir: path.join(tmp, 'data') });
  server = http.createServer((req, res) => void api(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown, type = 'application/json') {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': type } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, json: (text ? JSON.parse(text) : null) as { playlist: Playlist; playlists: Playlist[]; error: string } };
}

describe('API for spillelister', () => {
  it('oppretter, legger til, flytter og fjerner – og avviser utdaterte endringer med 409', async () => {
    expect((await call('GET', '/api/playlists')).json.playlists).toEqual([]);

    const created = await call('POST', '/api/playlists', { name: '  Club   Ready ', entries: [{ slug: 'eyes-on-you' }] });
    expect(created.status).toBe(201);
    let p = created.json.playlist;
    expect(p).toMatchObject({ name: 'Club Ready', kind: 'manual', query: null });
    expect(p.entries).toHaveLength(1);
    expect(p.usedAt).toBe(p.updatedAt);

    // Legg til to (én låst til Extended)
    let r = await call('PATCH', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt, add: [{ slug: 'feel-good' }, { slug: 'blue-fire', variant: 'extended' }] });
    expect(r.status).toBe(200);
    const stale = p.updatedAt;
    p = r.json.playlist;
    expect(p.entries.map((e) => [e.slug, e.variant])).toEqual([
      ['eyes-on-you', null],
      ['feel-good', null],
      ['blue-fire', 'extended']
    ]);
    expect(p.updatedAt > stale).toBe(true);

    // En annen enhet med gammel updatedAt får 409 og gjeldende liste tilbake – ingen stille overskriving
    const conflict = await call('PATCH', `/api/playlists/${p.id}`, { updatedAt: stale, name: 'Overskrevet' });
    expect(conflict.status).toBe(409);
    expect(conflict.json.playlist.name).toBe('Club Ready');
    expect(conflict.json.playlist.updatedAt).toBe(p.updatedAt);

    // Flytt siste først, og fjern den midterste (oppføringene beholder id)
    const [a, b, c] = p.entries;
    r = await call('PATCH', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt, entries: [c, a] });
    p = r.json.playlist;
    expect(p.entries.map((e) => e.id)).toEqual([c!.id, a!.id]);
    expect(p.entries[0]!.addedAt).toBe(c!.addedAt);
    expect(p.entries.find((e) => e.id === b!.id)).toBeUndefined();

    r = await call('PATCH', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt, name: 'Varm opp' });
    p = r.json.playlist;
    expect(p.name).toBe('Varm opp');

    // Lagret på disk, med backup av forrige versjon
    const file = path.join(tmp, 'data', 'playlists.json');
    expect(JSON.parse(await readFile(file, 'utf8')).playlists[0].name).toBe('Varm opp');
    expect(existsSync(path.join(tmp, 'data', 'playlists.backup.json'))).toBe(true);

    expect((await call('DELETE', `/api/playlists/${p.id}`, { updatedAt: stale })).status).toBe(409);
    expect((await call('DELETE', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt })).status).toBe(204);
    expect((await call('GET', '/api/playlists')).json.playlists).toEqual([]);
  });

  it('validerer input og krever JSON', async () => {
    expect((await call('POST', '/api/playlists', { name: '' })).status).toBe(400);
    expect((await call('POST', '/api/playlists', { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await call('POST', '/api/playlists', { name: 'A', entries: [{ slug: '../etc' }] })).status).toBe(400);
    expect((await call('POST', '/api/playlists', { name: 'A', entries: [{ slug: 'ok', variant: 'Ikke OK' }] })).status).toBe(400);
    expect((await call('POST', '/api/playlists', { name: 'A' }, 'text/plain')).status).toBe(415);
    expect((await call('PATCH', '/api/playlists/finnes-ikke', { updatedAt: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/api/playlists/..%2F..', { updatedAt: 'x' })).status).toBe(404);
  });

  it('smarte lister lagrer søket og kan ikke fylles manuelt', async () => {
    const r = await call('POST', '/api/playlists', { name: 'Peak', kind: 'smart', query: '124 8A', entries: [{ slug: 'x' }] });
    expect(r.status).toBe(201);
    const p = r.json.playlist;
    expect(p).toMatchObject({ kind: 'smart', query: '124 8A', entries: [] });
    expect((await call('PATCH', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt, add: [{ slug: 'x' }] })).status).toBe(400);
    expect((await call('POST', '/api/playlists', { name: 'Tom', kind: 'smart', query: ' ' })).status).toBe(400);
  });

  it('samtidige tillegg fra to enheter: den andre får 409, laster på nytt og lykkes', async () => {
    const p = (await call('POST', '/api/playlists', { name: 'Samtidig' })).json.playlist;
    const [x, y] = await Promise.all([
      call('PATCH', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt, add: [{ slug: 'a' }] }),
      call('PATCH', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt, add: [{ slug: 'b' }] })
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    const retry = await call('PATCH', `/api/playlists/${p.id}`, { updatedAt: loser.json.playlist.updatedAt, add: [{ slug: x.status === 409 ? 'a' : 'b' }] });
    expect(retry.status).toBe(200);
    expect(retry.json.playlist.entries.map((e) => e.slug).sort()).toEqual(['a', 'b']);
  });
});

describe('oppslag mot katalogen', () => {
  const asset = (slug: string, variant: string | null, version: number, extra: Partial<{ bpm: number; kind: string; createdAt: string; camelot: string }> = {}) => ({
    manifest: {
      id: `${slug}-${variant ?? 'main'}-v${version}`,
      slug,
      variant,
      version,
      title: slug.replace(/-/g, ' '),
      variantLabel: variant ? 'Extended' : null,
      kind: extra.kind ?? 'track',
      bpm: extra.bpm ?? 124,
      key: { camelot: extra.camelot ?? '8A', name: 'A minor' },
      createdAt: extra.createdAt ?? '2026-10-15T12:00:00Z',
      durationMs: 180_000
    }
  });
  const track = (main: ReturnType<typeof asset>, ...variants: Array<ReturnType<typeof asset>>) => ({ slug: main.manifest.slug, main, variants: [main, ...variants] });
  const entries = [
    { id: '1', slug: 'blue-fire', variant: null, version: null, addedAt: '' },
    { id: '2', slug: 'blue-fire', variant: 'extended', version: null, addedAt: '' },
    { id: '3', slug: 'borte', variant: null, version: null, addedAt: '' },
    { id: '4', slug: 'feel-good', variant: 'extended', version: null, addedAt: '' },
    { id: '5', slug: 'blue-fire', variant: null, version: 1, addedAt: '' },
  ];

  it('ny versjon av en låt dukker opp i eksisterende lister, låst variant brukes, ellers hovedvarianten', () => {
    // Katalogen (useCatalog) har bare nyeste versjon per slug + variant.
    const v2 = [track(asset('blue-fire', null, 2), asset('blue-fire', 'extended', 1)), track(asset('feel-good', null, 1))];
    const ids = (rows: Array<{ asset: { manifest: { id: string } } | null; reason: string | null }>) => rows.map((r) => r.asset?.manifest.id ?? `UTILGJENGELIG: ${r.reason}`);
    expect(ids(resolveEntries(entries, v2))).toEqual(['blue-fire-main-v2', 'blue-fire-extended-v1', 'UTILGJENGELIG: Låta finnes ikke lenger i hvelvet', 'feel-good-main-v1', 'UTILGJENGELIG: Versjon 1 finnes ikke lenger i media/']);
    const v4 = [track(asset('blue-fire', null, 4), asset('blue-fire', 'extended', 4)), track(asset('feel-good', null, 1))];
    // Låst versjon (v1) finnes fortsatt i media/: den brukes, selv om nyeste er v4.
    const old = asset('blue-fire', null, 1);
    const find = (slug: string, variant: string | null, version: number) => (slug === 'blue-fire' && variant === null && version === 1 ? old : undefined);
    expect(ids(resolveEntries(entries, v4, find))).toEqual(['blue-fire-main-v4', 'blue-fire-extended-v4', 'UTILGJENGELIG: Låta finnes ikke lenger i hvelvet', 'feel-good-main-v1', 'blue-fire-main-v1']);
  });

  it('smarte lister gir samme treff som søket', () => {
    const tracks = [
      track(asset('peak', null, 1, { bpm: 124, camelot: '8A', createdAt: '2026-11-12T00:00:00Z' })),
      track(asset('slow', null, 1, { bpm: 118, camelot: '8A', createdAt: '2026-10-01T00:00:00Z' })),
      track(asset('live-1', null, 1, { kind: 'set', bpm: 125, camelot: '5A' })),
      track(asset('demo', null, 1, { bpm: 128, camelot: '9B' }), asset('demo', 'extended', 1, { bpm: 124, camelot: '8A' }))
    ];
    const slugs = (q: object) => smartListAssets(tracks, q, Date.parse('2026-11-13T00:00:00Z')).map((a) => `${a.manifest.slug}:${a.manifest.variant ?? 'main'}`);
    expect(slugs({ query: '124 8A' })).toEqual(['peak:main', 'demo:extended']);
    expect(slugs({ query: 'sett' })).toEqual(['live-1:main']);
    expect(slugs({ query: 'extended' })).toEqual(['demo:extended']);
    expect(slugs({ days: 14 })).toEqual(['peak:main']);
    expect(slugs({ query: '  ' })).toEqual([]);
  });
});

describe('farger på lister', () => {
  it('ny liste får en ledig farge fra paletten, og fargen kan endres men bare til en kjent farge', async () => {
    const { PLAYLIST_COLORS } = await import('@gv/shared');
    const ids = PLAYLIST_COLORS.map((c) => c.id);
    const a = (await call('POST', '/api/playlists', { name: 'Farge A' })).json.playlist;
    const b = (await call('POST', '/api/playlists', { name: 'Farge B' })).json.playlist;
    expect(ids).toContain(a.color);
    expect(ids).toContain(b.color);
    expect(a.color).not.toBe(b.color);
    expect(a.cover).toBeNull();
    expect((await call('PATCH', `/api/playlists/${a.id}`, { updatedAt: a.updatedAt, color: '#F0C030' })).status).toBe(400);
    const r = await call('PATCH', `/api/playlists/${a.id}`, { updatedAt: a.updatedAt, color: ids[5] });
    expect(r.status).toBe(200);
    expect(r.json.playlist.color).toBe(ids[5]);
    expect((await call('POST', '/api/playlists', { name: 'Ugyldig', color: 'gull' })).status).toBe(400);
  });
});

describe('eget cover (pkt. 14)', () => {
  it('lagres uten EXIF, med thumb og palett; utdatert enhet får 409; fjernes ryddig', async () => {
    let p = (await call('POST', '/api/playlists', { name: 'Med cover' })).json.playlist;
    // Rødt testbilde med EXIF (inkl. «GPS»-tekst) som ikke skal bli med videre.
    const img = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 220, g: 40, b: 60 } } })
      .withExif({ IFD0: { Copyright: 'HEMMELIG GPS 59.91N', Artist: 'Kamera' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(img).metadata()).exif).toBeDefined();
    const put = (body: Buffer, updatedAt: string, type = 'image/jpeg') => fetch(`${base}/api/playlists/${p.id}/cover?updatedAt=${encodeURIComponent(updatedAt)}`, { method: 'PUT', headers: { 'content-type': type }, body: new Uint8Array(body) });

    expect((await put(Buffer.from('ikke et bilde'), p.updatedAt)).status).toBe(400);
    expect((await put(img, p.updatedAt, 'text/plain')).status).toBe(415);

    const r = await put(img, p.updatedAt);
    expect(r.status).toBe(200);
    const stale = p.updatedAt;
    p = ((await r.json()) as { playlist: Playlist }).playlist;
    expect(p.cover).toMatch(/\.jpg$/);
    expect(p.coverPalette?.source).toBe('cover');
    const dir = path.join(tmp, 'data', 'playlist-covers');
    const big = path.join(dir, p.cover!);
    const thumb = path.join(dir, p.cover!.replace(/\.jpg$/, '_300.jpg'));
    const meta = await sharp(big).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1200]);
    expect(meta.exif).toBeUndefined();
    expect((await readFile(big)).includes(Buffer.from('HEMMELIG'))).toBe(false);
    expect((await sharp(thumb).metadata()).width).toBe(300);

    const served = await fetch(`${base}/api/playlist-covers/${p.cover}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect((await fetch(`${base}/api/playlist-covers/..%2Fplaylists.json`)).status).toBe(404);

    // Utdatert enhet: 409, og ingen nye filer blir liggende igjen
    const before = (await import('node:fs/promises')).readdir(dir);
    expect((await put(img, stale)).status).toBe(409);
    expect((await (await import('node:fs/promises')).readdir(dir)).length).toBe((await before).length);

    // Nytt cover erstatter det gamle (gamle filer slettes)
    const old = p.cover!;
    p = ((await (await put(img, p.updatedAt)).json()) as { playlist: Playlist }).playlist;
    expect(p.cover).not.toBe(old);
    expect(existsSync(path.join(dir, old))).toBe(false);

    // Fjern cover → mosaikk, og filene er borte
    const del = await call('DELETE', `/api/playlists/${p.id}/cover`, { updatedAt: p.updatedAt });
    expect(del.status).toBe(200);
    expect(del.json.playlist.cover).toBeNull();
    expect(existsSync(path.join(dir, p.cover!))).toBe(false);

    // Slett lista → coverfilene ryddes
    p = del.json.playlist;
    p = ((await (await put(img, p.updatedAt)).json()) as { playlist: Playlist }).playlist;
    expect((await call('DELETE', `/api/playlists/${p.id}`, { updatedAt: p.updatedAt })).status).toBe(204);
    expect(existsSync(path.join(dir, p.cover!))).toBe(false);
  }, 20_000); // flere ekte bildebehandlinger med sharp – tar tid når maskinen er opptatt
});

describe('eldre versjoner blir liggende (pkt. 13)', () => {
  it('ny versjon i indeksen fjerner ikke den forrige', async () => {
    const media = path.join(tmp, 'media-versjoner');
    await mkdir(media, { recursive: true });
    const m = (version: number) => ({ slug: 'demo', variant: null, version, title: 'Demo', kind: 'track' }) as never;
    await updateCatalog(media, m(3));
    await updateCatalog(media, m(4));
    await updateCatalog(media, m(4)); // samme versjon på nytt (--force) erstatter bare seg selv
    const idx = JSON.parse(await readFile(path.join(media, 'index.json'), 'utf8')) as { assets: Array<{ version: number; manifest: string }> };
    expect(idx.assets.map((a) => a.version)).toEqual([4, 3]);
    expect(idx.assets[1]!.manifest).toBe('demo/main/v3/manifest.json');
  });
});
