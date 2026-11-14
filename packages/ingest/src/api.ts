import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { findRoot, loadConfig } from './config';
import { paletteFrom } from './cover';
import { retagSlug } from './ingest';
import { ensureShareFile, ShareError } from './share';
import { manualPalette, type AssetManifest, type ShareKind } from '@gv/shared';
import { COVER_FILE_RE, createPlaylistStore, PlaylistError, thumbOf, type PlaylistStore } from './playlists';
import { readSources, sourceKey, sourcesFile } from './source-index';
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
 *   PUT    /api/playlists/:id/cover?updatedAt=…  (bilde som body) → { playlist } | 409
 *   DELETE /api/playlists/:id/cover  { updatedAt } → { playlist } (tilbake til mosaikk)
 *   GET    /api/playlist-covers/:fil.jpg → coveret (uten EXIF)
 *   GET    /api/share/:slug/:variant|main/:versjon?kind=full|preview|wav → fila (del 10, aldri fra /drop/)
 *   GET    /api/shares → { counts }   POST /api/shares { slug, variant, version, kind } (lokal logg)
 *   GET    /api/sources/:slug/:variant|main/:versjon → { fileName } – «Kildefil» (privat, aldri fra /drop/)
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
  // Leses per forespørsel: innstillinger fra Studio (del 8) gjelder uten omstart.
  const config = () => loadConfig(root);
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
    // Del 10: del en låt som fil. Aldri fra lyttersiden.
    const sh = url.pathname.match(/^\/api\/share\/([a-z0-9][a-z0-9-]{0,120})\/([a-z0-9][a-z0-9-]{0,120})\/v?(\d{1,4})$/);
    if (sh && (req.method === 'GET' || req.method === 'HEAD')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const kind = url.searchParams.get('kind') ?? 'full';
      if (kind !== 'full' && kind !== 'preview' && kind !== 'wav') return send(res, 400, { error: 'kind må være full, preview eller wav' });
      try {
        const r = await shareFileFor(opts.mediaDir, root, sh[1]!, sh[2]!, Number(sh[3]), kind);
        if (!r) return send(res, 404, { error: 'ukjent låt eller versjon' });
        res.statusCode = 200;
        res.setHeader('Content-Type', r.contentType);
        res.setHeader('Content-Length', String(r.size));
        res.setHeader('Content-Disposition', contentDisposition(r.fileName));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Share-Filename', encodeURIComponent(r.fileName));
        if (req.method === 'HEAD') return void res.end();
        createReadStream(r.file).pipe(res);
        return;
      } catch (err) {
        if (err instanceof ShareError) return send(res, err.status, { error: err.message });
        return send(res, 500, { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
      }
    }
    if (url.pathname === '/api/shares') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return await sharesLog(req, res, path.join(opts.dataDir ?? path.join(root, 'data'), 'shares.json'));
    }
    const src = url.pathname.match(/^\/api\/sources\/([a-z0-9][a-z0-9-]{0,120})\/([a-z0-9][a-z0-9-]{0,120})\/v?(\d{1,4})$/);
    if (src && req.method === 'GET') {
      // «Kildefil» (del 11): bare for Info og Studio. Aldri for lyttersiden, og bare filnavnet – ikke stien.
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const variant = src[2] === 'main' ? null : src[2]!;
      const rec = (await readSources(sourcesFile(opts.mediaDir, opts.dataDir))).entries[sourceKey(src[1]!, variant, Number(src[3]))];
      return rec ? send(res, 200, { fileName: rec.fileName }) : send(res, 404, { error: 'ukjent kildefil' });
    }
    if (url.pathname.startsWith('/api/playlist-covers/') && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveCover(playlists, url, res);
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
      // Del 8: manuell farge (null = tilbake til coverets) og live-forskyvning
      if (body.palette !== undefined) {
        if (body.palette === null) delete next.palette;
        else {
          const p = body.palette as { primary?: unknown; secondary?: unknown };
          const mp = manualPalette(String(p?.primary ?? ''), String(p?.secondary ?? ''), config().colors.minContrast);
          if (!mp.ok) return send(res, 400, { error: mp.error, contrast: mp.contrast });
          next.palette = { primary: mp.palette.primary, secondary: mp.palette.secondary };
        }
      }
      if (body.liveOffsetMs !== undefined) {
        const v = body.liveOffsetMs;
        if (v === null || v === 0) delete next.liveOffsetMs;
        else if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 10_000 || v % 50 !== 0) return send(res, 400, { error: 'forskyvning må være hele 50 ms mellom −10 000 og 10 000' });
        else next.liveOffsetMs = v;
      }
      const file = overridePath(opts.mediaDir, slug);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2));
      const manifests = await retagSlug(opts.mediaDir, slug, config());
      return send(res, 200, { meta: next, manifests });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
  };
}

/** Finn versjonen og lag/gjenbruk delingsfila. null = ukjent låt/versjon. */
export async function shareFileFor(mediaDir: string, root: string, slug: string, variant: string, version: number, kind: ShareKind) {
  const versionDir = path.join(mediaDir, slug, variant, `v${version}`);
  const manifestFile = path.join(versionDir, 'manifest.json');
  if (!existsSync(manifestFile)) return null;
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as AssetManifest;
  return ensureShareFile({ versionDir, manifest, kind, logo: path.join(root, 'apps', 'web', 'public', 'icons', 'icon-512.png') });
}

