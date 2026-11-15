import { describe, expect, it } from 'vitest';
import { allowRequest, clearRateLimit, handleListenRequest, isPreviewBot, ListenStore, MemoryBlobs, randomToken, rewritePlaylist, sha256Hex, verifyPath } from '../src/listen';

const env = { adminToken: 'adm-test-token', signingSecret: 'sign-test', origin: 'https://listen.groovehouserecords.com', now: () => Date.parse('2026-11-15T12:00:00.000Z') };
const item = { slug: 'blue-fire', variant: 'main', version: 2, title: 'Blue Fire', artist: 'Echo Groove', durationMs: 180_000, contentHash: 'a'.repeat(64) };

async function admin(path: string, method: string, body?: unknown, raw?: Uint8Array, type?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${env.adminToken}` };
  let payload: BodyInit | undefined;
  if (raw) {
    headers['content-type'] = type ?? 'application/octet-stream';
    const ab = new ArrayBuffer(raw.byteLength);
    new Uint8Array(ab).set(raw);
    payload = ab;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return handleListenRequest(new Request(`https://listen.groovehouserecords.com${path}`, { method, headers, body: payload }), store, blobs, env);
}

let store: ListenStore;
let blobs: MemoryBlobs;

async function setup() {
  clearRateLimit();
  store = new ListenStore();
  blobs = new MemoryBlobs();
}

