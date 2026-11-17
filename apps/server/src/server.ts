import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ID, createApiHandler, isFromDrop, shareBlockReason, shareFileFor } from '@gv/ingest/api';
import { createSettingsRoute, type SettingsHooks } from './settings-route';
import { createMediaHandler } from '@gv/ingest/media-static';
import { appUpdateRoute } from './app-update';
import { COOKIE_NAME, issueToken, LoginLimiter, readCookie, verifyPin, verifyToken, type PinRecord } from './lan-auth';
import { isLoopback, isPrivateIPv4, lanAddresses, loginPage, networkCategories, qrSvg, remoteIPv4, safeNext } from './lan';
import { APP_ORIGIN, bearerOf, type DeviceStore } from './devices';

/**
 * Én HTTP-server: bygget web-app (SPA-fallback), /media/... og /api/...
 * Samme media- og API-moduler som Vite bruker i dev. Lytter på 127.0.0.1, og i LAN-modus
 * også på nettverket – da kreves PIN for alt som ikke kommer fra PC-en selv.
 */
export interface ServerOptions {
  distDir: string;
  mediaDir: string;
  version: string;
  log?: (line: string) => void;
  /** LAN-modus: PIN-hash og signeringsnøkkel. null = bare 127.0.0.1. */
  lan?: LanOptions | null;
  /**
   * Eksakte vertsnavn som godtas fra loopback i tillegg til 127.0.0.1/localhost (Tailscale Serve).
   * Krever Tailscale-User-Login-headeren, og gir tilgang uten PIN. Ingen jokertegn.
  allowedHosts?: string[];
  /** Tilkoblede enheter (Android-appen): enhetstoken som alternativ til Tailscale-identitet/LAN-cookie. */
  devices?: DeviceStore;
  /** PIN-hashen paring sjekkes mot (samme som Wi-Fi-modus), også når Wi-Fi-modus er av. */
  pairPin?: () => PinRecord | null;
  allowedHosts?: string[];
  /** Del 8: innstillinger i Studio (watcher, omstart). Uten: /api/settings svarer 404. */
  settings?: SettingsHooks;
  /** Testkrok: er klienten PC-en selv? Standard: loopback-adresse på socketen. */
  isLocal?: (remoteAddress: string | undefined) => boolean;
  /** Testkrok: PC-ens LAN-adresser. */
  lanHosts?: () => string[];
  /** Testkrok: får denne klientadressen slippe inn fra nettverket? Standard: privat IPv4 (RFC 1918). */
  allowRemote?: (ip: string) => boolean;
}

export interface LanOptions {
  pin: PinRecord;
  secret: string;
  ttlDays: number;
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

export function createHandler(opts: ServerOptions) {
  const dist = path.resolve(opts.distDir);
  const api = createApiHandler({ mediaDir: opts.mediaDir });
  const media = createMediaHandler(opts.mediaDir);
  const settingsRoute = opts.settings ? createSettingsRoute(opts.settings) : null;
  const isLocal = opts.isLocal ?? isLoopback;
  const lanHosts = opts.lanHosts ?? lanAddresses;
  const allowedHosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase().replace(/\.$/, ''));
  const appUpdate = appUpdateRoute(path.join(path.resolve(opts.mediaDir, '..'), 'data'));
  const limiter = new LoginLimiter();
  let port = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const local = isLocal(req.socket.remoteAddress);
      const hostName = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const apiOrMedia = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/');

