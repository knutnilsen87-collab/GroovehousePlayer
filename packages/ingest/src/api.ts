import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { findRoot, loadConfig } from './config';
import { paletteFrom } from './cover';
import { retagSlug, setAssetCover, updateCatalog } from './ingest';
import { ensureShareFile, ShareError } from './share';
import { DRAFT_BASE, manualPalette, statusOf, validPoint, validateMarkers, versionName, type AssetManifest, type CatalogIndex, type ShareKind } from '@gv/shared';
import { COVER_FILE_RE, createPlaylistStore, PlaylistError, thumbOf, type PlaylistStore } from './playlists';
import { createFavoritesStore, createListenStore, LibraryError } from './library';
import { hasWordTimes, sharedLyricsQueue } from './lyrics-queue';
import { buildCoverPrompt, bulkImgStatus, COVER_STYLES, receiveFromBulkImg, sendToBulkImg } from './bulkimg';
import { createSkippedStore } from './incoming';
import { importSkipped } from './import-actions';
import { findBrandLogo, handleSkins } from './skins-store';
import { handleFx } from './fx-store';
import { BUILT_IN_SKIN_IDS, cleanRelease, type ReleaseInfo } from '@gv/shared';
import { handleDrops, linkServiceStatus, type DropPublisher } from './drops-api';
import { loadPlayback, savePoint } from './playback-store';
import { readMarkersFile, writeJsonAtomic, writeMarkersFile } from './markers-file';
import { addLearn, m3u, readLearn, recordedPairs, rekordboxXml, resolveItems, type ExportItem } from './sets';
import { readSources, sourceKey, sourcesFile } from './source-index';
import { overridePath, readOverrides, type MetaFile } from './sources';
import { createCatalogBundler } from './catalog-bundle';
import { gzipSync } from 'node:zlib';

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
 *
 * Del 14 (samme tilgang som spillelistene, aldri fra /drop/; skriving krever JSON):
 *   GET    /api/favorites            → { slugs, updatedAt }
 *   PUT    /api/favorites/:slug      → { slugs, updatedAt }   DELETE /api/favorites/:slug → samme
 *   GET    /api/lyrics/:slug         → { slug, format: "lrc"|"txt", text } | 404
 *   PUT    /api/lyrics/:slug         { format, text } → { lyrics } (tom tekst sletter → { lyrics: null })
 *   GET    /api/listens              → { bySlug, recent, byDay }
 *   POST   /api/listens              { events: [{ slug, play?, ms? }] } → 204
 *
 * Del 2 (markør-editoren i Studio):
 *   GET    /api/assets/:slug/:variant|main/:versjon/markers → { markers, dismissed, edited }
 *   POST   /api/assets/:slug/:variant|main/:versjon/markers { markers, dismissed? } → { manifest }
 *          Lagres i markers.json (overlever --force) og i manifest.json (spilleren bruker dem med en gang).
 */