describe('lytterlenker', () => {
  it('token hashes, og-tagger, og roboter teller ikke som enhet', async () => {
    await setup();
    expect(isPreviewBot('WhatsApp/2.1')).toBe(true);
    expect(randomToken().length).toBeGreaterThanOrEqual(22);
    const created = await admin('/admin/drops', 'POST', { title: 'Blue Fire', recipient: 'Jorrit', items: [item], maxDevices: 2 });
    const made = (await created.json()) as { token: string; url: string; id: string };
    expect(made.url).toBe(`https://listen.groovehouserecords.com/d/${made.token}`);
    expect(JSON.stringify(store.toJSON())).not.toContain(made.token);
    expect(store.drops[0]!.tokenHash).toBe(await sha256Hex(made.token));

    const page = await handleListenRequest(new Request(made.url, { headers: { 'user-agent': 'WhatsApp/2.1' } }), store, blobs, env);
    const html = await page.text();
    expect(html).toContain('og:title');
    expect(html).toContain('/privacy');
    expect(html).toContain('Echo Groove – Blue Fire');
    expect(html).toContain('Private listen · Groovehouse Records');
    expect(html).not.toMatch(/ts\.net|10\.0\.0\.|127\.0\.0\.1/);
    expect(store.devices).toHaveLength(0);

    const botPlay = await handleListenRequest(new Request(`${made.url}/play`, { method: 'POST', headers: { 'user-agent': 'WhatsApp/2.1', 'content-type': 'application/json' }, body: '{}' }), store, blobs, env);
    expect((await botPlay.json()).bot).toBe(true);
    expect(store.devices).toHaveLength(0);
  });

  it('tredje enhet blokkeres, signerte segmenter utløper, og tilbaketrekking stopper neste segment', async () => {
    await setup();
    const created = await (await admin('/admin/drops', 'POST', { title: 'Blue Fire', recipient: 'Jorrit', items: [item], maxDevices: 2 })).json() as { token: string; id: string };
    const playlist = '#EXTM3U\n#EXTINF:6,\nseg_00000.ts\n';
    expect((await admin(`/admin/objects/${item.contentHash}/index.m3u8`, 'PUT', undefined, new TextEncoder().encode(playlist), 'application/vnd.apple.mpegurl')).status).toBe(201);
    expect(await (await admin(`/admin/objects/${item.contentHash}/index.m3u8`, 'PUT', undefined, new TextEncoder().encode('annen'), 'application/vnd.apple.mpegurl')).json()).toMatchObject({ already: true });
    expect(new TextDecoder().decode((await blobs.get(`${item.contentHash}/index.m3u8`))!.body)).toBe(playlist);
    await admin(`/admin/objects/${item.contentHash}/seg_00000.ts`, 'PUT', undefined, new Uint8Array([1, 2, 3]), 'video/mp2t');
    await admin(`/admin/objects/${item.contentHash}/audio.m4a`, 'PUT', undefined, new Uint8Array([4]), 'audio/mp4');

    const play = async (cookie?: string) => {
      const r = await handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', ...(cookie ? { cookie } : {}) }, body: '{}' }), store, blobs, env);
      return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie') };
    };
    const one = await play();
    const two = await play();
    const three = await play();
    expect(one.status).toBe(200);
    expect(one.cookie).toContain('HttpOnly');
    expect(one.cookie).toContain('Secure');
    expect(two.status).toBe(200);
    expect(three.status).toBe(403);
    expect(three.json.message).toContain('personal');

    const cookie = `gv_listen=${one.json.deviceId}`;
    const list = await handleListenRequest(new Request(one.json.playlistUrl, { headers: { cookie } }), store, blobs, env);
    const body = await list.text();
    expect(body).toContain('/file/seg_00000.ts?exp=');
    expect(rewritePlaylist('#EXTM3U\nseg_00000.ts\n', (s) => `ok/${s}`)).toBe('#EXTM3U\nok/seg_00000.ts\n');
    const seg = body.split('\n').find((l) => l.includes('seg_00000.ts'))!;
    const segUrl = new URL(seg);
    expect((await handleListenRequest(new Request(seg), store, blobs, env)).status).toBe(403);
    expect((await handleListenRequest(new Request(seg, { headers: { cookie } }), store, blobs, env)).status).toBe(200);
    const stale = new URL(seg);
    stale.searchParams.set('exp', String(env.now() - 1));
    expect((await handleListenRequest(new Request(stale, { headers: { cookie } }), store, blobs, env)).status).toBe(403);
    const other = await (await admin('/admin/drops', 'POST', { title: 'Annen', recipient: 'Ann', items: [item] })).json() as { token: string };
    const stolen = `https://listen.groovehouserecords.com/d/${other.token}/file/seg_00000.ts?${segUrl.searchParams}`;
    expect((await handleListenRequest(new Request(stolen, { headers: { cookie } }), store, blobs, env)).status).toBe(403);

    expect((await admin(`/admin/drops/${created.id}/revoke`, 'POST')).status).toBe(200);
    expect((await handleListenRequest(new Request(seg, { headers: { cookie } }), store, blobs, env)).status).toBe(403);
    expect(await verifyPath(env.signingSecret, created.id, 'seg_00000.ts', env.now() + 1000, 'feil', env.now())).toBe(false);
  });

  it('utløpt lenke kan be om ny tilgang, og ubrukte filer slettes etter 7 dager', async () => {
    await setup();
    const created = await (await admin('/admin/drops', 'POST', { title: 'Blue Fire', recipient: 'Jorrit', items: [item], expiresAt: '2026-11-15T11:00:00.000Z' })).json() as { token: string; id: string };
    const page = await handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}`), store, blobs, env);
    expect(await page.text()).toContain('This link has expired');
    expect((await handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Jorrit' }) }), store, blobs, env)).status).toBe(201);
    const open = await admin('/admin/access-requests', 'GET');
    const id = ((await open.json()) as { requests: { id: string }[] }).requests[0]!.id;
    const approved = await (await admin(`/admin/access-requests/${id}/approve`, 'POST')).json() as { url: string; token: string; id: string };
    expect(approved.url).toContain('/d/');
    expect(JSON.stringify(store.toJSON())).not.toContain(approved.token);

    const orphan = 'b'.repeat(64);
    store.objectSeen.set(item.contentHash, '2026-11-01T00:00:00.000Z');
    store.objectSeen.set(orphan, '2026-11-01T00:00:00.000Z');
    await blobs.put(`${item.contentHash}/a`, new Uint8Array([1]), 'application/octet-stream');
    await blobs.put(`${orphan}/a`, new Uint8Array([2]), 'application/octet-stream');
    store.addEvent({ dropId: created.id, deviceId: '11111111-1111-1111-1111-111111111111', slug: item.slug, event: 'start', positionMs: 0, at: '2026-01-01T00:00:00.000Z' });
    store.addEvent({ dropId: created.id, deviceId: '11111111-1111-1111-1111-111111111111', slug: item.slug, event: 'done', positionMs: 1, at: '2026-11-15T12:00:00.000Z' });
    const kept = await (await admin('/admin/purge', 'POST')).json() as { deleted: string[] };
    expect(kept.deleted).toContain(orphan);
    expect(kept.deleted).not.toContain(item.contentHash);
    expect(await blobs.get(`${orphan}/a`)).toBeNull();
    expect(await blobs.get(`${item.contentHash}/a`)).not.toBeNull();
    expect(store.events).toHaveLength(1);

    store.revoke(created.id, '2026-11-01T00:00:00.000Z');
    store.revoke(approved.id, '2026-11-01T00:00:00.000Z');
    const purged = await (await admin('/admin/purge', 'POST')).json() as { deleted: string[] };
    expect(purged.deleted).toContain(item.contentHash);
    expect(await blobs.get(`${item.contentHash}/a`)).toBeNull();
  });

  it('kode kreves bare når den er satt, og rate limit stopper flom', async () => {
    await setup();
    const created = await (await admin('/admin/drops', 'POST', { title: 'Blue Fire', recipient: 'Jorrit', items: [item], code: '1234' })).json() as { token: string };
    const no = await handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: '{}' }), store, blobs, env);
    expect(no.status).toBe(401);
    const yes = await handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}/play`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ code: '1234' }) }), store, blobs, env);
    expect(yes.status).toBe(200);
    expect(allowRequest('1.2.3.4', 1_000, 2)).toBe(true);
    expect(allowRequest('1.2.3.4', 1_000, 2)).toBe(true);
    expect(allowRequest('1.2.3.4', 1_000, 2)).toBe(false);
    const flood = handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}`, { headers: { 'cf-connecting-ip': '9.9.9.9' } }), store, blobs, { ...env, ratePerMinute: 1 });
    expect((await flood).status).toBe(200);
    expect((await handleListenRequest(new Request(`https://listen.groovehouserecords.com/d/${created.token}`, { headers: { 'cf-connecting-ip': '9.9.9.9' } }), store, blobs, { ...env, ratePerMinute: 1 })).status).toBe(429);
    expect((await admin('/admin/drops', 'POST', {})).status).not.toBe(401);
    expect((await handleListenRequest(new Request('https://listen.groovehouserecords.com/admin/drops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), store, blobs, env)).status).toBe(401);
  });
});
