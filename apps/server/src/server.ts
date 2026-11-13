import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { APP_ID, createApiHandler } from '@gv/ingest/api';
import { createMediaHandler } from '@gv/ingest/media-static';
import { COOKIE_NAME, issueToken, LoginLimiter, readCookie, verifyPin, verifyToken, type PinRecord } from './lan-auth';
import { isLoopback, isPrivateIPv4, lanAddresses, loginPage, networkCategories, qrSvg, remoteIPv4, safeNext } from './lan';

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
   */
  allowedHosts?: string[];
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
  const isLocal = opts.isLocal ?? isLoopback;
  const lanHosts = opts.lanHosts ?? lanAddresses;
  const allowedHosts = (opts.allowedHosts ?? []).map((h) => h.toLowerCase().replace(/\.$/, ''));
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
          if (!req.headers['tailscale-user-login']) {
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
        if (!open && !verifyToken(opts.lan.secret, readCookie(req.headers.cookie, COOKIE_NAME))) {
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
