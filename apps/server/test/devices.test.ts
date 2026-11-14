import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeviceStore } from '../src/devices';
import { hashPin, newSecret } from '../src/lan-auth';
import { createHandler } from '../src/server';

describe('enheter (Android-appen): paring, token og CORS', () => {
  let tmp: string;
  const servers: http.Server[] = [];
  let lanBase = '';
  let localBase = '';
  const lanIp = '192.168.77.10';
  const ts = 'pc.tail1234.ts.net';
  const pin = '739104';

  const listen = async (handler: ReturnType<typeof createHandler>) => {
    const s = http.createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    handler.setPort((s.address() as AddressInfo).port);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-devices-'));
    const dist = path.join(tmp, 'dist');
    const media = path.join(tmp, 'media');
    await mkdir(dist, { recursive: true });
    await mkdir(media, { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>GV</title>');
    await writeFile(path.join(media, 'index.json'), '{"schema":1,"assets":[]}');
    const devices = createDeviceStore(path.join(tmp, 'data', 'devices.json'));
    const common = { distDir: dist, mediaDir: media, version: '1', devices, pairPin: () => hashPin(pin), allowedHosts: [ts] };
    // «LAN»: klienten kommer fra nettverket, Wi-Fi-modus på, ingen PIN-cookie.
    lanBase = await listen(createHandler({ ...common, lan: { pin: hashPin(pin), secret: newSecret(), ttlDays: 30 }, isLocal: () => false, lanHosts: () => [lanIp], allowRemote: () => true }));
    // «Loopback»: PC-en selv eller Tailscale Serve (vertsnavn i allowedHosts + Tailscale-User-Login).
    localBase = await listen(createHandler({ ...common, isLocal: () => true }));
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    await rm(tmp, { recursive: true, force: true });
  });

  /** http.request (ikke fetch): fetch ignorerer Host-headeren, og den er hele poenget her. */
  const call = (b: string, method: string, p: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<{ status: number; headers: { get: (k: string) => string | null }; json: () => Promise<unknown> }>((resolve, reject) => {
      const u = new URL(b + p);
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const r = http.request(
        { host: u.hostname, port: u.port, path: u.pathname, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: { get: (k) => (res.headers[k.toLowerCase()] as string | undefined) ?? null }, json: async () => JSON.parse(text) })
          );
        }
      );
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  const viaTs = (method: string, p: string, headers: Record<string, string> = {}, body?: unknown) => call(localBase, method, p, { host: ts, 'tailscale-user-login': 'knut@example.com', ...headers }, body);
  const viaLan = (method: string, p: string, headers: Record<string, string> = {}) => call(lanBase, method, p, { host: lanIp, ...headers });

  let token = '';
  let deviceId = '';

  it('paring krever riktig PIN, og tokenet lagres bare som hash', async () => {
    expect((await viaTs('POST', '/api/devices/pair', {}, { pin: '000000', name: 'S22' })).status).toBe(401);
    const ok = await viaTs('POST', '/api/devices/pair', {}, { pin, name: 'Knuts S22' });
    expect(ok.status).toBe(201);
    const j = (await ok.json()) as { token: string; device: { id: string; name: string } };
    token = j.token;
    deviceId = j.device.id;
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(j.device.name).toBe('Knuts S22');
    const stored = await readFile(path.join(tmp, 'data', 'devices.json'), 'utf8');
    expect(stored).not.toContain(token);
    const list = (await (await viaTs('GET', '/api/devices')).json()) as { devices: Array<Record<string, unknown>> };
    expect(list.devices).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.devices[0]).not.toHaveProperty('tokenSha256');
  });

  it('tokenet gir tilgang til API og media uten PIN-cookie; ugyldig token → 401', async () => {
    expect((await viaLan('GET', '/media/index.json')).status).toBe(401);
    expect((await viaLan('GET', '/media/index.json', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await viaLan('GET', '/media/index.json', { authorization: 'Bearer ' + 'x'.repeat(43) })).status).toBe(401);
    // Via Tailscale holder identiteten alene, men et ugyldig token sier fra (appen må pares på nytt)
    expect((await viaTs('GET', '/media/index.json')).status).toBe(200);
    expect((await viaTs('GET', '/media/index.json', { authorization: 'Bearer ' + 'y'.repeat(43) })).status).toBe(401);
    // Tailscale-navnet uten identitet slipper bare inn med gyldig token
    expect((await call(localBase, 'GET', '/media/index.json', { host: ts })).status).toBe(403);
    expect((await call(localBase, 'GET', '/media/index.json', { host: ts, authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('CORS bare for appens opprinnelse https://localhost', async () => {
    const pre = await viaTs('OPTIONS', '/api/playlists', { origin: 'https://localhost', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization');
    const evil = await viaTs('GET', '/media/index.json', { origin: 'https://evil.example' });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const app = await viaTs('GET', '/media/index.json', { origin: 'https://localhost', authorization: `Bearer ${token}` });
    expect(app.status).toBe(200);
    expect(app.headers.get('access-control-allow-origin')).toBe('https://localhost');
    // Ikke for vanlige sider
    expect((await viaTs('GET', '/', { origin: 'https://localhost' })).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('tilbaketrukket enhet mister tilgang; gjetting av PIN begrenses', async () => {
    expect((await viaTs('DELETE', `/api/devices/${deviceId}`, {}, {})).status).toBe(200);
    expect((await viaLan('GET', '/media/index.json', { authorization: `Bearer ${token}` })).status).toBe(401);
    const list = (await (await viaTs('GET', '/api/devices')).json()) as { devices: Array<{ revokedAt: string | null }> };
    expect(list.devices[0]!.revokedAt).not.toBeNull();
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call(localBase, 'POST', '/api/devices/pair', { host: ts, 'tailscale-user-login': 'gjetter@example.com' }, { pin: '111111' })).status;
    expect(last).toBe(429);
  });
});
