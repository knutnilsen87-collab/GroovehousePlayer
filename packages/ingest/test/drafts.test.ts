import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preferredVersion, type AssetManifest, type CatalogIndex } from '@gv/shared';
import { createApiHandler } from '../src/api';
import { DEFAULTS, type VaultConfig } from '../src/config';
import { FFMPEG, run } from '../src/ffmpeg';
import { ingestRelease } from '../src/ingest';
import { measureLoudness } from '../src/encode';
import { scanDrafts, scanFlat } from '../src/sources';

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = { ...DEFAULTS, exportDir: null };

/** Hash av alle filer i en mappe (for å bevise at kildemappene aldri endres). */
const snapshot = (dir: string) => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
};

describe.skipIf(!hasFfmpeg)('utkast (del 16, krever ffmpeg)', () => {
  let tmp: string;
  let releaseDir: string;
  let draftDir: string;
  let mediaDir: string;
  let server: http.Server;
  let base: string;
  let before: { rel: string; draft: string };

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gv-drafts-'));
    releaseDir = path.join(tmp, 'REASONDONE');
    draftDir = path.join(tmp, 'Utkast');
    mediaDir = path.join(tmp, 'media');
    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.join(draftDir, 'Prosjekt A'), { recursive: true });
    // Utkast: svakt (−30 dB) – loudnorm skal løfte HLS-en til målnivået, masteren skal være uendret
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=12', '-af', 'volume=-30dB', '-ac', '2', path.join(draftDir, 'Prosjekt A', 'Night Drive_v3.wav')]);
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=10', '-af', 'volume=-28dB', '-ac', '2', path.join(draftDir, 'Bare Utkast.wav')]);
    // Release (master) av samme låt
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=12', '-af', 'volume=-6dB', '-ac', '2', path.join(releaseDir, 'Night Drive.wav')]);
    before = { rel: snapshot(releaseDir), draft: snapshot(draftDir) };
    const api = createApiHandler({ mediaDir, dataDir: path.join(tmp, 'data') });
    server = http.createServer((req, res) => void api(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('status fra mappa, undermapper, egne versjonsnumre og loudnorm bare på utkast', async () => {
    const scan = await scanDrafts(draftDir, cfg);
    expect(scan.releases.map((r) => r.slug).sort()).toEqual(['bare-utkast', 'night-drive']);
    for (const r of scan.releases) await ingestRelease(r, { mediaDir, config: cfg, status: 'draft' });
    const rel = (await scanFlat(releaseDir, cfg)).releases[0]!;
    await ingestRelease(rel, { mediaDir, config: cfg });

    const idx = JSON.parse(await readFile(path.join(mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
    const night = idx.assets.filter((a) => a.slug === 'night-drive');
    expect(night.map((a) => [a.version, a.status ?? 'release']).sort()).toEqual([
      [1, 'release'],
      [1003, 'draft']
    ]);
    // «Følg nyeste»/katalogen: release vinner over det (numerisk høyere) utkastet
    expect(preferredVersion(night)!.version).toBe(1);
    expect(preferredVersion(idx.assets.filter((a) => a.slug === 'bare-utkast'))!.status).toBe('draft');

    const draftDirOut = path.join(mediaDir, 'night-drive', 'main', 'v1003');
    const dm = JSON.parse(await readFile(path.join(draftDirOut, 'manifest.json'), 'utf8')) as AssetManifest;
    expect(dm).toMatchObject({ status: 'draft', versionLabel: 'Utkast v3' });
    expect(dm.loudness.normalizedLufs).toBe(cfg.audio.targetLufs);
    expect(dm.loudness.integratedLufs).toBeLessThan(-30); // målt originalnivå står fortsatt
    // HLS normalisert til målnivået (±1,5 LU), master.flac uendret svak
    const hls = await measureLoudness(path.join(draftDirOut, 'hls', 'index.m3u8'), cfg.audio.targetLufs);
    expect(Math.abs(hls.integratedLufs - cfg.audio.targetLufs)).toBeLessThan(1.5);
    const master = await measureLoudness(path.join(draftDirOut, 'master.flac'), cfg.audio.targetLufs);
    expect(Math.abs(master.integratedLufs - dm.loudness.integratedLufs)).toBeLessThan(0.3);
    // Release-låta normaliseres ikke
    const rm1 = JSON.parse(await readFile(path.join(mediaDir, 'night-drive', 'main', 'v1', 'manifest.json'), 'utf8')) as AssetManifest;
    expect(rm1.status).toBe('release');
    expect(rm1.loudness.normalizedLufs).toBeUndefined();

    // Kildemappene er aldri endret
    expect(snapshot(releaseDir)).toBe(before.rel);
    expect(snapshot(draftDir)).toBe(before.draft);
  }, 240_000);

  it('deling: utkast krever «Del utkast likevel» og merkes « (Utkast)» / «Groovehouse Records – Demo»', async () => {
    const url = `${base}/api/share/night-drive/main/1003?kind=full`;
    expect((await fetch(url)).status).toBe(409);
    const r = await fetch(`${url}&draft=1`);
    expect(r.status).toBe(200);
    const name = decodeURIComponent(r.headers.get('x-share-filename') ?? '');
    expect(name).toContain('(Utkast)');
    const file = path.join(tmp, 'delt.m4a');
    await import('node:fs/promises').then((f) => r.arrayBuffer().then((b) => f.writeFile(file, Buffer.from(b))));
    const tags = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags=title,album', '-of', 'json', file], { encoding: 'utf8' }).stdout;
    expect(tags).toContain('Groovehouse Records – Demo');
    expect(tags).toContain('Night Drive (Utkast)');
    // Release-versjonen deles som før
    expect((await fetch(`${base}/api/share/night-drive/main/1?kind=preview`)).status).toBe(200);
  }, 120_000);

  it('importer som utkast: til data/drafts-inbox, bare lyd/bilder, krever X-GV-Import', async () => {
    const body = readFileSync(path.join(draftDir, 'Bare Utkast.wav'));
    expect((await fetch(`${base}/api/drafts/import?name=Ny.wav`, { method: 'POST', body })).status).toBe(400);
    expect((await fetch(`${base}/api/drafts/import?name=virus.exe`, { method: 'POST', headers: { 'X-GV-Import': '1' }, body })).status).toBe(400);
    // Stier ut av innboksen avvises (../ blir «.._.._x.wav», som ikke godtas)
    expect((await fetch(`${base}/api/drafts/import?name=..%2F..%2Fx.wav`, { method: 'POST', headers: { 'X-GV-Import': '1' }, body })).status).toBe(400);
    expect(existsSync(path.join(tmp, 'data', 'x.wav')) || existsSync(path.join(tmp, 'x.wav'))).toBe(false);
    expect((await fetch(`${base}/api/drafts/import?name=a%2Fb.wav`, { method: 'POST', headers: { 'X-GV-Import': '1' }, body })).status).toBe(201);
    expect(existsSync(path.join(tmp, 'data', 'drafts-inbox', 'a_b.wav'))).toBe(true);
    expect((await fetch(`${base}/api/drafts/import?name=Ny%20Idé.wav`, { method: 'POST', headers: { 'X-GV-Import': '1' }, body })).status).toBe(201);
    expect(readFileSync(path.join(tmp, 'data', 'drafts-inbox', 'Ny Idé.wav')).equals(body)).toBe(true);
    expect((await fetch(`${base}/api/drafts/import?name=a.wav`, { method: 'POST', headers: { 'X-GV-Import': '1', referer: 'http://x/drop/y' }, body })).status).toBe(403);
  });

  it('gjør release-klar: bare eksplisitt med bekreftelse', async () => {
    const u = `${base}/api/assets/bare-utkast/main/v1001/status`;
    expect((await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'release' }) })).status).toBe(400);
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'release', confirm: true }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { manifest: AssetManifest }).manifest.status).toBe('release');
    const idx = JSON.parse(await readFile(path.join(mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
    expect(idx.assets.find((a) => a.slug === 'bare-utkast')!.status).toBeUndefined(); // release
  });

  it('spillelister: type Album-plan / Sett-plan', async () => {
    const created = (await (await fetch(`${base}/api/playlists`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Album 1', plan: 'album' }) })).json()) as { playlist: { id: string; plan: string; updatedAt: string } };
    expect(created.playlist.plan).toBe('album');
    const p = await fetch(`${base}/api/playlists/${created.playlist.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updatedAt: created.playlist.updatedAt, plan: 'set' }) });
    expect(((await p.json()) as { playlist: { plan: string } }).playlist.plan).toBe('set');
    const bad = await fetch(`${base}/api/playlists`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', plan: 'ep' }) });
    expect(bad.status).toBe(400);
  });
});
