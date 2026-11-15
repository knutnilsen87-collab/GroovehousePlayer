/**
 * Del 13: personlige lytterlenker. PC-en publiserer, Workeren serverer.
 * Råtokenet lagres aldri – bare SHA-256. Enhet telles når avspilling starter, ikke når siden hentes.
 */

const ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BOT = /whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|discordbot|linkedinbot|applebot|googlebot|bingbot|preview|embedly|quora|pinterest|redditbot|iframely/i;

export type DropTier = 'partner' | 'inner' | 'supporter' | 'teaser';
export type ListenEventName = 'start' | '30s' | '50' | 'done' | 'seek';

export interface DropItem {
  slug: string;
  variant: string;
  version: number;
  title: string;
  artist: string;
  durationMs: number;
  contentHash: string;
}

export interface DropRecord {
  id: string;
  title: string;
  tier: DropTier;
  recipient: string;
  expiresAt: string | null;
  maxDevices: number;
  codeHash: string | null;
  revokedAt: string | null;
  items: DropItem[];
  tokenHash: string;
  createdAt: string;
}

export interface DeviceRecord {
  dropId: string;
  deviceId: string;
  userAgent: string;
  firstSeen: string;
  lastSeen: string;
}

export interface ListenEventRecord {
  dropId: string;
  deviceId: string;
  slug: string;
  event: ListenEventName;
  positionMs: number;
  at: string;
}

export interface AccessRequest {
  id: string;
  dropId: string;
  name: string;
  at: string;
  status: 'open' | 'approved';
}

export interface BlobStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryBlobs implements BlobStore {
  private m = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array, contentType: string) {
    this.m.set(key, { body, contentType });
  }
  async get(key: string) {
    return this.m.get(key) ?? null;
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  async keys() {
    return [...this.m.keys()];
  }
}

export function isPreviewBot(ua: string): boolean {
  return BOT.test(ua);
}

export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPH[Number(n % 62n)]! + s;
    n /= 62n;
  }
  return s.padStart(22, '0');
}

export async function sha256Hex(text: string): Promise<string> {
  const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return b64url(new Uint8Array(sig));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length === y.length ? 0 : 1;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** deviceId er tom for cover (forhåndsvisning). Segmenter og spillelista er bundet til enheten. */
export async function signPath(secret: string, dropId: string, path: string, exp: number, deviceId = ''): Promise<string> {
  return hmac(secret, `${dropId}\n${exp}\n${path}\n${deviceId}`);
}

export async function verifyPath(secret: string, dropId: string, path: string, exp: number, sig: string, now: number, deviceId = ''): Promise<boolean> {
  if (!Number.isFinite(exp) || exp < now) return false;
  const expect = await signPath(secret, dropId, path, exp, deviceId);
  return timingSafeEqual(expect, sig);
}

/** Segment-URL-er varer 10 minutter. */
export const SEGMENT_TTL_MS = 10 * 60 * 1000;

export function rewritePlaylist(m3u8: string, sign: (segment: string) => string): string {
  return m3u8
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return sign(t);
    })
    .join('\n');
}

