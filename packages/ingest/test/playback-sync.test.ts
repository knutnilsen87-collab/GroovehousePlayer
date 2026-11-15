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
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-playback-'));
  const api = createApiHandler({ mediaDir: path.join(tmp, 'media'), dataDir: path.join(tmp, 'data') });
  server = http.createServer((req, res) => void api(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

const point = {
  slug: 'live-sett-demo',
  variant: 'main',
  positionMs: 3_734_000,
  updatedAt: '2026-11-15T12:00:00.000Z',
  deviceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  deviceLabel: 'PC-en'
};

async function call(method: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + '/api/playback', {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json() };
}

describe('fortsett der du slapp', () => {
  it('mobilen ser posisjonen fra PC-en, og et eldre skriv vinner ikke', async () => {
    expect((await call('GET')).json.points).toEqual([]);
    const saved = await call('PUT', point);
    expect(saved.json.points[0].positionMs).toBe(3_734_000);
    const older = await call('PUT', { ...point, positionMs: 1000, updatedAt: '2026-11-15T11:00:00.000Z', deviceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', deviceLabel: 'Mobilen' });
    expect(older.json.points[0].positionMs).toBe(3_734_000);
    const claim = await call('PUT', { ...point, deviceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', deviceLabel: 'Mobilen', updatedAt: '2026-11-15T12:00:02.000Z', positionMs: 3_740_000, claim: true });
    expect(claim.json.claim.deviceId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect((await call('GET', undefined, { referer: 'http://x/drop/abc' })).status).toBe(403);
    expect((await call('PUT', { ...point, slug: '../x' })).status).toBe(400);
    const disk = await readFile(path.join(tmp, 'data', 'playback.json'), 'utf8');
    expect(disk).toContain('live-sett-demo');
  });
});
