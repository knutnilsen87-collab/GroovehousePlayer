import { describe, expect, it } from 'vitest';
import { pollAccessRequests } from '../src/listen-poll';

describe('varsel om ny lyttelenke', () => {
  it('varsler én gang per åpen forespørsel', async () => {
    const seen = new Set<string>();
    const notes: string[] = [];
    const fetchImpl = async () => new Response(JSON.stringify({ requests: [{ id: 'a', name: 'Jorrit', dropId: 'd' }] }), { status: 200 });
    const opts = {
      baseUrl: 'https://listen.groovehouserecords.com/',
      token: 't',
      seen,
      notify: (_t: string, b: string) => notes.push(b),
      fetchImpl
    };
    expect(await pollAccessRequests(opts)).toBe(1);
    expect(notes[0]).toContain('Jorrit');
    expect(await pollAccessRequests(opts)).toBe(0);
    expect(notes).toHaveLength(1);
  });

  it('feil fra tjenesten kaster og varsler ikke', async () => {
    const notes: string[] = [];
    await expect(
      pollAccessRequests({
        baseUrl: 'https://listen.groovehouserecords.com',
        token: 't',
        seen: new Set(),
        notify: () => notes.push('x'),
        fetchImpl: async () => new Response('no', { status: 503 })
      })
    ).rejects.toThrow(/503/);
    expect(notes).toHaveLength(0);
  });
});
