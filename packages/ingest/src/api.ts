import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { findRoot, loadConfig } from './config';
import { retagSlug } from './ingest';
import { overridePath, readOverrides, type MetaFile } from './sources';

/**
 * Lite HTTP-API for Studio. Brukes som Vite-middleware i dev og av apps/server senere.
 *   GET  /api/assets/:slug/meta   → overstyringer for låta (media/<slug>/meta.json)
 *   POST /api/assets/:slug/meta   { title?, artist?, album?, variants?: { extended: "Extended Mix" } }
 *        → lagrer, og kjører bare tag- og manifest-steget på nytt (ingen ny analyse).
 * Tom streng fjerner overstyringen. Eksportmappa røres aldri.
 */
export interface ApiOptions {
  mediaDir: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const EDITABLE = ['title', 'artist', 'album'] as const;

export function createApiHandler(opts: ApiOptions) {
  const cfg = loadConfig(findRoot(opts.mediaDir));
  return async function handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
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

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > 64_000) reject(new Error('for stor forespørsel'));
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
