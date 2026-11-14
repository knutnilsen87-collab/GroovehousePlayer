import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeviceStore } from '../src/devices';
import { hashPin } from '../src/lan-auth';
import { createHandler } from '../src/server';
// @ts-expect-error – ren JS-modul
import { makeBundle, readManifest, writeManifest } from '../../android/scripts/bundle.mjs';

let tmp: string;
let base = '';
let server: http.Server;
let token = '';
const ts = 'pc.tail1234.ts.net';
const pin = '739104';

const call = (method: string, p: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Promise<{ status: number; body: Buffer; type: string }>((resolve, reject) => {
    const u = new URL(base + p);
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method, headers: { host: ts, 'tailscale-user-login': 'knut@example.com', ...(data ? { 'content-type': 'application/json' } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? '') }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-appupd-'));
  const dist = path.join(tmp, 'dist');
  const media = path.join(tmp, 'media');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(media, { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>GV</title>');
  await writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("v1")');
  await writeFile(path.join(media, 'index.json'), '{"schema":1,"assets":[]}');
  const devices = createDeviceStore(path.join(tmp, 'data', 'devices.json'));
  const handler = createHandler({ distDir: dist, mediaDir: media, version: '1', devices, pairPin: () => hashPin(pin), allowedHosts: [ts], isLocal: () => true });
  server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  handler.setPort((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = JSON.parse((await call('POST', '/api/devices/pair', {}, { pin, name: 'S22' })).body.toString()).token;
});
afterAll(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('web-bunten (del 15)', () => {
  it('zip med alle filer og gv-bundle.json; uendret innhold gir ingen ny versjon; native-endring hever minNative', async () => {
    const dist = path.join(tmp, 'dist');
    const appDir = path.join(tmp, 'data', 'app');
    const log = () => {};
    const b1 = makeBundle({ now: new Date('2026-11-14T10:00:00Z'), log, dist, appDir, native: () => 'n1' });
    expect(b1.version).toBe(20261114100000);
    expect(b1.minNative).toBe(1); // ingen APK publisert ennå
    const zip = await readFile(path.join(appDir, 'bundle', b1.file));
    expect(createHash('sha256').update(zip).digest('hex')).toBe(b1.sha256);
    // Pakk ut med Windows' egen tar (bsdtar leser zip) og sjekk innholdet
    const out = path.join(tmp, 'unzip');
    await mkdir(out, { recursive: true });
    expect(spawnSync(process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', path.join(appDir, 'bundle', b1.file), '-C', out]).status).toBe(0);
    expect(await readFile(path.join(out, 'assets', 'app.js'), 'utf8')).toBe('console.log("v1")');
    expect(JSON.parse(await readFile(path.join(out, 'gv-bundle.json'), 'utf8')).version).toBe(b1.version);

    const same = makeBundle({ now: new Date('2026-11-14T11:00:00Z'), log, dist, appDir, native: () => 'n1' });
    expect(same.version).toBe(b1.version);

    // APK publisert med native n1 → minNative = dens versionCode; native endret → én over
    const m = readManifest(appDir);
    m.apk = { versionCode: 60, versionName: '0.1.0', sha256: 'x', size: 1, notes: '', file: 'groovehouse-vault-60.apk', nativeHash: 'n1', builtAt: '' };
    writeManifest(m, appDir);
    expect(makeBundle({ log, dist, appDir, native: () => 'n1' }).minNative).toBe(60);
    expect(makeBundle({ log, dist, appDir, native: () => 'n2' }).minNative).toBe(61);

    await writeFile(path.join(dist, 'assets', 'app.js'), 'console.log("v2")');
    const b2 = makeBundle({ now: new Date('2026-11-14T10:00:00Z'), log, dist, appDir, native: () => 'n1' });
    expect(b2.version).toBeGreaterThan(b1.version); // aldri lavere, selv med samme klokkeslett
  });
});

describe('/api/app (del 15)', () => {
  it('krever paret app med token, aldri fra /drop/', async () => {
    expect((await call('GET', '/api/app/bundle')).status).toBe(401);
    expect((await call('GET', '/api/app/apk/latest')).status).toBe(401);
    const auth = { authorization: `Bearer ${token}` };
    const b = await call('GET', '/api/app/bundle', auth);
    expect(b.status).toBe(200);
    const info = JSON.parse(b.body.toString());
    expect(Object.keys(info).sort()).toEqual(['minNative', 'sha256', 'size', 'version']);
    const zip = await call('GET', `/api/app/bundle/${info.version}.zip`, auth);
    expect(zip.status).toBe(200);
    expect(createHash('sha256').update(zip.body).digest('hex')).toBe(info.sha256);
    expect((await call('GET', '/api/app/bundle', { ...auth, referer: `${base}/drop/x` })).status).toBe(403);
    expect((await call('GET', '/api/app/bundle/..%2F..%2Fdevices.zip', auth)).status).toBe(404);
  });
  it('APK: siste versjon og fila; appen melder versjon (vises i Studio)', async () => {
    const auth = { authorization: `Bearer ${token}` };
    await mkdir(path.join(tmp, 'data', 'app', 'apk'), { recursive: true });
    await writeFile(path.join(tmp, 'data', 'app', 'apk', 'groovehouse-vault-60.apk'), 'APK');
    const latest = JSON.parse((await call('GET', '/api/app/apk/latest', auth)).body.toString());
    expect(latest).toMatchObject({ versionCode: 60, versionName: '0.1.0' });
    expect(latest).not.toHaveProperty('nativeHash');
    const f = await call('GET', '/api/app/apk/groovehouse-vault-60.apk', auth);
    expect(f.status).toBe(200);
    expect(f.type).toBe('application/vnd.android.package-archive');
    await call('GET', '/media/index.json', { ...auth, 'x-gv-app': '58', 'x-gv-bundle': '20261114100000' });
    await new Promise((r) => setTimeout(r, 100));
    const list = JSON.parse((await call('GET', '/api/devices')).body.toString());
    expect(list.devices[0].client).toMatchObject({ versionCode: 58, bundle: 20261114100000 });
  });
});
