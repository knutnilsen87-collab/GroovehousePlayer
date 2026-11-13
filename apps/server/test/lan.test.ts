import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credDelete, credRead, credWrite } from '../src/credstore';
import { hashPin, issueToken, LoginLimiter, newSecret, readCookie, verifyPin, verifyToken } from '../src/lan-auth';
import { isPrivateIPv4, safeNext } from '../src/lan';
import { createHandler } from '../src/server';

describe('PIN og informasjonskapsel', () => {
  it('PIN lagres bare som hash og verifiseres', () => {
    const rec = hashPin('482915');
    expect(JSON.stringify(rec)).not.toContain('482915');
    expect(verifyPin('482915', rec)).toBe(true);
    expect(verifyPin('482916', rec)).toBe(false);
    expect(() => hashPin('1234')).toThrow(/6–12/);
  });
  it('token varer i 30 dager, og endret token eller ny nøkkel avvises', () => {
    const secret = newSecret();
    const now = Date.UTC(2026, 10, 13);
    const t = issueToken(secret, 30, now);
    expect(t.maxAgeSec).toBe(30 * 86400);
    expect(verifyToken(secret, t.value, now + 29 * 86400_000)).toBe(true);
    expect(verifyToken(secret, t.value, now + 31 * 86400_000)).toBe(false);
    expect(verifyToken(newSecret(), t.value, now)).toBe(false);
    const parts = t.value.split('.');
    expect(verifyToken(secret, [parts[0], parts[1], String(Number(parts[2]) + 999999), parts[3]].join('.'), now)).toBe(false);
    expect(readCookie(`a=1; gv_lan=${t.value}; b=2`, 'gv_lan')).toBe(t.value);
  });
  it('begrenser gjetting', () => {
    const l = new LoginLimiter(5, 15 * 60_000, 20, 3600_000);
    for (let i = 0; i < 5; i++) l.fail('192.168.1.20', 1000);
    expect(l.blockedFor('192.168.1.20', 2000)).toBeGreaterThan(0);
    expect(l.blockedFor('192.168.1.21', 2000)).toBeNull();
    expect(l.blockedFor('192.168.1.20', 1000 + 15 * 60_000 + 1)).toBeNull();
  });
  it('bare private adresser og interne omdirigeringer', () => {
    expect(['10.0.0.5', '172.16.1.1', '172.31.9.9', '192.168.1.2'].every(isPrivateIPv4)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '127.0.0.1', '169.254.1.1'].some(isPrivateIPv4)).toBe(false);
    expect(safeNext('/studio?x=1')).toBe('/studio?x=1');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/lan/login']) expect(safeNext(bad)).toBe('/');
  });
});

describe('server i LAN-modus', () => {
  let tmp: string;
  let port: number;
  let server: http.Server;
  const lanIp = '192.168.77.10';
  const pin = '739104';

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-lan-'));
    const dist = path.join(tmp, 'dist');
    const media = path.join(tmp, 'media');
    await mkdir(path.join(dist, 'icons'), { recursive: true });
    await mkdir(media, { recursive: true });
    await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>GV</title>');
    await writeFile(path.join(dist, 'icons', 'icon-192.png'), 'png');
    await writeFile(path.join(media, 'index.json'), '{"schema":1,"assets":[]}');
    // Klienten later som den kommer fra nettverket (over loopback, så ingen brannmurdialog i testen).
    const handler = createHandler({
      distDir: dist,
      mediaDir: media,
      version: '1',
      lan: { pin: hashPin(pin), secret: newSecret(), ttlDays: 30 },
      isLocal: () => false,
      lanHosts: () => [lanIp],
      allowRemote: () => true
    });
    server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    handler.setPort(port);
  });
  afterAll(async () => {
    server.close();
    await rm(tmp, { recursive: true, force: true });
  });

  function req(method: string, p: string, opts: { host?: string; cookie?: string; body?: string } = {}) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method,
          headers: {
            host: opts.host ?? `${lanIp}:${port}`,
            ...(opts.cookie ? { cookie: opts.cookie } : {}),
            ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(opts.body) } : {})
          }
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        }
      );
      r.on('error', reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }

  it('uten PIN: bare innloggingssiden, ingen musikk', async () => {
    const page = await req('GET', '/studio');
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe('/lan/login?next=%2Fstudio');
    expect((await req('GET', '/media/index.json')).status).toBe(401);
    expect((await req('GET', '/api/health')).status).toBe(401);
    expect((await req('GET', '/icons/icon-192.png')).status).toBe(200);
    expect((await req('GET', '/lan/login')).body).toContain('PIN-kode');
    expect((await req('GET', '/', { host: `evil.example:${port}` })).status).toBe(421);
  });

  it('feil PIN avvises, riktig PIN gir httpOnly-informasjonskapsel i 30 dager', async () => {
    const wrong = await req('POST', '/lan/login', { body: 'pin=000000&next=%2Fstudio' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await req('POST', '/lan/login', { body: `pin=${pin}&next=%2Fstudio` });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/studio');
    const cookie = ok.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);

    const c = cookie.split(';')[0]!;
    expect((await req('GET', '/media/index.json', { cookie: c })).status).toBe(200);
    expect((await req('GET', '/studio', { cookie: c })).body).toContain('<title>GV</title>');
    const st = JSON.parse((await req('GET', '/api/lan/status', { cookie: c })).body) as { enabled: boolean; urls: string[]; qr: string };
    expect(st.enabled).toBe(true);
    expect(st.urls).toEqual([`http://${lanIp}:${port}/`]);
    expect(st.qr).toMatch(/^<svg/);
  });

  it('åpen omdirigering etter innlogging er ikke mulig', async () => {
    const ok = await req('POST', '/lan/login', { body: `pin=${pin}&next=${encodeURIComponent('//evil.example/')}` });
    expect(ok.headers.location).toBe('/');
  });
});

describe.skipIf(process.platform !== 'win32')('Credential Manager', () => {
  it('skriver, leser og sletter (egen testnøkkel)', () => {
    const prev = process.env.GV_CRED_PREFIX;
    process.env.GV_CRED_PREFIX = `GroovehouseVault-test-${process.pid}`;
    try {
      credWrite('probe', 'æøå-verdi 🎵');
      expect(credRead('probe')).toBe('æøå-verdi 🎵');
      expect(credDelete('probe')).toBe(true);
      expect(credRead('probe')).toBeNull();
    } finally {
      credDelete('probe');
      if (prev === undefined) delete process.env.GV_CRED_PREFIX;
      else process.env.GV_CRED_PREFIX = prev;
    }
  }, 30_000);
});
