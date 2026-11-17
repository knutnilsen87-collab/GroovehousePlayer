import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** DoD A: vault:restore henter data/ og media/ fra en backup, rydder bort det som ikke finnes der, og kontrollerer resultatet. */
const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'vault-restore.mjs');
const tmp = mkdtempSync(path.join(tmpdir(), 'gv-restore-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const put = (p: string, s: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};
const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });

describe.runIf(process.platform === 'win32')('vault:restore', { timeout: 60_000 }, () => {
  const backup = path.join(tmp, 'backup');
  const target = path.join(tmp, 'gjenopprettet');
  beforeAll(() => {
    put(path.join(backup, 'data', 'playlists.json'), JSON.stringify({ playlists: [{ id: 'a', name: 'Test' }] }));
    put(path.join(backup, 'data', 'lyrics', 'blue-fire.words.json'), '[]');
    put(path.join(backup, 'media', 'index.json'), JSON.stringify({ schema: 1, assets: [{ slug: 'blue-fire' }] }));
    put(path.join(backup, 'media', 'blue-fire', 'main', 'v1', 'master.flac'), 'lyd');
    put(path.join(backup, 'groovehouse.local.json'), '{}');
  });

  it('henter alt tilbake og kontrollerer det (0 forskjeller, JSON like)', () => {
    // Målet har en ødelagt indeks og en fil som ikke finnes i backupen
    put(path.join(target, 'media', 'index.json'), 'ødelagt');
    put(path.join(target, 'data', 'rest.json'), '{}');
    const r = run('--from', backup, '--to', target);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/0 forskjeller/);
    expect(readFileSync(path.join(target, 'media', 'index.json'), 'utf8')).toBe(readFileSync(path.join(backup, 'media', 'index.json'), 'utf8'));
    expect(existsSync(path.join(target, 'media', 'blue-fire', 'main', 'v1', 'master.flac'))).toBe(true);
    expect(existsSync(path.join(target, 'data', 'rest.json'))).toBe(false);
    expect(existsSync(path.join(target, 'groovehouse.local.json'))).toBe(true);
  });

  it('--dry endrer ingenting', () => {
    put(path.join(target, 'media', 'index.json'), 'endret igjen');
    const r = run('--from', backup, '--to', target, '--dry');
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(target, 'media', 'index.json'), 'utf8')).toBe('endret igjen');
  });

  it('nekter når backupen mangler eller er samme mappe som målet', () => {
    expect(run('--from', path.join(tmp, 'finnes-ikke'), '--to', target).status).not.toBe(0);
    expect(run('--from', backup, '--to', backup).status).not.toBe(0);
  });

  it('backupen er uendret etterpå (leses bare)', () => {
    expect(readFileSync(path.join(backup, 'media', 'blue-fire', 'main', 'v1', 'master.flac'), 'utf8')).toBe('lyd');
  });
});
