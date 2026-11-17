import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { AssetManifest, DropItem } from '@gv/shared';

/**
 * Del 13 fra PC-en: Studio ber serveren publisere til lytter-workeren.
 * Råtokenet skrives aldri til disk. Uten LISTEN_ADMIN_URL er tjenesten ikke koblet til.
 */
export interface PublishFile {
  hash: string;
  path: string;
  body: Uint8Array;
  type: string;
}
export interface PublishRequest {
  title: string;
  recipient: string;
  tier: 'partner' | 'inner' | 'supporter' | 'teaser';
  expiresAt: string | null;
  maxDevices: number;
  code: string | null;
  items: DropItem[];
  files: PublishFile[];
}
export type DropPublisher = (req: PublishRequest) => Promise<{ id: string; url: string; token: string }>;

export function listenConfigured(): boolean {
  return !!(process.env.LISTEN_ADMIN_URL && process.env.LISTEN_ADMIN_TOKEN);
}

/**
 * Del 27: er lenketjenesten (del 13) faktisk tilgjengelig? Sjekkes før delingsarket fylles ut.
 * «unconfigured» = ikke satt opp på PC-en; «unreachable» = satt opp, men svarer ikke nå (målt, ikke antatt).
 * Svaret har aldri adresse eller token.
 */