export function listenPageHtml(o: { origin: string; token: string; title: string; artist: string; recipient: string; needsCode: boolean; expired: boolean; image: string; accent?: string }): string {
  const origin = o.origin.replace(/\/$/, '');
  const page = `${origin}/d/${encodeURIComponent(o.token)}`;
  const image = o.image;
  const accent = o.accent ?? '#06B211';
  const heading = o.expired ? 'This link has expired' : `${escapeHtml(o.artist)} – ${escapeHtml(o.title)}`;
  const body = o.expired
    ? `<form id="ask"><p>Ask Knut for a new link.</p><label>Your name<input name="name" maxlength="80" required></label><button type="submit">Request access</button><p id="msg"></p></form>`
    : `<p class="sub">Private listen · Groovehouse Records</p>${o.needsCode ? '<label>Code<input id="code" inputmode="numeric" maxlength="4" autocomplete="one-time-code"></label>' : ''}<button id="play" type="button">Play</button><audio id="audio" controls preload="none"></audio><p id="msg"></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<meta property="og:title" content="${escapeHtml(o.artist)} – ${escapeHtml(o.title)}">
<meta property="og:description" content="Private listen · Groovehouse Records">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:url" content="${escapeHtml(page)}">
<link rel="stylesheet" href="/player/fonts.css">
<style>
  :root { color-scheme: dark; --accent: ${accent}; }
  body { margin: 0; min-height: 100svh; background: #07080b; color: #f4f1ea; font-family: Satoshi, ui-sans-serif, sans-serif; display: grid; place-items: center; }
  main { width: min(440px, calc(100% - 32px)); padding: 28px 22px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 20px; background: rgba(255,255,255,.04); }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .sub, label { color: #b7b1a6; font-size: 13px; }
  button, input { font: inherit; }
  input { display: block; margin-top: 6px; width: 100%; box-sizing: border-box; background: #101218; color: inherit; border: 1px solid rgba(255,255,255,.15); border-radius: 10px; padding: 10px; }
  button { margin-top: 16px; height: 48px; width: 100%; border: 0; border-radius: 999px; background: var(--accent); color: #071016; font-weight: 700; }
  audio { width: 100%; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  ${body}
  <p class="sub"><a href="${origin}/privacy">Privacy</a></p>
</main>
<script src="/player/hls.min.js"></script>
<script>
const token = ${JSON.stringify(o.token)};
const expired = ${o.expired ? 'true' : 'false'};
const audio = document.getElementById('audio');
const msg = document.getElementById('msg');
async function start() {
  const code = document.getElementById('code')?.value || '';
  const r = await fetch('/d/' + encodeURIComponent(token) + '/play', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const data = await r.json();
  if (!r.ok) { msg.textContent = data.message || 'This link is personal.'; return; }
  const src = data.playlistUrl;
  if (window.Hls && window.Hls.isSupported()) { const h = new window.Hls(); h.loadSource(src); h.attachMedia(audio); }
  else audio.src = data.audioUrl || src;
  await audio.play();
  const send = (event, positionMs) => fetch('/d/' + encodeURIComponent(token) + '/event', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, positionMs, slug: data.slug }) });
  audio.addEventListener('playing', () => send('start', Math.round(audio.currentTime * 1000)), { once: true });
}
document.getElementById('play')?.addEventListener('click', () => start().catch((e) => { msg.textContent = String(e); }));
document.getElementById('ask')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  const r = await fetch('/d/' + encodeURIComponent(token) + '/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  msg.textContent = r.ok ? 'Request sent.' : 'Could not send the request.';
});
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const hits = new Map<string, number[]>();
export function clearRateLimit() {
  hits.clear();
}
export function allowRequest(ip: string, now: number, limit = 60, windowMs = 60_000): boolean {
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(ip, arr);
    return false;
  }
  arr.push(now);
  hits.set(ip, arr);
  return true;
}

export class ListenStore {
  drops: DropRecord[] = [];
  devices: DeviceRecord[] = [];
  events: ListenEventRecord[] = [];
  requests: AccessRequest[] = [];
  /** contentHash → når objektet sist ble sett i en drop. */
  objectSeen = new Map<string, string>();

  toJSON() {
    return { drops: this.drops, devices: this.devices, events: this.events, requests: this.requests, objectSeen: [...this.objectSeen] };
  }
  static fromJSON(raw: string): ListenStore {
    const s = new ListenStore();
    const j = JSON.parse(raw) as ListenStore & { objectSeen: [string, string][] };
    s.drops = j.drops ?? [];
    s.devices = j.devices ?? [];
    s.events = j.events ?? [];
    s.requests = j.requests ?? [];
    s.objectSeen = new Map(j.objectSeen ?? []);
    return s;
  }

  async create(input: { title: string; tier: DropTier; recipient: string; expiresAt: string | null; maxDevices: number; code: string | null; items: DropItem[] }, token: string, nowIso: string): Promise<DropRecord> {
    const rec: DropRecord = {
      id: crypto.randomUUID(),
      title: input.title,
      tier: input.tier,
      recipient: input.recipient,
      expiresAt: input.expiresAt,
      maxDevices: input.maxDevices,
      codeHash: input.code ? await sha256Hex(input.code) : null,
      revokedAt: null,
      items: input.items,
      tokenHash: await sha256Hex(token),
      createdAt: nowIso
    };
    this.drops.push(rec);
    for (const it of input.items) this.objectSeen.set(it.contentHash, nowIso);
    return rec;
  }

  async byToken(token: string): Promise<DropRecord | null> {
    const hash = await sha256Hex(token);
    return this.drops.find((d) => timingSafeEqual(d.tokenHash, hash)) ?? null;
  }

  revoke(id: string, nowIso: string): boolean {
    const d = this.drops.find((x) => x.id === id);
    if (!d) return false;
    d.revokedAt = nowIso;
    return true;
  }

  status(d: DropRecord, now: number): 'ok' | 'revoked' | 'expired' {
    if (d.revokedAt) return 'revoked';
    if (d.expiresAt && Date.parse(d.expiresAt) <= now) return 'expired';
    return 'ok';
  }

  /** Teller en enhet. Roboter teller aldri. */
  async beginPlay(d: DropRecord, deviceId: string, ua: string, code: string | null, now: number): Promise<{ ok: true; bot?: boolean } | { ok: false; reason: 'need-code' | 'device-limit' | 'revoked' | 'expired' }> {
    const st = this.status(d, now);
    if (st !== 'ok') return { ok: false, reason: st };
    if (d.codeHash && (await sha256Hex(code ?? '')) !== d.codeHash) return { ok: false, reason: 'need-code' };
    if (isPreviewBot(ua)) return { ok: true, bot: true };
    const mine = this.devices.filter((x) => x.dropId === d.id);
    const known = mine.find((x) => x.deviceId === deviceId);
    const iso = new Date(now).toISOString();
    if (known) {
      known.lastSeen = iso;
      return { ok: true };
    }
    if (mine.length >= d.maxDevices) return { ok: false, reason: 'device-limit' };
    this.devices.push({ dropId: d.id, deviceId, userAgent: ua.slice(0, 180), firstSeen: iso, lastSeen: iso });
    return { ok: true };
  }

  addEvent(e: ListenEventRecord) {
    this.events.push(e);
    if (this.events.length > 20_000) this.events.splice(0, this.events.length - 20_000);
  }

  requestAccess(dropId: string, name: string, nowIso: string): AccessRequest {
    const rec: AccessRequest = { id: crypto.randomUUID(), dropId, name: name.slice(0, 80), at: nowIso, status: 'open' };
    this.requests.push(rec);
    return rec;
  }

  /** Lyttelogger eldre enn 180 dager. */
  purgeOldEvents(now: number): number {
    const cutoff = now - 180 * 24 * 60 * 60 * 1000;
    const keep = this.events.filter((e) => Date.parse(e.at) >= cutoff);
    const n = this.events.length - keep.length;
    this.events = keep;
    return n;
  }

  /** Slett objekt-hasher som ingen levende drop bruker, etter 7 dager. */
  purgeUnused(now: number): string[] {
    const live = new Set<string>();
    for (const d of this.drops) {
      if (d.revokedAt) continue;
      if (d.expiresAt && Date.parse(d.expiresAt) <= now) continue;
      for (const it of d.items) live.add(it.contentHash);
    }
    const gone: string[] = [];
    for (const [hash, seen] of this.objectSeen) {
      if (live.has(hash)) continue;
      if (now - Date.parse(seen) >= 7 * 24 * 60 * 60 * 1000) {
        this.objectSeen.delete(hash);
        gone.push(hash);
      }
    }
    return gone;
  }
}

export interface ListenEnv {
  adminToken: string;
  signingSecret: string;
  origin: string;
  now?: () => number;
  ratePerMinute?: number;
}

/** Kopi som ArrayBuffer. Uint8Array<ArrayBufferLike> er ikke BodyInit i nyere @types/node. */
function bodyBytes(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

export async function handleListenRequest(req: Request, store: ListenStore, blobs: BlobStore, env: ListenEnv): Promise<Response> {
  const now = env.now?.() ?? Date.now();
  const url = new URL(req.url);
  const origin = env.origin.replace(/\/$/, '');
  if (url.pathname === '/privacy' && req.method === 'GET') {
    return new Response(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Privacy · Groovehouse Records</title><body><main><h1>Privacy</h1><p>A listen link is personal. Playback events (start, progress, finish) are stored so the sender can see that the link was used. They are deleted after 180 days. No account is required.</p></main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=86400' } }
    );
  }
  if ((url.pathname.startsWith('/d/') || url.pathname.startsWith('/admin/')) && !allowRequest(clientIp(req), now, env.ratePerMinute ?? 60)) return json(429, { error: 'rate' });

  const admin = url.pathname.startsWith('/admin/');
  if (admin) {
    const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!env.adminToken || !timingSafeEqual(got, env.adminToken)) return json(401, { error: 'unauthorized' });
  }

  if (url.pathname === '/admin/drops' && req.method === 'POST') {
    const b = (await req.json()) as { title?: string; tier?: DropTier; recipient?: string; expiresAt?: string | null; maxDevices?: number; code?: string | null; items?: DropItem[] };
    if (!b.recipient?.trim() || !b.title?.trim() || !Array.isArray(b.items) || !b.items.length) return json(400, { error: 'mangler mottaker, tittel eller låter' });
    const token = randomToken();
    const rec = await store.create(
      {
        title: b.title.trim().slice(0, 120),
        tier: b.tier ?? 'partner',
        recipient: b.recipient.trim().slice(0, 80),
        expiresAt: b.expiresAt ?? null,
        maxDevices: Math.min(10, Math.max(1, b.maxDevices ?? 2)),
        code: b.code ?? null,
        items: b.items
      },
      token,
      new Date(now).toISOString()
    );
    return json(201, { id: rec.id, token, url: `${origin}/d/${token}` });
  }

  const obj = url.pathname.match(/^\/admin\/objects\/([a-f0-9]{64})\/(.+)$/);
  if (obj && req.method === 'PUT') {
    const key = `${obj[1]}/${obj[2]}`;
    const already = await blobs.get(key);
    if (already) return json(200, { already: true });
    const body = new Uint8Array(await req.arrayBuffer());
    await blobs.put(key, body, req.headers.get('content-type') || 'application/octet-stream');
    store.objectSeen.set(obj[1]!, new Date(now).toISOString());
    return json(201, { already: false });
  }

  const rev = url.pathname.match(/^\/admin\/drops\/([0-9a-f-]{36})\/revoke$/);
  if (rev && req.method === 'POST') {
    if (!store.revoke(rev[1]!, new Date(now).toISOString())) return json(404, { error: 'ukjent' });
    return json(200, { ok: true });
  }

  if (url.pathname === '/admin/access-requests' && req.method === 'GET') return json(200, { requests: store.requests.filter((r) => r.status === 'open') });

  const approve = url.pathname.match(/^\/admin\/access-requests\/([0-9a-f-]{36})\/approve$/);
  if (approve && req.method === 'POST') {
    const ask = store.requests.find((r) => r.id === approve[1]);
    if (!ask) return json(404, { error: 'ukjent' });
    const src = store.drops.find((d) => d.id === ask.dropId);
    if (!src) return json(404, { error: 'ukjent drop' });
    ask.status = 'approved';
    const token = randomToken();
    const rec = await store.create(
      { title: src.title, tier: src.tier, recipient: ask.name, expiresAt: null, maxDevices: src.maxDevices, code: null, items: src.items },
      token,
      new Date(now).toISOString()
    );
    return json(200, { id: rec.id, token, url: `${origin}/d/${token}` });
  }

  if (url.pathname === '/admin/purge' && req.method === 'POST') {
    const gone = store.purgeUnused(now);
    const eventsRemoved = store.purgeOldEvents(now);
    for (const hash of gone) for (const key of await blobs.keys()) if (key.startsWith(`${hash}/`)) await blobs.delete(key);
    return json(200, { deleted: gone, eventsRemoved });
  }

  const page = url.pathname.match(/^\/d\/([0-9A-Za-z]{16,32})(?:\/(.*))?$/);
  if (!page) return json(404, { error: 'not found' });
  const token = page[1]!;
  const rest = page[2] ?? '';
  const drop = await store.byToken(token);
  if (!drop) return json(404, { error: 'unknown' });
  const item = drop.items[0]!;

  if (rest === '' && req.method === 'GET') {
    const expired = store.status(drop, now) !== 'ok';
    const coverExp = now + 180 * 24 * 60 * 60 * 1000;
    const coverSig = await signPath(env.signingSecret, drop.id, 'cover.jpg', coverExp);
    const image = `${origin}/d/${token}/cover.jpg?exp=${coverExp}&sig=${encodeURIComponent(coverSig)}`;
    return new Response(listenPageHtml({ origin, token, title: item.title, artist: item.artist, recipient: drop.recipient, needsCode: !!drop.codeHash, expired, image, accent: '#06B211' }), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  if (rest === 'play' && req.method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as { code?: string };
    const deviceId = req.headers.get('cookie')?.match(/(?:^|;\s*)gv_listen=([0-9a-f-]{36})/)?.[1] ?? crypto.randomUUID();
    const play = await store.beginPlay(drop, deviceId, req.headers.get('user-agent') ?? '', b.code ?? null, now);
    if (!play.ok) {
      const message = play.reason === 'device-limit' ? 'This link is personal – ask Knut for your own.' : play.reason === 'need-code' ? 'Enter the code from the message.' : play.reason === 'expired' ? 'This link has expired.' : 'This link no longer works.';
      return json(play.reason === 'need-code' ? 401 : 403, { error: play.reason, message });
    }
    if (play.bot) return json(200, { bot: true });
    const exp = now + SEGMENT_TTL_MS;
    const playlistUrl = `${origin}/d/${token}/index.m3u8?exp=${exp}&sig=${encodeURIComponent(await signPath(env.signingSecret, drop.id, 'index.m3u8', exp, deviceId))}`;
    const audioUrl = `${origin}/d/${token}/file/audio.m4a?exp=${exp}&sig=${encodeURIComponent(await signPath(env.signingSecret, drop.id, 'audio.m4a', exp, deviceId))}`;
    return json(200, { playlistUrl, audioUrl, slug: item.slug, deviceId }, { 'set-cookie': `gv_listen=${deviceId}; HttpOnly; Secure; SameSite=Lax; Path=/d/${token}; Max-Age=31536000` });
  }

  if (rest === 'access' && req.method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as { name?: string };
    if (!b.name?.trim()) return json(400, { error: 'name' });
    store.requestAccess(drop.id, b.name.trim(), new Date(now).toISOString());
    return json(201, { ok: true });
  }

  if (rest === 'event' && req.method === 'POST') {
    const deviceId = req.headers.get('cookie')?.match(/(?:^|;\s*)gv_listen=([0-9a-f-]{36})/)?.[1];
    if (!deviceId || !store.devices.some((d) => d.dropId === drop.id && d.deviceId === deviceId)) return json(403, { error: 'device' });
    const b = (await req.json()) as { event?: ListenEventName; positionMs?: number; slug?: string };
    if (!b.event || !['start', '30s', '50', 'done', 'seek'].includes(b.event)) return json(400, { error: 'event' });
    store.addEvent({ dropId: drop.id, deviceId, slug: b.slug || item.slug, event: b.event, positionMs: Math.max(0, Math.round(b.positionMs ?? 0)), at: new Date(now).toISOString() });
    return new Response(null, { status: 204 });
  }

  const file = rest.match(/^(?:index\.m3u8|file\/(.+)|cover\.jpg)$/);
  if (file && req.method === 'GET') {
    if (store.status(drop, now) !== 'ok') return json(403, { error: 'revoked' });
    const path = rest === 'index.m3u8' ? 'index.m3u8' : rest === 'cover.jpg' ? 'cover.jpg' : file[1]!;
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    const cookieDevice = req.headers.get('cookie')?.match(/(?:^|;\s*)gv_listen=([0-9a-f-]{36})/i)?.[1] ?? '';
    const boundDevice = path === 'cover.jpg' ? '' : cookieDevice;
    if (path !== 'cover.jpg' && !store.devices.some((d) => d.dropId === drop.id && d.deviceId === cookieDevice)) return json(403, { error: 'device' });
    if (!(await verifyPath(env.signingSecret, drop.id, path, exp, sig, now, boundDevice))) return json(403, { error: 'signature' });
    const hash = item.contentHash;
    const objKey = `${hash}/${path}`;
    const blob = await blobs.get(objKey);
    if (!blob) return json(404, { error: 'missing' });
    if (path === 'index.m3u8') {
      const text = new TextDecoder().decode(blob.body);
      const signed = new Map<string, string>();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const segExp = now + SEGMENT_TTL_MS;
        const segSig = await signPath(env.signingSecret, drop.id, t, segExp, cookieDevice);
        signed.set(t, `${origin}/d/${token}/file/${t}?exp=${segExp}&sig=${encodeURIComponent(segSig)}`);
      }
      const out = rewritePlaylist(text, (seg) => signed.get(seg) ?? seg);
      return new Response(out, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } });
    }
    return new Response(bodyBytes(blob.body), { status: 200, headers: { 'content-type': blob.contentType, 'cache-control': 'private, max-age=300' } });
  }

  return json(404, { error: 'not found' });
}