export interface ApiOptions {
  mediaDir: string;
  /** Mappe for playlists.json. Standard: <prosjektrot>/data. */
  dataDir?: string;
  /** Del 13: bytt ut opplastingen i tester. Standard er lytter-workeren når den er koblet til. */
  publishDrop?: DropPublisher;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const EDITABLE = ['title', 'artist', 'album'] as const;

export const APP_ID = 'groovehouse-vault';

export function createApiHandler(opts: ApiOptions) {
  const root = findRoot(opts.mediaDir);
  // Leses per forespørsel: innstillinger fra Studio (del 8) gjelder uten omstart.
  const config = () => loadConfig(root);
  const dataDir = opts.dataDir ?? path.join(root, 'data');
  const playlists = createPlaylistStore(path.join(dataDir, 'playlists.json'));
  const favorites = createFavoritesStore(path.join(dataDir, 'favorites.json'));
  // Tekstkøen (Demucs + WhisperX) deles med watcheren i serveren; samme lager, så skrivingene går i rekkefølge
  const lyricsQueue = sharedLyricsQueue({ mediaDir: opts.mediaDir, dataDir, root });
  const lyrics = lyricsQueue.store;
  const skippedStore = createSkippedStore(dataDir);
  const listens = createListenStore(path.join(dataDir, 'listens.json'));
  const catalogBundle = createCatalogBundler(opts.mediaDir);
  // Varm opp katalogen ved oppstart: leser disk-cache (data/catalog-bundle-cache.json) eller bygger i bakgrunnen
  setTimeout(() => void catalogBundle.prepared(dataDir).catch(() => undefined), 200).unref?.();
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* ingen package.json – behold 0.0.0 */
  }
  return async function handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health') return send(res, 200, { app: APP_ID, version });
    // Samlet katalog: ett kall i stedet for manifest + analyse per låt. Ikke fra /drop/ (der vises bare én låt).
    if (url.pathname === '/api/catalog' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const p = await catalogBundle.prepared(dataDir);
      if (!p) return send(res, 404, { error: 'tomt hvelv' });
      res.setHeader('ETag', p.etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Vary', 'Accept-Encoding');
      const inm = String(req.headers['if-none-match'] ?? '').trim();
      if (inm && (inm === p.etag || inm.split(',').some((x) => x.trim() === p.etag))) {
        res.statusCode = 304;
        return void res.end();
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'HEAD') return void res.end();
      if (/gzip/.test(String(req.headers['accept-encoding'] ?? ''))) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(p.gzip.length));
        return void res.end(p.gzip);
      }
      res.setHeader('Content-Length', String(p.raw.length));
      return void res.end(p.raw);
    }
    // Del 26: albumbyggerens valg – «Utelat disse låtene» (f.eks. allerede utgitt) og «Singel-kandidat» (slugs)
    if (url.pathname === '/api/album') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const file = path.join(dataDir, 'album.json');
      const read = async (): Promise<{ exclude: string[]; singles: string[] }> => {
        try {
          const j = JSON.parse(await readFile(file, 'utf8')) as { exclude?: unknown; singles?: unknown };
          const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
          return { exclude: list(j.exclude), singles: list(j.singles) };
        } catch {
          return { exclude: [], singles: [] };
        }
      };
      if (req.method === 'GET') return send(res, 200, await read());
      if (req.method === 'PUT') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
        const body = ((await readJson(req, 200_000).catch(() => null)) ?? {}) as { exclude?: unknown; singles?: unknown };
        const slugs = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(s)))] : null);
        const cur = await read();
        const next = { schema: 1, exclude: slugs(body.exclude) ?? cur.exclude, singles: slugs(body.singles) ?? cur.singles, updatedAt: new Date().toISOString() };
        await writeJsonAtomic(file, next);
        return send(res, 200, { exclude: next.exclude, singles: next.singles });
      }
      return send(res, 405, { error: 'GET eller PUT' });
    }
    // Del 25: utgivelsesinfo per låt (dato, distributør, UPC/ISRC, lenker). Bare egne enheter, aldri /drop/.
    if (url.pathname === '/api/releases' || url.pathname.startsWith('/api/releases/')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const file = path.join(dataDir, 'releases.json');
      const readAll = async (): Promise<Record<string, ReleaseInfo>> => {
        try {
          return ((JSON.parse(await readFile(file, 'utf8')) as { releases?: Record<string, ReleaseInfo> }).releases ?? {}) as Record<string, ReleaseInfo>;
        } catch {
          return {};
        }
      };
      if (url.pathname === '/api/releases' && req.method === 'GET') return send(res, 200, { releases: await readAll() });
      const m = url.pathname.match(/^\/api\/releases\/([a-z0-9][a-z0-9-]{0,120})$/);
      if (m && req.method === 'PUT') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
        let info: ReleaseInfo;
        try {
          info = cleanRelease(await readJson(req, 16_000));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const all = await readAll();
        const empty = !info.date && !info.distributor && !info.upc && !info.isrc && !info.releaseTitle && !info.releaseType && !Object.keys(info.links).length;
        if (empty) delete all[m[1]!];
        else all[m[1]!] = { ...info, updatedAt: new Date().toISOString() };
        await writeJsonAtomic(file, { schema: 1, releases: all });
        return send(res, 200, { release: all[m[1]!] ?? null });
      }
      return send(res, 405, { error: 'GET /api/releases eller PUT /api/releases/<slug>' });
    }
    // Del 5: posisjon på tvers av enheter. Nyeste tidsstempel vinner. Aldri fra /drop/.
    if (url.pathname === '/api/playback') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const file = path.join(dataDir, 'playback.json');
      if (req.method === 'GET') return send(res, 200, await loadPlayback(file));
      if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      const body = (await readJson(req).catch(() => null)) as Record<string, unknown> | null;
      if (!body || !validPoint(body as never)) return send(res, 400, { error: 'ugyldig posisjon' });
      const saved = await savePoint(file, { slug: body.slug as string, variant: body.variant as string, positionMs: body.positionMs as number, updatedAt: body.updatedAt as string, deviceId: body.deviceId as string, deviceLabel: String(body.deviceLabel).slice(0, 40) }, body.claim === true);
      return send(res, 200, saved);
    }
    // Del 13: personlig lytterlenke. Tokenet returneres én gang og lagres ikke her.
    if (url.pathname === '/api/drops/status' && req.method === 'GET') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return send(res, 200, opts.publishDrop ? { available: true } : await linkServiceStatus());
    }
    if (url.pathname === '/api/drops') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return handleDrops({ mediaDir: opts.mediaDir, dataDir, publish: opts.publishDrop }, req, res);
    }
    // Del 18: overgangs-presets og idéer
    if (url.pathname === '/api/fx' || url.pathname.startsWith('/api/fx/')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return handleFx(dataDir, url, req, res, send, readJson);
    }
    // Del 19: egne skins (data/skins/) og «samme skin på alle enheter»
    if (url.pathname === '/api/skins' || url.pathname.startsWith('/api/skins/')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return handleSkins(path.join(dataDir, 'skins'), new Set<string>(BUILT_IN_SKIN_IDS), url, req, res, send, readJson);
    }
    // Del 19: merkevarelogo for skins (Echo Groove-ordmerket), hvis Knut har lagt den i assets/brand/<navn>/
    const brand = url.pathname.match(/^\/api\/brand\/([a-z0-9-]{1,40})\/logo$/);
    if (brand && req.method === 'GET') {
      const file = await findBrandLogo(root, brand[1]!);
      if (!file) return send(res, 404, { error: 'ingen logo ennå' });
      res.statusCode = 200;
      res.setHeader('Content-Type', file.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (file.toLowerCase().endsWith('.svg')) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      return void res.end(readFileSync(file));
    }
    if (url.pathname === '/api/playlists' || url.pathname.startsWith('/api/playlists/')) {
      await handlePlaylists(playlists, url, req, res);
      return;
    }
    // Del 17: settbyggeren – eksport (rekordbox XML / M3U) og læring
    if (url.pathname === '/api/sets/export' && req.method === 'POST') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      const body = (await readJson(req, 200_000).catch(() => ({}))) as { format?: unknown; name?: unknown; items?: unknown };
      if (body.format !== 'rekordbox' && body.format !== 'm3u') return send(res, 400, { error: 'format må være rekordbox eller m3u' });
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 300) return send(res, 400, { error: 'items mangler (maks 300)' });
      const name = (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Groovehouse-sett').slice(0, 100);
      try {
        const items = await resolveItems(opts.mediaDir, config().exportDir, body.items as ExportItem[]);
        const text = body.format === 'rekordbox' ? rekordboxXml(name, items) : m3u(name, items);
        const file = `${name.replace(/[\/:*?"<>|]/g, '_')}.${body.format === 'rekordbox' ? 'xml' : 'm3u8'}`;
        res.statusCode = 200;
        res.setHeader('Content-Type', body.format === 'rekordbox' ? 'application/xml; charset=utf-8' : 'audio/x-mpegurl; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition(file));
        res.setHeader('Cache-Control', 'no-store');
        return void res.end(text);
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (url.pathname === '/api/sets/learn') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const file = path.join(dataDir, 'setbuilder.json');
      if (req.method === 'GET') return send(res, 200, { events: (await readLearn(file)).events, knownPairs: await recordedPairs(opts.mediaDir) });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      if (req.method === 'POST') {
        try {
          return send(res, 200, { count: (await addLearn(file, ((await readJson(req)) as { event?: unknown }).event)).events.length });
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (req.method === 'DELETE') {
        await writeJsonAtomic(file, { schema: 1, events: [] });
        return send(res, 200, { count: 0 });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    // Del 16: «Importer som utkast» – fila legges i data/drafts-inbox/, og utkast-watcheren ingester den
    if (url.pathname === '/api/drafts/import' && req.method === 'POST') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      // Egen header tvinger nettlesere til en CORS-preflight (ingen opplasting fra fremmede sider)
      if (req.headers['x-gv-import'] !== '1') return send(res, 400, { error: 'mangler X-GV-Import' });
      const raw = (url.searchParams.get('name') ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
      if (!/\.(wav|wave|aif|aiff|flac|png|jpe?g|webp)$/i.test(raw) || raw.length > 180 || raw.startsWith('.')) return send(res, 400, { error: 'bare lydfiler (WAV/AIFF/FLAC) og cover-bilder' });
      const inbox = path.join(dataDir, 'drafts-inbox');
      await mkdir(inbox, { recursive: true });
      const target = path.join(inbox, raw);
      const tmp = `${target}.${process.pid}.upload`;
      try {
        await pipeline(req, createWriteStream(tmp));
        await rename(tmp, target);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return send(res, 201, { file: raw });
    }

    // Del 16: gjør et utkast om til release-klart – bare eksplisitt, med bekreftelse
    const st = url.pathname.match(/^\/api\/assets\/([a-z0-9][a-z0-9-]{0,120})\/([a-z0-9][a-z0-9-]{0,120})\/v?(\d{1,4})\/status$/);
    if (st && req.method === 'POST') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      const body = (await readJson(req).catch(() => ({}))) as { status?: unknown; confirm?: unknown };
      if (body.status !== 'release' || body.confirm !== true) return send(res, 400, { error: 'krever { status: "release", confirm: true }' });
      const dir = path.join(opts.mediaDir, st[1]!, st[2]!, `v${Number(st[3])}`);
      const mf = path.join(dir, 'manifest.json');
      if (!existsSync(mf)) return send(res, 404, { error: 'ukjent låt eller versjon' });
      const man = JSON.parse(await readFile(mf, 'utf8')) as AssetManifest;
      if (statusOf(man) === 'release') return send(res, 200, { manifest: man });
      const next: AssetManifest = { ...man, status: 'release', versionLabel: `${man.versionLabel ?? versionName(man)} (gjort release-klar)` };
      await writeJsonAtomic(mf, next);
      await updateCatalog(opts.mediaDir, next);
      catalogBundle.invalidate();
      return send(res, 200, { manifest: next });
    }

    // Del 2: strukturmarkører per versjon
    const mk = url.pathname.match(/^\/api\/assets\/([a-z0-9][a-z0-9-]{0,120})\/([a-z0-9][a-z0-9-]{0,120})\/v?(\d{1,4})\/markers$/);
    if (mk) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const dir = path.join(opts.mediaDir, mk[1]!, mk[2]!, `v${Number(mk[3])}`);
      const manifestFile = path.join(dir, 'manifest.json');
      if (!existsSync(manifestFile)) return send(res, 404, { error: 'ukjent låt eller versjon' });
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as AssetManifest;
      if (req.method === 'GET') {
        const f = await readMarkersFile(dir);
        return send(res, 200, { markers: manifest.markers, dismissed: f?.dismissed ?? [], edited: !!f });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      let body: { markers?: unknown; dismissed?: unknown };
      try {
        body = (await readJson(req, 200_000)) as typeof body;
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      const v = validateMarkers(body.markers, manifest.durationMs);
      if (!v.ok) return send(res, 400, { error: v.error });
      const dismissed = Array.isArray(body.dismissed) ? [...new Set(body.dismissed.filter((d): d is string => typeof d === 'string' && d.length <= 60))].slice(0, 200) : [];
      await writeMarkersFile(dir, { schema: 1, updatedAt: new Date().toISOString(), markers: v.markers, dismissed });
      const next: AssetManifest = { ...manifest, markers: v.markers };
      await writeJsonAtomic(manifestFile, next);
      catalogBundle.invalidate();
      return send(res, 200, { manifest: next });
    }

    // «Hoppet over – finnes allerede»: filer som ligner en låt i Vault. Knut velger ny versjon, egen låt eller å la være.
    if (url.pathname === '/api/import-skipped' && req.method === 'GET') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return send(res, 200, { items: await skippedStore.list() });
    }
    const sk = url.pathname.match(/^\/api\/import-skipped\/([0-9a-f-]{36})$/);
    if (sk && req.method === 'POST') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const body = ((await readJson(req).catch(() => ({}))) ?? {}) as { choice?: unknown };
      const choice = body.choice;
      if (choice !== 'version' && choice !== 'separate' && choice !== 'dismiss') return send(res, 400, { error: 'choice må være version, separate eller dismiss' });
      const it = await skippedStore.take(sk[1]!);
      if (!it) return send(res, 404, { error: 'finnes ikke i lista' });
      if (choice === 'dismiss') return send(res, 200, { ok: true });
      try {
        const results = await importSkipped(it, choice, { mediaDir: opts.mediaDir, cfg: config() });
        for (const r of results) lyricsQueue.enqueue(r.manifest.slug, { title: r.manifest.title, audioFile: it.file });
        return send(res, 200, { manifests: results.map((r) => r.manifest) });
      } catch (err) {
        await skippedStore.add(it); // tilbake i lista, så valget kan prøves igjen
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Del 23 nivå 2: AI-cover via bulkIMG (CSV ut til innboksen, cover inn fra eksportmappa)
    if (url.pathname.startsWith('/api/ai-covers')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const cfg = config();
      try {
        if (url.pathname === '/api/ai-covers' && req.method === 'GET') return send(res, 200, await bulkImgStatus(cfg, dataDir));
        if (url.pathname === '/api/ai-covers/check' && req.method === 'POST') {
          const got = await receiveFromBulkImg({ cfg, mediaDir: opts.mediaDir, dataDir });
          return send(res, 200, { received: got.length, status: await bulkImgStatus(cfg, dataDir) });
        }
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
        const body = ((await readJson(req, 400_000).catch(() => ({}))) ?? {}) as { slugs?: unknown; all?: unknown; style?: unknown; items?: unknown };
        if (url.pathname === '/api/ai-covers/preview' && req.method === 'POST') {
          // Låtene (nyeste versjon per variant) med automatisk prompt. Knut kan redigere prompten før sending.
          const idx = JSON.parse(await readFile(path.join(opts.mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
          const want = Array.isArray(body.slugs) ? new Set(body.slugs.filter((s): s is string => typeof s === 'string')) : null;
          const latest = new Map<string, CatalogIndex['assets'][number]>();
          for (const a of idx.assets) {
            if (want && !want.has(a.slug)) continue;
            const k = `${a.slug}::${a.variant ?? ''}`;
            const cur = latest.get(k);
            if (!cur || a.version > cur.version) latest.set(k, a);
          }
          const items = [];
          for (const a of latest.values()) {
            const m = JSON.parse(await readFile(path.join(opts.mediaDir, a.manifest), 'utf8')) as AssetManifest;
            // «Lag for alle uten cover»: bare låter uten ekte cover (Vault-cover eller ingen)
            if (body.all === true && (m.coverSource === 'file' || m.coverSource === 'ai' || (m.files.cover && !m.coverSource))) continue;
            if (m.kind === 'set') continue;
            const l = await lyrics.get(m.slug);
            items.push({ slug: m.slug, variant: m.variant, title: m.title, prompt: buildCoverPrompt(m, { lyrics: l?.text, style: typeof body.style === 'string' ? body.style : undefined }) });
          }
          return send(res, 200, { items, styles: Object.entries(COVER_STYLES).map(([id, s]) => ({ id, name: s.name })), inbox: cfg.covers.bulkimgInbox });
        }
        if (url.pathname === '/api/ai-covers/send' && req.method === 'POST') {
          const raw = Array.isArray(body.items) ? (body.items as Array<{ slug?: unknown; variant?: unknown; prompt?: unknown }>) : [];
          const idx = JSON.parse(await readFile(path.join(opts.mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
          const items: Array<{ manifest: AssetManifest; prompt: string }> = [];
          for (const it of raw.slice(0, 500)) {
            if (typeof it.slug !== 'string' || typeof it.prompt !== 'string' || !it.prompt.trim() || it.prompt.length > 4000) continue;
            const variant = typeof it.variant === 'string' ? it.variant : null;
            const a = idx.assets.filter((x) => x.slug === it.slug && (x.variant ?? null) === variant).sort((x, y) => y.version - x.version)[0];
            if (!a) continue;
            items.push({ manifest: JSON.parse(await readFile(path.join(opts.mediaDir, a.manifest), 'utf8')) as AssetManifest, prompt: it.prompt.replace(/\s+/g, ' ').trim() });
          }
          if (!items.length) return send(res, 400, { error: 'ingen gyldige låter å sende' });
          const r = await sendToBulkImg({ cfg, dataDir, items });
          return send(res, 200, { ...r, status: await bulkImgStatus(cfg, dataDir) });
        }
        return send(res, 405, { error: 'method not allowed' });
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Tekst: kø, «Synkroniser nå» og godkjenning av automatisk transkribert tekst
    if (url.pathname === '/api/lyrics-queue' && req.method === 'GET') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      return send(res, 200, lyricsQueue.status());
    }
    // Nattkjøring: tekst på alle låter (ikke live-sett), 01–07, med pause/fortsett/stopp fra Studio
    if (url.pathname === '/api/lyrics-batch' && req.method === 'POST') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const body = ((await readJson(req).catch(() => ({}))) ?? {}) as { action?: unknown };
      if (body.action === 'start') {
        const idx = JSON.parse(await readFile(path.join(opts.mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
        const bySlug = new Map<string, string>();
        for (const a of idx.assets) if (a.kind !== 'set' && !bySlug.has(a.slug)) bySlug.set(a.slug, a.title);
        lyricsQueue.startBatch([...bySlug.entries()].map(([slug, title]) => ({ slug, title })));
        return send(res, 200, lyricsQueue.status());
      }
      if (body.action === 'pause' || body.action === 'resume' || body.action === 'stop') {
        if (!lyricsQueue.controlBatch(body.action)) return send(res, 404, { error: 'ingen nattkjøring' });
        return send(res, 200, lyricsQueue.status());
      }
      return send(res, 400, { error: 'action må være start, pause, resume eller stop' });
    }
    const tr = url.pathname.match(/^\/api\/lyrics\/([a-z0-9][a-z0-9-]{0,120})\/(transcribe|approve)$/);
    if (tr && req.method === 'POST') {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const slug = tr[1]!;
      if (tr[2] === 'approve') {
        const meta = await lyrics.approve(slug);
        return meta ? send(res, 200, { meta }) : send(res, 404, { error: 'ingen automatisk tekst å godkjenne' });
      }
      // Går gjennom samme kø som automatikken (én GPU-jobb om gangen), og svarer når jobben er ferdig
      const job = lyricsQueue.enqueue(slug, { reason: 'studio' })!;
      const done = await lyricsQueue.wait(job);
      if (done.status !== 'done') return send(res, 400, { error: done.note ?? 'transkriberingen feilet' });
      const l = await lyrics.get(slug);
      return send(res, 200, { lyrics: l, wordCount: done.words ?? 0, mode: done.mode, ms: done.ms });
    }

    // Del 14: favoritter, sangtekst og egne avspillinger
    const lib = url.pathname.match(/^\/api\/(favorites|lyrics|listens)(?:\/([^/]+))?$/);
    if (lib) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const [, what, rawSlug] = lib;
      const slug = rawSlug ? decodeURIComponent(rawSlug) : null;
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (write && !(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
      try {
        if (what === 'favorites') {
          if (!slug && req.method === 'GET') return send(res, 200, await favorites.read());
          if (slug && (req.method === 'PUT' || req.method === 'DELETE')) return send(res, 200, await favorites.set(slug, req.method === 'PUT'));
        } else if (what === 'lyrics' && slug) {
          if (req.method === 'GET') {
            const l = await lyrics.get(slug);
            if (l) return send(res, 200, l);
            // Instrumental (Demucs fant ingen vokal): ingen tekstfil, men merket vises i Studio
            const meta = await lyrics.getMeta(slug);
            return meta?.source === 'instrumental' ? send(res, 200, { slug, format: 'txt', text: '', meta }) : send(res, 404, { error: 'ingen tekst' });
          }
          if (req.method === 'PUT') {
            const body = (await readJson(req, 400_000)) as { format?: unknown; text?: unknown };
            const saved = await lyrics.put(slug, body.format, body.text);
            if (saved && saved.format === 'txt') {
              // Tekst limt inn i Studio: Knuts egen tekst. Ordtidene beregnes i bakgrunnen (hvis automatikken er på).
              await lyrics.setMeta(slug, { source: 'manual', approved: true });
              lyricsQueue.enqueue(slug, { reason: 'pasted' });
            } else if (saved && !hasWordTimes(saved.text) && !(await lyrics.getMeta(slug))) {
              await lyrics.setMeta(slug, { source: 'manual', approved: true });
            }
            return send(res, 200, { lyrics: saved ? { ...saved, meta: await lyrics.getMeta(slug) } : null });
          }
        } else if (what === 'listens' && !slug) {
          if (req.method === 'GET') return send(res, 200, await listens.read());
          if (req.method === 'POST') {
            await listens.add(((await readJson(req)) as { events?: unknown }).events);
            res.statusCode = 204;
            return void res.end();
          }
        }
        return send(res, 405, { error: 'method not allowed' });
      } catch (err) {
        if (err instanceof LibraryError) return send(res, err.status, { error: err.message });
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Del 10: del en låt som fil. Aldri fra lyttersiden.
    const sh = url.pathname.match(/^\/api\/share\/([a-z0-9][a-z0-9-]{0,120})\/([a-z0-9][a-z0-9-]{0,120})\/v?(\d{1,4})$/);
    if (sh && (req.method === 'GET' || req.method === 'HEAD')) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const kind = url.searchParams.get('kind') ?? 'full';
      if (kind !== 'full' && kind !== 'preview' && kind !== 'wav') return send(res, 400, { error: 'kind må være full, preview eller wav' });
      // Del 16: utkast deles bare etter et eksplisitt valg («Del utkast likevel»)
      if (Number(sh[3]) > DRAFT_BASE && url.searchParams.get('draft') !== '1') return send(res, 409, { error: 'Denne låta er umastret. Velg «Del umastret likevel» for å dele den.', draft: true });
      const blocked = await shareBlockReason(opts.mediaDir, sh[1]!, sh[2]!, Number(sh[3]));
      if (blocked) return send(res, 423, { error: blocked, blocked: true });
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
    const cov = url.pathname.match(/^\/api\/assets\/([^/]+)\/cover$/);
    if (cov) {
      if (isFromDrop(req)) return send(res, 403, { error: 'ikke tilgjengelig herfra' });
      const slug = decodeURIComponent(cov[1]!);
      if (!SLUG_RE.test(slug)) return send(res, 400, { error: 'ugyldig slug' });
      if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
      const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!COVER_TYPES.test(type)) return send(res, 415, { error: 'krever et bilde (JPEG, PNG, WebP …)' });
      try {
        const buf = await readRaw(req, COVER_MAX);
        const meta = await sharp(buf).metadata().catch(() => null);
        if (!meta?.width || !meta.height) return send(res, 400, { error: 'fila er ikke et bilde som kan leses' });
        const manifests = await setAssetCover(opts.mediaDir, slug, buf, config());
        catalogBundle.invalidate();
        return send(res, 200, { manifests });
      } catch (err) {
        if (err instanceof PlaylistError) return send(res, err.status, { error: err.message });
        const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
        return send(res, msg === 'ukjent låt' ? 404 : 500, { error: msg });
      }
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
      // Del 17: energi for settbyggeren (1–10, null = fra analysen)
      if (body.energy !== undefined) {
        const v = body.energy;
        if (v === null) delete next.energy;
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 10) return send(res, 400, { error: 'energi må være 1–10' });
        else next.energy = Math.round(v * 10) / 10;
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
      catalogBundle.invalidate();
      return send(res, 200, { meta: next, manifests });
    } catch (err) {
      return send(res, 500, { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
  };
}

/** Finn versjonen og lag/gjenbruk delingsfila. null = ukjent låt/versjon. */
/** Sperret for deling (manifest.shareBlocked, f.eks. arbeidstittel som må byttes): grunnen, ellers null. */
export async function shareBlockReason(mediaDir: string, slug: string, variant: string, version: number): Promise<string | null> {
  try {
    const m = JSON.parse(await readFile(path.join(mediaDir, slug, variant, `v${version}`, 'manifest.json'), 'utf8')) as AssetManifest;
    return m.shareBlocked ? `Sperret for deling: ${m.shareBlocked}` : null;
  } catch {
    return null;
  }
}

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