export type LinkServiceStatus = { available: true } | { available: false; reason: 'unconfigured' | 'unreachable'; detail: string };
export async function linkServiceStatus(fetcher: typeof fetch = fetch, timeoutMs = 4000): Promise<LinkServiceStatus> {
  const base = process.env.LISTEN_ADMIN_URL?.replace(/\/$/, '');
  if (!base || !process.env.LISTEN_ADMIN_TOKEN) return { available: false, reason: 'unconfigured', detail: 'Lenketjenesten er ikke satt opp på PC-en ennå.' };
  try {
    const r = await fetcher(`${base}/`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (r.status >= 500) return { available: false, reason: 'unreachable', detail: `Lenketjenesten svarer med feil (${r.status}) akkurat nå.` };
    return { available: true };
  } catch {
    return { available: false, reason: 'unreachable', detail: 'Lenketjenesten svarer ikke akkurat nå (sjekket nettopp).' };
  }
}

export async function publishToWorker(req: PublishRequest): Promise<{ id: string; url: string; token: string }> {
  const base = process.env.LISTEN_ADMIN_URL?.replace(/\/$/, '');
  const token = process.env.LISTEN_ADMIN_TOKEN;
  if (!base || !token) {
    const err = new Error('Lytter-tjenesten er ikke koblet til. Sett LISTEN_ADMIN_URL og LISTEN_ADMIN_TOKEN.');
    (err as Error & { status?: number }).status = 503;
    throw err;
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const made = await fetch(`${base}/admin/drops`, { method: 'POST', headers, body: JSON.stringify({ title: req.title, recipient: req.recipient, tier: req.tier, expiresAt: req.expiresAt, maxDevices: req.maxDevices, code: req.code, items: req.items }) });
  if (!made.ok) throw new Error(`lytter-tjenesten svarte ${made.status}`);
  const created = (await made.json()) as { id: string; url: string; token: string };
  for (const f of req.files) {
    const ab = new ArrayBuffer(f.body.byteLength);
    new Uint8Array(ab).set(f.body);
    const put = await fetch(`${base}/admin/objects/${f.hash}/${f.path}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': f.type }, body: ab });
    if (!put.ok) throw new Error(`opplasting av ${f.path} svarte ${put.status}`);
  }
  return created;
}

async function readManifest(mediaDir: string, slug: string, variant: string, version: number): Promise<{ dir: string; manifest: AssetManifest } | null> {
  const dir = path.join(mediaDir, slug, variant, `v${version}`);
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  return { dir, manifest: JSON.parse(await readFile(file, 'utf8')) as AssetManifest };
}

async function collect(dir: string, manifest: AssetManifest): Promise<PublishFile[]> {
  const files: PublishFile[] = [];
  const hls = path.join(dir, manifest.files.hls);
  if (!existsSync(hls)) return files;
  const text = await readFile(hls, 'utf8');
  const hash = manifest.masterSha256;
  files.push({ hash, path: 'index.m3u8', body: new Uint8Array(await readFile(hls)), type: 'application/vnd.apple.mpegurl' });
  for (const line of text.split('\n')) {
    const name = line.trim();
    if (!name || name.startsWith('#')) continue;
    const seg = path.join(path.dirname(hls), name);
    if (existsSync(seg)) files.push({ hash, path: name, body: new Uint8Array(await readFile(seg)), type: 'video/mp2t' });
  }
  const preview = path.join(dir, manifest.files.preview);
  if (existsSync(preview)) files.push({ hash, path: 'audio.m4a', body: new Uint8Array(await readFile(preview)), type: 'audio/mp4' });
  if (manifest.files.cover) {
    const cover = path.join(dir, manifest.files.cover);
    if (existsSync(cover)) files.push({ hash, path: 'cover.jpg', body: new Uint8Array(await readFile(cover)), type: 'image/jpeg' });
  }
  return files;
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

export async function handleDrops(opts: { mediaDir: string; dataDir: string; publish?: DropPublisher }, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'krever application/json' });
  const b = (await readJson(req).catch(() => null)) as { recipient?: unknown; title?: unknown; maxDevices?: unknown; expiresInDays?: unknown; code?: unknown; items?: { slug?: string; variant?: string; version?: number }[] } | null;
  if (!b) return send(res, 400, { error: 'ugyldig JSON' });
  const recipient = typeof b.recipient === 'string' ? b.recipient.trim() : '';
  if (!recipient || recipient.length > 80) return send(res, 400, { error: 'mottaker mangler' });
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) return send(res, 400, { error: 'velg 1–50 låter' });
  const slugOk = (s: unknown) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(s);
  const loaded: { manifest: AssetManifest; files: PublishFile[] }[] = [];
  for (const it of b.items) {
    if (!slugOk(it.slug) || !slugOk(it.variant) || !Number.isInteger(it.version)) return send(res, 400, { error: 'ugyldig låt' });
    const found = await readManifest(opts.mediaDir, it.slug!, it.variant!, it.version!);
    if (!found) return send(res, 404, { error: `fant ikke ${it.slug}` });
    loaded.push({ manifest: found.manifest, files: await collect(found.dir, found.manifest) });
  }
  const publish = opts.publish ?? publishToWorker;
  if (!opts.publish && !listenConfigured()) return send(res, 503, { error: 'Lytter-tjenesten er ikke koblet til. Sett LISTEN_ADMIN_URL og LISTEN_ADMIN_TOKEN.' });
  const first = loaded[0]!.manifest;
  const days = typeof b.expiresInDays === 'number' && b.expiresInDays > 0 ? b.expiresInDays : null;
  const request: PublishRequest = {
    title: typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 120) : first.title,
    recipient,
    tier: 'partner',
    expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    maxDevices: typeof b.maxDevices === 'number' ? Math.min(10, Math.max(1, Math.round(b.maxDevices))) : 2,
    code: typeof b.code === 'string' && /^\d{4}$/.test(b.code) ? b.code : null,
    items: loaded.map((x) => ({ slug: x.manifest.slug, variant: x.manifest.variant ?? 'main', version: x.manifest.version, title: x.manifest.title, artist: x.manifest.artist ?? 'Echo Groove', durationMs: x.manifest.durationMs, contentHash: x.manifest.masterSha256 })),
    files: loaded.flatMap((x) => x.files)
  };
  try {
    const made = await publish(request);
    if (!made.url.startsWith('https://') || /ts\.net|127\.0\.0\.1|localhost/i.test(made.url)) return send(res, 502, { error: 'lytter-tjenesten svarte med en adresse som ikke kan deles' });
    const log = path.join(opts.dataDir, 'drops.json');
    await mkdir(opts.dataDir, { recursive: true });
    let prev: { schema: 1; drops: unknown[] } = { schema: 1, drops: [] };
    try {
      prev = JSON.parse(await readFile(log, 'utf8')) as typeof prev;
    } catch {
      /* første */
    }
    prev.drops.push({ id: made.id, title: request.title, recipient, at: new Date().toISOString() });
    const tmp = `${log}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(prev, null, 2));
    await rename(tmp, log);
    return send(res, 201, { id: made.id, url: made.url });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 502;
    return send(res, status, { error: err instanceof Error ? err.message : String(err) });
  }
}
