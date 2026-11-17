import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-album-'));
  const api = createApiHandler({ mediaDir: path.join(tmp, 'media'), dataDir: path.join(tmp, 'data') });
  server = http.createServer((req, res) => void api(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('/api/album (del 26: «Utelat disse låtene» og «Singel-kandidat»)', () => {
  it('tomt fra start, lagrer slugs i data/album.json, og ett felt kan endres alene', async () => {
    expect(await (await fetch(base + '/api/album')).json()).toEqual({ exclude: [], singles: [] });
    const put = (body: unknown) => fetch(base + '/api/album', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await put({ exclude: ['music-in-my-soul', 'music-in-my-soul', 'IKKE GYLDIG'], singles: ['oh-no'] })).toEqual({ exclude: ['music-in-my-soul'], singles: ['oh-no'] });
    expect(await put({ singles: [] })).toEqual({ exclude: ['music-in-my-soul'], singles: [] });
    expect(JSON.parse(await readFile(path.join(tmp, 'data', 'album.json'), 'utf8')).exclude).toEqual(['music-in-my-soul']);
  });
  it('ikke fra en delt drop-side', async () => {
    expect((await fetch(base + '/api/album', { headers: { referer: 'http://x/drop/abc' } })).status).toBe(403);
  });
});
