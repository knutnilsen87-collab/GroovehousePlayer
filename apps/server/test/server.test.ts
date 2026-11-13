import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidatePorts, createHandler, listenWithFallback, probeHealth } from '../src/server';

let tmp: string;
let dist: string;
let media: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-server-'));
  dist = path.join(tmp, 'dist');
  media = path.join(tmp, 'media');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(media, 'song', 'main', 'v1', 'hls'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>GV</title>');
  await writeFile(path.join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
  await writeFile(path.join(media, 'index.json'), '{"schema":1,"assets":[]}');
  await writeFile(path.join(media, 'song', 'main', 'v1', 'hls', 'seg_00000.ts'), Buffer.from([0x47, 1, 2, 3]));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Ledig port fra OS-et, slik at testene ikke kolliderer med noe som kjører. */
async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}

async function start(distDir = dist) {
  const handler = createHandler({ distDir, mediaDir: media, version: '9.9.9' });
  const server = http.createServer(handler);
  const port = await freePort();
  const r = await listenWithFallback(server, [port]);
  if (r.kind !== 'listening') throw new Error('lytter ikke');
  handler.setPort(r.port);
  return { server, port: r.port };
}

function get(port: number, p: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
      })
      .on('error', reject);
  });
}

describe('server', () => {
  it('helse, SPA-fallback, statiske filer og media', async () => {
    const { server, port } = await start();
    try {
      const h = await get(port, '/api/health');
      expect(JSON.parse(h.body)).toMatchObject({ app: 'groovehouse-vault', version: '9.9.9', port, dist: true });
      for (const p of ['/', '/studio', '/drop/blue-fire-pitch?r=Test']) {
        const r = await get(port, p);
        expect(r.status, p).toBe(200);
        expect(r.body).toContain('<title>GV</title>');
      }
      expect((await get(port, '/assets/app-abc.js')).type).toMatch(/javascript/);
      expect((await get(port, '/assets/missing.js')).status).toBe(404);
      expect((await get(port, '/media/index.json')).type).toMatch(/application\/json/);
      expect((await get(port, '/media/song/main/v1/hls/seg_00000.ts')).type).toBe('video/mp2t');
      expect((await get(port, '/media/..%2F..%2Fdist%2Findex.html')).status).toBe(404);
      const escape = await get(port, '/..%2Fmedia%2Findex.json');
      expect(escape.status).toBe(404);
      expect(escape.body).not.toContain('schema');
    } finally {
      server.close();
    }
  });

  it('avviser fremmede Host-headere (DNS-rebinding)', async () => {
    const { server, port } = await start();
    try {
      expect((await get(port, '/media/index.json', 'evil.example:80')).status).toBe(421);
      expect((await get(port, '/', `localhost:${port}`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('sier tydelig fra når web-appen ikke er bygget', async () => {
    const { server, port } = await start(path.join(tmp, 'finnes-ikke'));
    try {
      const r = await get(port, '/');
      expect(r.status).toBe(503);
      expect(r.body).toContain('ikke bygget');
      expect(JSON.parse((await get(port, '/api/health')).body).dist).toBe(false);
    } finally {
      server.close();
    }
  });

  it('hopper over en port et annet program bruker, og starter ikke to instanser', async () => {
    const first = await freePort();
    const other = http.createServer((_q, s) => s.end('jeg er et annet program'));
    await new Promise<void>((r) => other.listen(first, '127.0.0.1', r));
    expect((await probeHealth(first)).state).toBe('other');

    const ports = [first, first + 1, first + 2];
    const handler = createHandler({ distDir: dist, mediaDir: media, version: '1' });
    const a = http.createServer(handler);
    const ra = await listenWithFallback(a, ports);
    try {
      expect(ra.kind).toBe('listening');
      if (ra.kind !== 'listening') return;
      expect(ra.port).not.toBe(first);
      expect(ra.skipped[0]).toMatchObject({ port: first });
      expect(ra.skipped[0]!.reason).toMatch(/annet program/);
      handler.setPort(ra.port);

      const b = http.createServer(createHandler({ distDir: dist, mediaDir: media, version: '1' }));
      const rb = await listenWithFallback(b, ports);
      expect(rb).toMatchObject({ kind: 'already-running', port: ra.port, pid: process.pid });
      expect(b.listening).toBe(false);
    } finally {
      a.close();
      other.close();
    }
  });

  it('reserveportene hopper over dev-porten', () => {
    const c = candidatePorts(41733, 41734);
    expect(c).toHaveLength(11);
    expect(c[0]).toBe(41733);
    expect(c).not.toContain(41734);
    expect(c.at(-1)).toBe(41744);
  });
});
