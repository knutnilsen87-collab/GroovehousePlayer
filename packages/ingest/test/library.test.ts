import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api';

let tmp: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-library-'));
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

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined || ['PUT', 'DELETE', 'POST'].includes(method) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

describe('favoritter (del 14)', () => {
  it('hjerte på og av, nyeste først, lagret i data/favorites.json', async () => {
    expect((await call('GET', '/api/favorites')).json.slugs).toEqual([]);
    await call('PUT', '/api/favorites/blue-fire');
    const r = await call('PUT', '/api/favorites/late-night');
    expect(r.json.slugs).toEqual(['late-night', 'blue-fire']);
    // Samme to ganger er trygt
    expect((await call('PUT', '/api/favorites/late-night')).json.slugs).toEqual(['late-night', 'blue-fire']);
    expect((await call('DELETE', '/api/favorites/blue-fire')).json.slugs).toEqual(['late-night']);
    expect(JSON.parse(await readFile(path.join(tmp, 'data', 'favorites.json'), 'utf8')).slugs).toEqual(['late-night']);
  });
  it('samtidige trykk mister ingenting', async () => {
    await Promise.all(['a-1', 'a-2', 'a-3', 'a-4', 'a-5'].map((s) => call('PUT', `/api/favorites/${s}`)));
    expect((await call('GET', '/api/favorites')).json.slugs).toHaveLength(6);
  });
  it('samme tilgangsregler som spillelistene: krever JSON, aldri fra /drop/, gyldig slug', async () => {
    const r = await fetch(`${base}/api/favorites/blue-fire`, { method: 'PUT' });
    expect(r.status).toBe(415);
    expect((await call('GET', '/api/favorites', undefined, { referer: 'http://x/drop/abc' })).status).toBe(403);
    expect((await call('PUT', '/api/favorites/Ugyldig_Slug')).status).toBe(400);
  });
});

describe('sangtekst (del 14)', () => {
  it('lagrer LRC, bytter til ren tekst (én fil per låt), tom tekst sletter', async () => {
    expect((await call('GET', '/api/lyrics/blue-fire')).status).toBe(404);
    const put = await call('PUT', '/api/lyrics/blue-fire', { format: 'lrc', text: '[00:01.00]Hei\r\n[00:02.00]Hå' });
    expect(put.json.lyrics).toMatchObject({ slug: 'blue-fire', format: 'lrc', text: '[00:01.00]Hei\n[00:02.00]Hå\n', meta: { source: 'manual', approved: true } });
    expect((await call('GET', '/api/lyrics/blue-fire')).json.format).toBe('lrc');
    await call('PUT', '/api/lyrics/blue-fire', { format: 'txt', text: 'Bare tekst' });
    expect(existsSync(path.join(tmp, 'data', 'lyrics', 'blue-fire.lrc'))).toBe(false);
    expect((await call('GET', '/api/lyrics/blue-fire')).json).toMatchObject({ slug: 'blue-fire', format: 'txt', text: 'Bare tekst\n', meta: { source: 'manual' } });
    expect((await call('PUT', '/api/lyrics/blue-fire', { format: 'txt', text: '   ' })).json.lyrics).toBeNull();
    expect((await call('GET', '/api/lyrics/blue-fire')).status).toBe(404);
    expect((await call('PUT', '/api/lyrics/blue-fire', { format: 'srt', text: 'x' })).status).toBe(400);
  });
});

describe('egne avspillinger (del 14)', () => {
  it('teller avspillinger og tid lyttet, nylig spilt nyeste først', async () => {
    expect((await call('POST', '/api/listens', { events: [{ slug: 'blue-fire', play: true }, { slug: 'blue-fire', ms: 15000 }] })).status).toBe(204);
    await call('POST', '/api/listens', { events: [{ slug: 'late-night', play: true, ms: 1000 }, { slug: 'x', ms: 10_000_000 }] });
    const log = (await call('GET', '/api/listens')).json;
    expect(log.bySlug['blue-fire']).toMatchObject({ plays: 1, ms: 15000 });
    expect(log.bySlug.x.ms).toBe(300_000); // maks 5 min per rapport
    expect(log.recent.map((r: { slug: string }) => r.slug)).toEqual(['late-night', 'blue-fire']);
    expect(Object.values(log.byDay).reduce((a: number, b) => a + (b as number), 0)).toBe(316_000);
    expect((await call('POST', '/api/listens', { events: 'nei' })).status).toBe(400);
  });
});
