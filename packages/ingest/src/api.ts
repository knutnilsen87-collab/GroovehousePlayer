import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { findRoot, loadConfig } from './config';
import { retagSlug } from './ingest';
import { createPlaylistStore, PlaylistError, type PlaylistStore } from './playlists';
import { overridePath, readOverrides, type MetaFile } from './sources';

/**
 * Lite HTTP-API for Studio. Brukes som Vite-middleware i dev og av apps/server senere.
 *   GET  /api/health              → { app: "groovehouse-vault", version } – launcher og snarvei sjekker dette
 *   GET  /api/assets/:slug/meta   → overstyringer for låta (media/<slug>/meta.json)
 *   POST /api/assets/:slug/meta   { title?, artist?, album?, variants?: { extended: "Extended Mix" } }
 *        → lagrer, og kjører bare tag- og manifest-steget på nytt (ingen ny analyse).
 * Tom streng fjerner overstyringen. Eksportmappa røres aldri.
 *
 * Spillelister (del 9), lagret i <rot>/data/playlists.json:
 *   GET    /api/playlists            → { playlists }
 *   POST   /api/playlists            { name, kind?: "manual"|"smart", query?, entries?: [{ slug, variant? }] } → 201 { playlist }
 *   PATCH  /api/playlists/:id        { updatedAt, name?, entries?, add?, query? } → { playlist } | 409 { error, playlist }
 *   DELETE /api/playlists/:id        { updatedAt } → 204 | 409 { error, playlist }
 */
export interface ApiOptions {
  mediaDir: string;
  /** Mappe for playlists.json. Standard: <prosjektrot>/data. */
  dataDir?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const EDITABLE = ['title', 'artist', 'album'] as const;

export const APP_ID = 'groovehouse-vault';

export function createApiHandler(opts: ApiOptions) {
  const root = findRoot(opts.mediaDir);
  const cfg = loadConfig(root);
  const playlists = createPlaylistStore(path.join(opts.dataDir ?? path.join(root, 'data'), 'playlists.json'));
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* ingen package.json – behold 0.0.0 */
  }
  return async function handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health') return send(res, 200, { app: APP_ID, version });
    if (url.pathname === '/api/playlists' || url.pathname.startsWith('/api/playlists/')) {
      await handlePlaylists(playlists, url, req, res);
      return;
    }
    const m = url.pathname.match(/^\/api\/assets\/([^/]+)\/meta$/);
    if (!m) {
      if (next) return next();
      return send(res, 404, { error: 'not found' });
    }
    const slug = decodeURIComponent(m[1]!);
    if (!SLUG_RE.test(slug)) return send(res, 400, { error: 'ugyldig slug' });
    try {
      if (req.method === 'GET') return send(res, 200, await readOverrides(opts.mediaDir, slug));
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      // Krever JSON: da må andre nettsider gjennom en CORS-preflight som aldri godkjennes, og kan ikke skrive hit.
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      const body = (await readJson(req)) as Record<string, unknown>;
      const current = await readOverrides(opts.mediaDir, slug);
      const next: MetaFile = { ...current };
      for (const k of EDITABLE) {
        if (!(k in body)) continue;
        const v = body[k];
        if (v !== null && typeof v !== 'string') return send(res, 400, { error: `${k} må være tekst` });
        const t = (v ?? '').trim();
        if (t.length > 200) return send(res, 400, { error: `${k} er for lang` });
        if (t) next[k] = t;
        else delete next[k];
      }
      if (body.variants !== undefined) {
        if (typeof body.variants !== 'object' || body.variants === null) return send(res, 400, { error: 'variants må være et objekt' });
        const vars = { ...(current.variants ?? {}) };
        for (const [variant, label] of Object.entries(body.variants as Record<string, unknown>)) {
          if (!SLUG_RE.test(variant) || (label !== null && typeof label !== 'string')) return send(res, 400, { error: 'ugyldig variant' });
          const t = (label ?? '').trim();
          if (t) vars[variant] = t;
          else delete vars[variant];
        }
        if (Object.keys(vars).length) next.variants = vars;
        else delete next.variants;
      }
      const file = overridePath(opts.mediaDir, slug);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2));
      const manifests = await retagSlug(opts.mediaDir, slug, cfg);
      return send(res, 200, { meta: next, manifests });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
  };
}

async function handlePlaylists(store: PlaylistStore, url: URL, req: IncomingMessage, res: ServerResponse) {
  const id = url.pathname === '/api/playlists' ? null : decodeURIComponent(url.pathname.slice('/api/playlists/'.length));
  if (id !== null && !/^[\w-]{1,64}$/.test(id)) return send(res, 404, { error: 'not found' });
  try {
    if (req.method === 'GET' && id === null) return send(res, 200, { playlists: await store.list() });
    if (!['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) return send(res, 405, { error: 'method not allowed' });
    // Krever JSON (som meta-endepunktet): andre nettsider må da gjennom en CORS-preflight som aldri godkjennes.
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
    const body = (await readJson(req, 512_000)) as Record<string, unknown>;
    if (req.method === 'POST' && id === null) return send(res, 201, { playlist: await store.create(body as never) });
    if (id === null) return send(res, 405, { error: 'method not allowed' });
    if (typeof body.updatedAt !== 'string') return send(res, 400, { error: 'updatedAt mangler' });
    if (req.method === 'PATCH') return send(res, 200, { playlist: await store.patch(id, body as never) });
    if (req.method === 'DELETE') {
      await store.remove(id, body.updatedAt);
      res.statusCode = 204;
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    if (err instanceof PlaylistError) return send(res, err.status, { error: err.message, ...(err.current ? { playlist: err.current } : {}) });
    const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    return send(res, /JSON|stor forespørsel/.test(msg) ? 400 : 500, { error: msg });
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit = 64_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > limit) reject(new Error('for stor forespørsel'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('ugyldig JSON'));
      }
    });
    req.on('error', reject);
  });
}