      // Android-appen (del 12) kjører på https://localhost og henter fra Vault over Tailscale.
      // CORS gis bare til den opprinnelsen, og bare for API og media.
      const cors = req.headers.origin === APP_ORIGIN && apiOrMedia;
      if (cors) {
        res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match, X-GV-App, X-GV-Bundle, X-GV-Import');
        res.setHeader('Access-Control-Expose-Headers', 'ETag');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, PUT, DELETE');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      // Enhetstoken (appen): et gyldig token gir tilgang. Er det med, men ugyldig/trukket tilbake → 401,
      // så appen vet at den må kobles til på nytt.
      const hasAuth = req.headers.authorization !== undefined;
      const device = hasAuth && opts.devices ? await opts.devices.verify(bearerOf(req.headers.authorization)) : null;
      if (hasAuth && !device && apiOrMedia && req.method !== 'OPTIONS') {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ error: 'Enheten er ikke godkjent (lenger). Koble til Vault på nytt.' }));
      }
      // Del 15: appen melder sin APK- og bunt-versjon (vises under Studio → Innstillinger → Enheter)
      if (device && opts.devices && req.headers['x-gv-app']) {
        void opts.devices.noteClient(device.id, String(req.headers['x-gv-app']), String(req.headers['x-gv-bundle'] ?? '')).catch(() => {});
      }

      if (local) {
        // Bare forespørsler til vår egen adresse. Hindrer DNS-rebinding: en nettside som peker
        // sitt eget domene mot 127.0.0.1 kan ellers lese uutgitt musikk fra serveren.
        if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostName)) {
          // Unntak: eksakte vertsnavn i allowedHosts (Tailscale Serve). Serve proxyer fra PC-en selv,
          // så forespørselen kommer fra loopback. Ingen PIN: bare enheter i tailnettet når adressen.
          if (!allowedHosts.includes(hostName.replace(/\.$/, ''))) {
            res.statusCode = 421;
            return res.end('Misdirected request');
          }
          // Serve setter Tailscale-User-Login for innloggede tailnet-enheter (og fjerner den fra
          // klienten). Funnel-trafikk fra internett har den ikke, så den slipper aldri inn uten PIN.
          if (!req.headers['tailscale-user-login'] && !device) {
            res.statusCode = 403;
            return res.end('Forbidden');
          }
          res.setHeader('Cache-Control', 'private, no-store');
        }
      } else {
        // Fra nettverket: bare i LAN-modus, bare fra private adresser, bare mot PC-ens egen IP.
        const remote = remoteIPv4(req.socket.remoteAddress);
        if (!opts.lan || !(opts.allowRemote ?? isPrivateIPv4)(remote)) {
          res.statusCode = 403;
          return res.end('Forbidden');
        }
        if (!lanHosts().includes(hostName)) {
          res.statusCode = 421;
          return res.end('Misdirected request');
        }
        res.setHeader('Cache-Control', 'private, no-store');
        if (url.pathname === '/lan/login') return await lanLogin(req, res, url, remote, opts.lan);
        if (url.pathname === '/lan/logout') {
          res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
          res.statusCode = 303;
          res.setHeader('Location', '/lan/login');
          return res.end();
        }
        // Ikoner og manifest er åpne: nettleseren henter manifestet uten cookies (credentials: omit),
        // så bak PIN-en ville «Opprett snarvei»/installering fått en grå standardikon.
        const open = url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
        if (!open && !device && !verifyToken(opts.lan.secret, readCookie(req.headers.cookie, COOKIE_NAME))) {
          if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify({ error: 'PIN kreves' }));
          }
          res.statusCode = 303;
          res.setHeader('Location', `/lan/login?next=${encodeURIComponent(url.pathname + url.search)}`);
          return res.end();
        }
      }

      if (url.pathname === '/api/health') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(JSON.stringify({ app: APP_ID, version: opts.version, pid: process.pid, port, dist: existsSync(path.join(dist, 'index.html')) }));
      }
      if (cors && req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }
      if (url.pathname === '/api/devices' || url.pathname.startsWith('/api/devices/')) return await devicesRoute(req, res, url);
      // Del 15: oppdateringer til appen – bare paret app med gyldig token, aldri fra /drop/
      if (url.pathname.startsWith('/api/app/')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (isFromDrop(req)) {
          res.statusCode = 403;
          return res.end(JSON.stringify({ error: 'ikke tilgjengelig herfra' }));
        }
        if (!device) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: 'krever paret app (enhetstoken)' }));
        }
        return appUpdate(req, res, url);
      }
      // PC-en selv: loopback, lokalt vertsnavn, ikke Tailscale, og ingen fremmed Origin.
      const origin = req.headers.origin;
      const fromPc = local && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostName) && !req.headers['tailscale-user-login'] && (!origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
      if (url.pathname === '/api/settings' || url.pathname.startsWith('/api/settings/')) {
        if (!settingsRoute) {
          res.statusCode = 404;
          return res.end();
        }
        return await settingsRoute(req, res, url, { fromPc, fromDrop: isFromDrop(req) });
      }
      if (url.pathname === '/api/share/reveal') {
        // «Vis i Utforsker» (del 10): bare fra PC-en selv (ikke Tailscale, ikke Wi-Fi), bare filer i share-cachen.
        const _fromPcAgain =local && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(hostName) && !req.headers['tailscale-user-login'] && (!origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (!fromPc || req.method !== 'POST') {
          res.statusCode = 403;
          return res.end(JSON.stringify({ error: 'bare fra PC-en' }));
        }
        let b: { slug?: string; variant?: string; version?: number; kind?: string } = {};
        try {
          b = JSON.parse(await readBody(req, 1024)) as typeof b;
        } catch {
          /* tom */
        }
        const slugOk = (s: unknown) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(s);
        if (!slugOk(b.slug) || !slugOk(b.variant) || !Number.isInteger(b.version) || !['full', 'preview', 'wav'].includes(String(b.kind))) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'ugyldig' }));
        }
        const blocked = await shareBlockReason(opts.mediaDir, b.slug!, b.variant!, b.version!);
        if (blocked) {
          res.statusCode = 423;
          return res.end(JSON.stringify({ error: blocked }));
        }
        const r = await shareFileFor(opts.mediaDir, path.resolve(opts.mediaDir, '..'), b.slug!, b.variant!, b.version!, b.kind as 'full' | 'preview' | 'wav');
        if (!r) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: 'ukjent låt' }));
        }
        spawn('explorer.exe', [`/select,"${r.file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url.pathname === '/api/lan/status') return await lanStatus(res, port, !!opts.lan, lanHosts);
      if (url.pathname.startsWith('/api/')) return await api(req, res);
      if (url.pathname.startsWith('/media/')) return await media(req, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        return res.end();
      }
      return serveStatic(dist, url.pathname, req, res);
    } catch (err) {
      opts.log?.(`✗ ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };
  /**
   * Enheter (del 12):
   *   POST   /api/devices/pair { pin, name } → { device, token }  (PIN som for Wi-Fi-modus; begrenset gjetting)
   *   GET    /api/devices                      → { devices }        (uten tokens)
   *   DELETE /api/devices/:id                  → trekker tilbake
   * Selve ruta krever samme tilgang som resten (PC-en, Tailscale eller LAN med PIN).
   */
  async function devicesRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify(body));
    };
    if (!opts.devices) return json(503, { error: 'enheter er ikke satt opp' });
    if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'krever application/json' });
    if (url.pathname === '/api/devices' && req.method === 'GET') return json(200, { devices: await opts.devices.list() });
    if (url.pathname === '/api/devices/pair' && req.method === 'POST') {
      const who = String(req.headers['tailscale-user-login'] ?? remoteIPv4(req.socket.remoteAddress));
      const blocked = limiter.blockedFor(who);
      if (blocked) return json(429, { error: `For mange forsøk. Prøv igjen om ${Math.ceil(blocked / 60)} min.` });
      let body: { pin?: unknown; name?: unknown } = {};
      try {
        body = JSON.parse(await readBody(req, 2048)) as typeof body;
      } catch {
        return json(400, { error: 'ugyldig JSON' });
      }
      const pin = opts.pairPin?.() ?? null;
      if (!pin) return json(409, { error: 'Ingen PIN er satt på PC-en. Kjør «pnpm vault:lan pin» først.' });
      if (typeof body.pin !== 'string' || !verifyPin(body.pin, pin)) {
        limiter.fail(who);
        opts.log?.(`! feil PIN ved paring av enhet (${who})`);
        return json(401, { error: 'Feil PIN-kode.' });
      }
      limiter.success(who);
      const r = await opts.devices.pair(typeof body.name === 'string' ? body.name : 'Android');
      opts.log?.(`✓ ny enhet paret: ${r.device.name} (${r.device.id.slice(0, 8)})`);
      return json(201, r);
    }
    const m = url.pathname.match(/^\/api\/devices\/([\w-]{36})$/);
    if (m && req.method === 'DELETE') return (await opts.devices.revoke(m[1]!)) ? json(200, { ok: true }) : json(404, { error: 'ukjent enhet' });
    return json(404, { error: 'not found' });
  }

  async function lanLogin(req: IncomingMessage, res: ServerResponse, url: URL, remote: string, lan: LanOptions) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'GET') return res.end(loginPage({ next: safeNext(url.searchParams.get('next')), blockedSec: limiter.blockedFor(remote) }));
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end();
    }
    const form = new URLSearchParams(await readBody(req, 2048));
    const next = safeNext(form.get('next'));
    const blocked = limiter.blockedFor(remote);
    if (blocked) {
      res.statusCode = 429;
      return res.end(loginPage({ next, blockedSec: blocked }));
    }
    if (!verifyPin(form.get('pin') ?? '', lan.pin)) {
      limiter.fail(remote);
      opts.log?.(`! feil PIN fra ${remote}`);
      res.statusCode = 401;
      return res.end(loginPage({ next, error: 'Feil PIN-kode.', blockedSec: limiter.blockedFor(remote) }));
    }
    limiter.success(remote);
    const token = issueToken(lan.secret, lan.ttlDays);
    opts.log?.(`✓ ny enhet logget inn fra ${remote} (${String(req.headers['user-agent'] ?? '').slice(0, 80)})`);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token.value}; Path=/; Max-Age=${token.maxAgeSec}; HttpOnly; SameSite=Lax`);
    res.statusCode = 303;
    res.setHeader('Location', next);
    return res.end();
  }

  return Object.assign(handler, { setPort: (p: number) => (port = p) });
}

async function lanStatus(res: ServerResponse, port: number, enabled: boolean, lanHosts: () => string[]) {
  const urls = lanHosts().map((ip) => `http://${ip}:${port}/`);
  const body = { enabled, port, urls, qr: enabled && urls[0] ? await qrSvg(urls[0]) : null, networks: enabled ? networkCategories() : [] };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('for stor forespørsel'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(dist: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  const index = path.join(dist, 'index.html');
  if (!existsSync(index)) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      '<!doctype html><meta charset="utf-8"><title>Groovehouse Vault</title><body style="background:#07080B;color:#EDEAE2;font:16px system-ui;padding:40px">' +
        '<h1>Web-appen er ikke bygget</h1><p>Kjør <code>pnpm vault:install</code> (eller <code>pnpm build</code>) i prosjektmappa.</p>'
    );
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = '/';
  }
  let file = path.resolve(dist, '.' + rel);
  const inside = file === dist || file.startsWith(dist + path.sep);
  const isFile = inside && existsSync(file) && statSync(file).isFile();
  // SPA-fallback: alt som ikke er en fil (og ikke ser ut som en fil), får index.html.
  if (!isFile) {
    if (path.extname(rel) && rel !== '/') {
      res.statusCode = 404;
      return res.end('Not found');
    }
    file = index;
  }
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', STATIC_TYPES[ext] ?? 'application/octet-stream');
  // Vite gir filene i /assets/ hash i navnet; index.html skal alltid hentes på nytt.
  res.setHeader('Cache-Control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Length', String(statSync(file).size));
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// ------------------------------------------------------------------ porter

