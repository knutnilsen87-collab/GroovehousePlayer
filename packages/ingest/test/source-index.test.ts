import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api';
import { indexSources, readSources, sourceKey, sourcesFile } from '../src/source-index';

let tmp: string;
let exportDir: string;
let mediaDir: string;
let dataDir: string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-sources-'));
  exportDir = path.join(tmp, 'REASONDONE');
  mediaDir = path.join(tmp, 'media');
  dataDir = path.join(tmp, 'data');
  await mkdir(path.join(exportDir, 'release'), { recursive: true });
  const a = Buffer.from('RIFF lyd A');
  const b = Buffer.from('RIFF lyd B');
  await writeFile(path.join(exportDir, 'Eyes on you (suno v4).wav'), a);
  await writeFile(path.join(exportDir, 'release', 'Blue Fire_v2.wav'), b);
  await writeFile(path.join(exportDir, 'notat.txt'), 'ikke lyd');
  const manifests = [
    { slug: 'eyes-on-you', variant: null, version: 1, masterSha256: sha(a) },
    { slug: 'blue-fire', variant: null, version: 2, masterSha256: sha(b) },
    { slug: 'borte', variant: null, version: 1, masterSha256: 'ff'.repeat(32) }
  ];
  const assets = [];
  for (const m of manifests) {
    const rel = `${m.slug}/main/v${m.version}/manifest.json`;
    await mkdir(path.dirname(path.join(mediaDir, rel)), { recursive: true });
    await writeFile(path.join(mediaDir, rel), JSON.stringify({ ...m, title: m.slug }));
    assets.push({ slug: m.slug, variant: null, version: m.version, manifest: rel, title: m.slug, kind: 'track' });
  }
  await writeFile(path.join(mediaDir, 'index.json'), JSON.stringify({ schema: 1, updatedAt: '', assets }));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('kildefil (data/sources.json)', () => {
  it('kobler ingestede versjoner til kildefila via hash, uten å endre eksportmappa', async () => {
    const before = await stat(path.join(exportDir, 'Eyes on you (suno v4).wav'));
    const r = await indexSources({ exportDir, mediaDir, dataDir });
    expect(r.scanned).toBe(2); // bare lydfiler, også ett nivå ned
    expect(r.matched.map((m) => m.key).sort()).toEqual(['blue-fire::main::v2', 'eyes-on-you::main::v1']);
    expect(r.missing).toEqual(['borte::main::v1']);
    const s = await readSources(sourcesFile(mediaDir, dataDir));
    expect(s.entries[sourceKey('eyes-on-you', null, 1)]).toMatchObject({ fileName: 'Eyes on you (suno v4).wav', relPath: 'Eyes on you (suno v4).wav' });
    expect(s.entries[sourceKey('blue-fire', null, 2)]!.relPath).toBe('release/Blue Fire_v2.wav');
    // Eksportmappa er uendret
    const after = await stat(path.join(exportDir, 'Eyes on you (suno v4).wav'));
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
    // Manifestet får aldri originalnavnet (det kan inneholde «suno»)
    expect(await readFile(path.join(mediaDir, 'eyes-on-you/main/v1/manifest.json'), 'utf8')).not.toContain('suno');
    // Andre gang: ingenting nytt å gjøre for det som allerede er koblet
    expect((await indexSources({ exportDir, mediaDir, dataDir })).matched).toEqual([]);
  });

  it('API: Info får filnavnet (aldri stien), lyttersiden får det aldri', async () => {
    const api = createApiHandler({ mediaDir, dataDir });
    const server = http.createServer((req, res) => void api(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/api/sources/eyes-on-you/main/1`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ fileName: 'Eyes on you (suno v4).wav' });
      expect((await fetch(`${base}/api/sources/eyes-on-you/main/1`, { headers: { referer: `${base}/drop/blue-fire-pitch?r=Test` } })).status).toBe(403);
      expect((await fetch(`${base}/api/sources/eyes-on-you/main/1`, { headers: { referer: `${base}/studio` } })).status).toBe(200);
      expect((await fetch(`${base}/api/sources/finnes-ikke/main/1`)).status).toBe(404);
      expect((await fetch(`${base}/api/sources/..%2F..%2Fdata/main/1`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
