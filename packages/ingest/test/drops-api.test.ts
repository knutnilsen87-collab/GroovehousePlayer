import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetManifest } from '@gv/shared';
import { createApiHandler } from '../src/api';
import type { PublishRequest } from '../src/drops-api';

let tmp: string;
let server: http.Server;
let base: string;
let published: PublishRequest | null = null;

const manifest: AssetManifest = {
  schema: 1,
  id: 'id-1',
  slug: 'blue-fire',
  variant: null,
  variantLabel: null,
  version: 1,
  versionLabel: null,
  kind: 'track',
  title: 'Blue Fire',
  artist: 'Echo Groove',
  album: 'Blue Fire',
  label: 'Groovehouse Records',
  copyright: '℗ 2026 Groovehouse Records',
  durationMs: 12_000,
  sampleRate: 44100,
  channels: 2,
  bpm: 126,
  bpmConfidence: 1,
  key: null,
  masterSha256: 'ab'.repeat(32),
  coverSha256: null,
  loudness: { integratedLufs: -10, truePeakDbtp: -1, lra: 4, playbackGainDb: 0 },
  palette: { primary: '#01E6FC', secondary: '#01E6FC', onPrimary: '#071016', source: 'fallback' },
  markers: [],
  performedAt: null,
  venue: null,
  files: { hls: 'hls/index.m3u8', analysis: 'analysis.json', preview: 'preview.m4a', cover: null, coverThumb: null },
  createdAt: '2026-11-15T00:00:00.000Z'
};

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'gv-drops-'));
  const dir = path.join(tmp, 'media', 'blue-fire', 'main', 'v1', 'hls');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(tmp, 'media', 'blue-fire', 'main', 'v1', 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(dir, 'index.m3u8'), '#EXTM3U\n#EXTINF:1,\nseg_00000.ts\n');
  await writeFile(path.join(dir, 'seg_00000.ts'), Buffer.from([1, 2, 3]));
  const api = createApiHandler({
    mediaDir: path.join(tmp, 'media'),
    dataDir: path.join(tmp, 'data'),
    publishDrop: async (req) => {
      published = req;
      return { id: '11111111-1111-1111-1111-111111111111', url: 'https://listen.groovehouserecords.com/d/abc123tokenvalue000000', token: 'hemmelig-token' };
    }
  });
  server = http.createServer((req, res) => void api(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('deling med lenke', () => {
  it('publiserer låta og lagrer ikke tokenet', async () => {
    const r = await fetch(base + '/api/drops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: 'Jorrit', items: [{ slug: 'blue-fire', variant: 'main', version: 1 }] })
    });
    const json = await r.json();
    expect(r.status).toBe(201);
    expect(json.url).toBe('https://listen.groovehouserecords.com/d/abc123tokenvalue000000');
    expect(json.token).toBeUndefined();
    expect(published?.files.map((f) => f.path).sort()).toEqual(['index.m3u8', 'seg_00000.ts']);
    expect(published?.items[0]?.contentHash).toBe(manifest.masterSha256);
    const disk = await readFile(path.join(tmp, 'data', 'drops.json'), 'utf8');
    expect(disk).toContain('Jorrit');
    expect(disk).not.toContain('hemmelig-token');
    expect((await fetch(base + '/api/drops', { method: 'POST', headers: { 'content-type': 'application/json', referer: 'http://x/drop/abc' }, body: '{}' })).status).toBe(403);
    expect((await fetch(base + '/api/drops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipient: '', items: [] }) })).status).toBe(400);
  });
});