export type HealthResult = { state: 'ours'; pid: number; version: string } | { state: 'other'; detail: string } | { state: 'none' };

/** Hva svarer på porten? «ours» bare hvis /api/health sier groovehouse-vault. */
export function probeHealth(port: number, timeoutMs = 800): Promise<HealthResult> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c.length < 4096 ? c : ''));
      res.on('end', () => {
        try {
          const j = JSON.parse(body) as { app?: string; pid?: number; version?: string };
          if (j.app === APP_ID) return resolve({ state: 'ours', pid: j.pid ?? 0, version: j.version ?? '' });
        } catch {
          /* ikke JSON */
        }
        resolve({ state: 'other', detail: `HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ state: 'other', detail: 'svarer ikke på HTTP' });
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED' ? { state: 'none' } : { state: 'other', detail: err.code ?? err.message }));
  });
}

/** Serverporten og de neste 10, uten dev-porten. */
export function candidatePorts(server: number, dev: number): number[] {
  const out: number[] = [];
  for (let p = server; out.length < 11 && p < 65536; p++) if (p !== dev) out.push(p);
  return out;
}

export type ListenResult =
  | { kind: 'listening'; port: number; skipped: Array<{ port: number; reason: string }> }
  | { kind: 'already-running'; port: number; pid: number }
  | { kind: 'failed'; skipped: Array<{ port: number; reason: string }> };

/**
 * Lytter på første ledige kandidat (kun 127.0.0.1). Kjører Groovehouse Vault allerede på en av
 * dem, startes ingen ny instans. Opptatte og reserverte porter (EACCES) hoppes over.
 */
export async function listenWithFallback(server: http.Server, ports: number[], host = '127.0.0.1'): Promise<ListenResult> {
  const skipped: Array<{ port: number; reason: string }> = [];
  for (const port of ports) {
    const h = await probeHealth(port, 500);
    if (h.state === 'ours') return { kind: 'already-running', port, pid: h.pid };
    if (h.state === 'other') {
      skipped.push({ port, reason: `brukes av et annet program (${h.detail})` });
      continue;
    }
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        resolve(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(null);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host, port, exclusive: true });
    });
    if (!err) return { kind: 'listening', port, skipped };
    skipped.push({ port, reason: err.code === 'EACCES' ? 'reservert av Windows (excludedportrange)' : err.code === 'EADDRINUSE' ? 'opptatt' : (err.code ?? err.message) });
  }
  return { kind: 'failed', skipped };
}

export function readVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
