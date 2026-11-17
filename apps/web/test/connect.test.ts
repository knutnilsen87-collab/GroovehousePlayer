import { describe, expect, it } from 'vitest';
import { explainAddress, explainHealth, explainPair } from '../src/lib/connectErrors';
import { normalizeServer } from '../src/lib/connection';

/** Del 27 pkt. 3: mobilparing med feil adresse, feil PIN, avslått PC og avbrutt nett. */
const TS = 'https://pc.tail1234.ts.net';

describe('tilkobling: forklaringer', () => {
  it('feil adresse: tom, http eller tull', () => {
    expect(explainAddress('', normalizeServer(''))?.problem).toBe('bad-address');
    expect(explainAddress('http://192.168.1.5:41733', normalizeServer('http://192.168.1.5:41733'))?.title).toMatch(/HTTPS/);
    expect(explainAddress('pc navn', normalizeServer('pc navn'))?.problem).toBe('bad-address');
    expect(explainAddress('pc.tail1234.ts.net', normalizeServer('pc.tail1234.ts.net'))).toBeNull();
  });

  it('avslått PC eller Tailscale av: får ikke kontakt, med Tailscale først', () => {
    const h = explainHealth(TS, { kind: 'network-error', online: true, timedOut: true })!;
    expect(h.problem).toBe('unreachable');
    expect(h.title).toMatch(/svarer ikke/);
    expect(h.help.join(' ')).toMatch(/Tailscale/);
    expect(h.step).toBe(1);
  });

  it('adresse som ikke er Tailscale: peker på adressen', () => {
    const h = explainHealth('https://example.com', { kind: 'network-error', online: true, timedOut: false })!;
    expect(h.step).toBe(2);
    expect(h.help.join(' ')).toMatch(/\.ts\.net/);
  });

  it('avbrutt nett: egen tekst, både før og under paringen', () => {
    expect(explainHealth(TS, { kind: 'network-error', online: false, timedOut: false })?.problem).toBe('offline');
    expect(explainPair({ kind: 'network-error', online: false }).problem).toBe('offline');
    expect(explainPair({ kind: 'network-error', online: true }).problem).toBe('interrupted');
  });

  it('PC-en på, Vault ikke startet (Tailscale Serve svarer 502)', () => {
    expect(explainHealth(TS, { kind: 'response', status: 502, body: null })?.problem).toBe('vault-down');
  });

  it('421 Misdirected request: adressen er ikke godkjent', () => {
    const h = explainHealth(TS, { kind: 'response', status: 421, body: 'Misdirected request' })!;
    expect(h.problem).toBe('misdirected');
    expect(h.title).toMatch(/421/);
  });

  it('noe annet svarer på adressen', () => {
    expect(explainHealth(TS, { kind: 'response', status: 200, body: { app: 'noe-annet' } })?.problem).toBe('not-vault');
    expect(explainHealth(TS, { kind: 'response', status: 404, body: null })?.problem).toBe('not-vault');
    expect(explainHealth(TS, { kind: 'response', status: 200, body: { app: 'groovehouse-vault' } })).toBeNull();
  });

  it('feil PIN, for mange forsøk og ingen PIN på PC-en', () => {
    const wrong = explainPair({ kind: 'response', status: 401, error: 'Feil PIN-kode.' });
    expect(wrong.problem).toBe('wrong-pin');
    expect(wrong.step).toBe(3);
    expect(explainPair({ kind: 'response', status: 429, error: 'For mange forsøk. Prøv igjen om 5 min.' }).help[0]).toMatch(/5 min/);
    expect(explainPair({ kind: 'response', status: 409 }).problem).toBe('no-pin');
  });

  it('forklaringene inneholder aldri PIN-en', () => {
    const all = [explainPair({ kind: 'response', status: 401, error: 'Feil PIN-kode.' }), explainPair({ kind: 'response', status: 500, error: 'x' })];
    for (const h of all) expect(JSON.stringify(h)).not.toMatch(/123456/);
  });
});
