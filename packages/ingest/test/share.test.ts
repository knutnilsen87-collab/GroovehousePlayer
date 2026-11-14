import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetManifest } from '@gv/shared';
import { createApiHandler } from '../src/api';
import { FFMPEG, FFPROBE } from '../src/ffmpeg';
import { createMediaHandler } from '../src/media-static';
import { ensureShareFile, findMaster, makeMasterCopy } from '../src/share';

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const ff = (args: string[]) => spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8' });
const probe = (file: string) =>
  JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }).stdout) as {
    streams: Array<{ codec_type: string; codec_name: string; bit_rate?: string; disposition?: { attached_pic?: number } }>;
    format: { tags?: Record<string, string> };
  };
/** MD5 av selve lyden (dekodet), så vi kan sjekke bit-for-bit lik lyd. */
const audioMd5 = (file: string) => spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();

describe.skipIf(!hasFfmpeg)('del 10: master-kopi og delte filer', () => {
  let tmp: string;
  let src: string;
  let mediaDir: string;
  let vdir: string;
  let manifest: AssetManifest;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-share-'));
    src = path.join(tmp, 'REASONDONE', 'Blåbær (suno v4).wav');
    await mkdir(path.dirname(src), { recursive: true });
    // 3 s stereo 16-bit 44,1 kHz, med en «suno»-tag som ikke skal bli med videre
    expect(ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=44100', '-ac', '2', '-c:a', 'pcm_s16le', '-metadata', 'comment=made with suno', src]).status).toBe(0);
    mediaDir = path.join(tmp, 'media');
    vdir = path.join(mediaDir, 'blabaer', 'extended', 'v1');
    await mkdir(vdir, { recursive: true });
    expect(ff(['-i', src, '-t', '2', '-c:a', 'aac', '-b:a', '128k', path.join(vdir, 'preview.m4a')]).status).toBe(0);
    manifest = {
      id: 'blabaer-extended-v1',
      slug: 'blabaer',
      variant: 'extended',
      variantLabel: 'Extended',
      version: 1,
      title: 'Blåbær på Ørje',
      artist: 'Echo Groove',
      album: 'Blåbær på Ørje',
      copyright: '℗ 2026 Groovehouse Records',
      masterSha256: 'a'.repeat(64),
      coverSha256: null,
      createdAt: '2026-11-14T00:00:00Z',
      durationMs: 3000,
      files: { hls: 'hls/index.m3u8', analysis: 'analysis.json', preview: 'preview.m4a', cover: null, coverThumb: null }
    } as unknown as AssetManifest;
    await writeFile(path.join(vdir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(mediaDir, 'index.json'), JSON.stringify({ schema: 1, assets: [] }));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('master-kopien er FLAC med bit-for-bit samme lyd, uten kildetags; kilden røres ikke', async () => {
    const before = await stat(src);
    const out = await makeMasterCopy(src, vdir);
    expect(path.basename(out)).toBe('master.flac');
    expect(findMaster(vdir)).toBe(out);
    expect(probe(out).streams[0]!.codec_name).toBe('flac');
    expect(audioMd5(out)).toBe(audioMd5(src));
    expect(JSON.stringify(probe(out).format.tags ?? {})).not.toMatch(/suno/i);
    const after = await stat(src);
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);
  });

  it('«Hele låten»: AAC 256 kbps fra masteren, rene tags, innebygd (reserve)cover, riktig filnavn', async () => {
    const r = await ensureShareFile({ versionDir: vdir, manifest, kind: 'full' });
    expect(r.fileName).toBe('Echo Groove - Blåbær på Ørje (Extended).m4a');
    expect(r.contentType).toBe('audio/mp4');
    const p = probe(r.file);
    const audio = p.streams.find((s) => s.codec_type === 'audio')!;
    expect(audio.codec_name).toBe('aac');
    expect(Number(audio.bit_rate)).toBeGreaterThan(200_000);
    const pic = p.streams.find((s) => s.codec_type === 'video')!;
    expect(pic.disposition?.attached_pic).toBe(1);
    const tags = Object.fromEntries(Object.entries(p.format.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(tags).toMatchObject({ title: 'Blåbær på Ørje (Extended)', artist: 'Echo Groove', album: 'Blåbær på Ørje', date: '2026', copyright: '℗ 2026 Groovehouse Records' });
    expect(JSON.stringify(p)).not.toMatch(/suno/i);
  });

  it('cachen gjenbrukes, og fornyes når metadata (eller master) endres', async () => {
    const a = await ensureShareFile({ versionDir: vdir, manifest, kind: 'full' });
    const t1 = (await stat(a.file)).mtimeMs;
    const b = await ensureShareFile({ versionDir: vdir, manifest, kind: 'full' });
    expect(b.file).toBe(a.file);
    expect((await stat(b.file)).mtimeMs).toBe(t1);
    const c = await ensureShareFile({ versionDir: vdir, manifest: { ...manifest, title: 'Blåbær på Ørje (Live)' }, kind: 'full' });
    expect(c.file).not.toBe(a.file);
    expect(spawnSync('node', ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(a.file)}) ? 1 : 0)`]).status).toBe(0);
    const d = await ensureShareFile({ versionDir: vdir, manifest: { ...manifest, masterSha256: 'b'.repeat(64) }, kind: 'full' });
    expect(d.file).not.toBe(c.file);
  });

  it('«Original WAV» har samme lyd som originalen; «Smakebit» får cover og tags', async () => {
    const w = await ensureShareFile({ versionDir: vdir, manifest, kind: 'wav' });
    expect(w.fileName).toBe('Echo Groove - Blåbær på Ørje (Extended).wav');
    expect(probe(w.file).streams[0]!.codec_name).toBe('pcm_s16le');
    expect(audioMd5(w.file)).toBe(audioMd5(src));
    const p = await ensureShareFile({ versionDir: vdir, manifest, kind: 'preview' });
    expect(p.fileName).toBe('Echo Groove - Blåbær på Ørje (Extended) (smakebit).m4a');
    expect(probe(p.file).streams.some((s) => s.disposition?.attached_pic === 1)).toBe(true);
  });

  it('API: fila med UTF-8-filnavn; aldri fra /drop/; /media serverer ikke share/', async () => {
    const api = createApiHandler({ mediaDir, dataDir: path.join(tmp, 'data') });
    const media = createMediaHandler(mediaDir);
    const server = http.createServer((req, res) => void (req.url?.startsWith('/media/') ? media(req, res) : api(req, res)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/api/share/blabaer/extended/1?kind=full`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-disposition')).toContain("filename*=UTF-8''Echo%20Groove%20-%20Bl%C3%A5b%C3%A6r");
      expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
      expect((await fetch(`${base}/api/share/blabaer/extended/1?kind=full`, { headers: { referer: `${base}/drop/x?r=Jorrit` } })).status).toBe(403);
      expect((await fetch(`${base}/api/share/blabaer/extended/1?kind=mp3`)).status).toBe(400);
      expect((await fetch(`${base}/api/share/finnes/main/1`)).status).toBe(404);
      const r = await ensureShareFile({ versionDir: vdir, manifest, kind: 'full' });
      expect((await fetch(`${base}/media/blabaer/extended/v1/share/${path.basename(r.file)}`)).status).toBe(404);
      expect((await fetch(`${base}/media/blabaer/extended/v1/master.flac`)).status).toBe(404);
      // Delingslogg og antall (Studio)
      const post = await fetch(`${base}/api/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'blabaer', variant: 'extended', version: 1, kind: 'full' }) });
      expect(post.status).toBe(201);
      expect(((await (await fetch(`${base}/api/shares`)).json()) as { counts: Record<string, number> }).counts).toEqual({ 'blabaer::extended::v1': 1 });
    } finally {
      server.close();
    }
  });
}, 60_000);
