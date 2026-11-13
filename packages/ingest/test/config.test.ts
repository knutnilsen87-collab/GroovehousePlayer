import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, normalizeHost, setAllowedHost } from '../src/config';

describe('allowedHosts', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'gv-config-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('godtar bare eksakte vertsnavn', () => {
    expect(normalizeHost('PC.Tail1234.ts.net.')).toBe('pc.tail1234.ts.net');
    for (const bad of ['*.ts.net', '*', 'ts', '10.0.0.47', 'pc.ts.net:443', 'http://pc.ts.net', '', ' ', 'a..b', '-a.b', null, 42])
      expect(normalizeHost(bad), String(bad)).toBeNull();
  });

  it('lokale verdier leses i tillegg, og vault:remote skriver bare til den usporede fila', async () => {
    const shared = path.join(root, 'groovehouse.config.json');
    const local = path.join(root, 'groovehouse.local.json');
    const sharedText = JSON.stringify({ ports: { server: 41733 }, lan: { enabled: true }, allowedHosts: ['*.ts.net'], defaults: { artist: 'Echo Groove' } });
    await writeFile(shared, sharedText);
    expect(loadConfig(root).allowedHosts).toEqual([]); // jokertegn ignoreres
    expect(existsSync(local)).toBe(false);

    setAllowedHost(root, 'pc.tail1234.ts.net.', true);
    setAllowedHost(root, 'pc.tail1234.ts.net', true);
    expect(await readFile(shared, 'utf8')).toBe(sharedText); // delt config er urørt
    expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({ allowedHosts: ['pc.tail1234.ts.net'] });
    const cfg = loadConfig(root);
    expect(cfg.allowedHosts).toEqual(['pc.tail1234.ts.net']);
    expect(cfg.defaults.artist).toBe('Echo Groove');
    expect(cfg.lan.enabled).toBe(true);

    // Andre lokale verdier overstyrer seksjon for seksjon, og beholdes når allowedHosts endres.
    await writeFile(local, JSON.stringify({ $comment: 'lokalt', lan: { enabled: false }, allowedHosts: ['pc.tail1234.ts.net'] }));
    expect(loadConfig(root).lan).toEqual({ enabled: false, rememberDays: 30 });
    setAllowedHost(root, 'pc.tail1234.ts.net', false);
    expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({ $comment: 'lokalt', lan: { enabled: false }, allowedHosts: [] });
    expect(loadConfig(root).allowedHosts).toEqual([]);
    expect(() => setAllowedHost(root, '*.ts.net', true)).toThrow(/Ugyldig/);
  });

  it('uten config-filer brukes standardverdiene', () => {
    expect(loadConfig(root)).toMatchObject({ ports: { server: 41733, dev: 41734 }, lan: { enabled: false }, allowedHosts: [] });
  });
});
