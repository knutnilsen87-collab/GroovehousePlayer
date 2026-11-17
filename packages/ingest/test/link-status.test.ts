import { afterEach, describe, expect, it } from 'vitest';
import { linkServiceStatus } from '../src/drops-api';

/** Del 27 pkt. 10: si aldri at lenketjenesten er nede uten å ha sjekket. */
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('linkServiceStatus', () => {
  it('ikke satt opp: sier det, uten å kontakte noe', async () => {
    delete process.env.LISTEN_ADMIN_URL;
    let called = false;
    const r = await linkServiceStatus((async () => ((called = true), new Response(''))) as typeof fetch);
    expect(r).toMatchObject({ available: false, reason: 'unconfigured' });
    expect(called).toBe(false);
  });
  it('satt opp og svarer: tilgjengelig', async () => {
    process.env.LISTEN_ADMIN_URL = 'https://listen.example';
    process.env.LISTEN_ADMIN_TOKEN = 'x';
    expect(await linkServiceStatus((async () => new Response('', { status: 404 })) as typeof fetch)).toEqual({ available: true });
  });
  it('satt opp, men svarer ikke eller med 5xx: «akkurat nå», målt', async () => {
    process.env.LISTEN_ADMIN_URL = 'https://listen.example';
    process.env.LISTEN_ADMIN_TOKEN = 'x';
    const down = await linkServiceStatus((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect(down).toMatchObject({ available: false, reason: 'unreachable' });
    expect(await linkServiceStatus((async () => new Response('', { status: 503 })) as typeof fetch)).toMatchObject({ available: false, reason: 'unreachable' });
  });
  it('svaret inneholder aldri adresse eller token', async () => {
    process.env.LISTEN_ADMIN_URL = 'https://hemmelig.example';
    process.env.LISTEN_ADMIN_TOKEN = 'tok-123';
    const r = await linkServiceStatus((async () => new Response('', { status: 500 })) as typeof fetch);
    expect(JSON.stringify(r)).not.toMatch(/hemmelig|tok-123/);
  });
});
