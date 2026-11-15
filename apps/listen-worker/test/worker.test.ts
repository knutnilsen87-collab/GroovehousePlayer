import { describe, expect, it } from 'vitest';
import worker from '../src/index';

describe('worker', () => {
  it('avviser admin uten token', async () => {
    const res = await worker.fetch(new Request('https://listen.groovehouserecords.com/admin/drops', { method: 'POST' }), { ADMIN_TOKEN: 'x', SIGNING_SECRET: 'y' });
    expect(res.status).toBe(401);
  });
});