/** RFC 6266: ASCII-reserve + UTF-8-navn (æøå og apostrofer beholdes). */
function contentDisposition(name: string) {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/**
 * Lokal logg over delinger (data/shares.json): { slug, variant, version, kind, at }. Ingen mottaker
 * (den vet vi ikke). GET gir antall per versjon («Delt 3 ganger» i Studio).
 */
async function sharesLog(req: IncomingMessage, res: ServerResponse, file: string) {
  type Entry = { slug: string; variant: string; version: number; kind: string; at: string };
  const read = async (): Promise<Entry[]> => {
    try {
      return ((JSON.parse(await readFile(file, 'utf8')) as { shares?: Entry[] }).shares ?? []);
    } catch {
      return [];
    }
  };
  if (req.method === 'GET') {
    const counts: Record<string, number> = {};
    for (const e of await read()) counts[`${e.slug}::${e.variant}::v${e.version}`] = (counts[`${e.slug}::${e.variant}::v${e.version}`] ?? 0) + 1;
    return send(res, 200, { counts });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
  const b = (await readJson(req)) as Partial<Entry>;
  if (!b.slug || !SLUG_RE.test(b.slug) || !b.variant || !SLUG_RE.test(b.variant) || !Number.isInteger(b.version) || !['full', 'preview', 'wav'].includes(String(b.kind)))
    return send(res, 400, { error: 'ugyldig deling' });
  const all = await read();
  all.push({ slug: b.slug, variant: b.variant, version: b.version!, kind: String(b.kind), at: new Date().toISOString() });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify({ schema: 1, shares: all.slice(-10_000) }, null, 2));
  await rename(`${file}.tmp`, file);
  return send(res, 201, { ok: true });
}

/** Kommer forespørselen fra lyttersiden (/drop/...)? Da skal private ting (kildefil, deling) aldri svare. */
export function isFromDrop(req: IncomingMessage): boolean {
  const ref = String(req.headers.referer ?? '');
  try {
    return ref !== '' && new URL(ref).pathname.startsWith('/drop/');
  } catch {
    return false;
  }
}

const COVER_TYPES = /^image\/(jpeg|png|webp|avif|gif|tiff)$/;
const COVER_MAX = 15 * 1024 * 1024;

/** GET /api/playlist-covers/<fil>.jpg – bare filnavn som lageret selv har laget. */
async function serveCover(store: PlaylistStore, url: URL, res: ServerResponse) {
  const name = decodeURIComponent(url.pathname.slice('/api/playlist-covers/'.length));
  if (!COVER_FILE_RE.test(name)) return send(res, 404, { error: 'not found' });
  try {
    const buf = await readFile(path.join(store.coversDir, name));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/jpeg');
    // Filnavnet byttes ved hvert nytt cover, så det kan bufres lenge.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(buf);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

/**
 * Eget cover (pkt. 14): PUT /api/playlists/:id/cover?updatedAt=… med bildet som body (image/*).
 * Et bilde-content-type er ikke en «enkel» forespørsel, så andre nettsider stoppes av CORS-preflight.
 * Bildet normaliseres med sharp (rotasjon fra EXIF, 1200 px + 300 px thumb, JPEG). sharp skriver ikke
 * med metadata, så EXIF/XMP/GPS forsvinner. Paletten hentes med samme kontrastlås som låtcoverne.
 */
async function putCover(store: PlaylistStore, id: string, url: URL, req: IncomingMessage, res: ServerResponse) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
  if (!COVER_TYPES.test(type)) return send(res, 415, { error: 'krever et bilde (JPEG, PNG, WebP …)' });
  const buf = await readRaw(req, COVER_MAX);
  const playlist = await store.setCover(id, url.searchParams.get('updatedAt') ?? undefined, async () => {
    const meta = await sharp(buf).metadata().catch(() => null);
    if (!meta?.width || !meta.height) throw new PlaylistError(400, 'fila er ikke et bilde som kan leses');
    await mkdir(store.coversDir, { recursive: true });
    const file = `${id.slice(0, 36)}-${randomUUID().slice(0, 8)}.jpg`;
    const big = path.join(store.coversDir, file);
    const img = sharp(buf).rotate();
    await img.clone().resize(1200, 1200, { fit: 'cover' }).jpeg({ quality: 88, mozjpeg: true }).toFile(big);
    await img.clone().resize(300, 300, { fit: 'cover' }).jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(store.coversDir, thumbOf(file)));
    return { file, palette: await paletteFrom(big) };
  });
  return send(res, 200, { playlist });
}

async function handlePlaylists(store: PlaylistStore, url: URL, req: IncomingMessage, res: ServerResponse) {
  const rest = url.pathname === '/api/playlists' ? null : decodeURIComponent(url.pathname.slice('/api/playlists/'.length));
  const parts = rest === null ? null : rest.match(/^([\w-]{1,64})(\/cover)?$/);
  if (rest !== null && !parts) return send(res, 404, { error: 'not found' });
  const id = parts ? parts[1]! : null;
  try {
    if (parts?.[2]) {
      if (req.method === 'PUT') return await putCover(store, id!, url, req, res);
      if (req.method !== 'DELETE') return send(res, 405, { error: 'method not allowed' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      const body = (await readJson(req)) as Record<string, unknown>;
      return send(res, 200, { playlist: await store.setCover(id!, typeof body.updatedAt === 'string' ? body.updatedAt : undefined, null) });
    }
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

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new PlaylistError(413, 'bildet er for stort (maks 15 MB)'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
