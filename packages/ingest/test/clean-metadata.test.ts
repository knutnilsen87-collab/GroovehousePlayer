import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetManifest } from '@gv/shared';
import type { VaultConfig } from '../src/config';
import { FFMPEG, FFPROBE, run } from '../src/ffmpeg';
import { ingestRelease, retagSlug, type IngestResult } from '../src/ingest';
import { scanFlat } from '../src/sources';

/**
 * Ende-til-ende: en flat eksportmappe med en WAV som har Suno-tags og «suno» i filnavnet,
 * og et cover med EXIF. Ingenting av det skal finnes i HLS, preview, cover eller manifest.
 */
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = {
  ports: { server: 41733, dev: 41734 },
  lan: { enabled: false, rememberDays: 30 },
  defaults: { artist: 'Echo Groove', label: 'Groovehouse Records', copyright: '℗ {year} Groovehouse Records' },
  titleCleanup: { remove: ['suno ai', 'suno', 'v4.5', 'v4', 'v5.5', 'v5', '(remastered)', 'final', 'master', 'bounce', 'export', 'stems'] }
};

describe.skipIf(!hasFfmpeg)('metadata-rensing (krever ffmpeg)', () => {
  let tmp: string;
  let exportDir: string;
  let mediaDir: string;
  let results: IngestResult[];
  let outDir: string;
  const original = new Map<string, Buffer>();
  const mtimes = new Map<string, number>();

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-suno-'));
    exportDir = path.join(tmp, 'Reason Export æøå');
    mediaDir = path.join(tmp, 'media');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(exportDir, { recursive: true });
    const wav = path.join(exportDir, 'Night Drive suno v4.5 (1).wav');
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=8', '-ac', '2', '-metadata', 'title=Night Drive (Suno AI v4.5)', '-metadata', 'artist=Suno', '-metadata', 'comment=Made with Suno', '-metadata', 'encoded_by=suno.com', wav]);
    const cover = path.join(exportDir, 'Night Drive suno.jpg');
    await sharp({ create: { width: 600, height: 600, channels: 3, background: '#2050d0' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Software: 'Suno AI', ImageDescription: 'Made with Suno' } } })
      .toFile(cover);
    await (await import('node:fs/promises')).writeFile(path.join(exportDir, 'Night Drive.reason'), 'prosjektfil');
    const { stat } = await import('node:fs/promises');
    for (const f of await readdir(exportDir)) {
      original.set(f, await readFile(path.join(exportDir, f)));
      mtimes.set(f, (await stat(path.join(exportDir, f))).mtimeMs);
    }

    const scan = await scanFlat(exportDir, cfg);
    expect(scan.releases).toHaveLength(1);
    expect(scan.ignored).toEqual(['Night Drive.reason']);
    results = await ingestRelease(scan.releases[0]!, { mediaDir, config: cfg });
    outDir = results[0]!.outDir;
  }, 120_000);

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  async function tags(file: string): Promise<string> {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format_tags:stream_tags:program_tags', '-of', 'json', file]);
    return stdout;
  }

  it('varsler om hva som ble funnet', () => {
    const found = results[0]!.suno.join('\n');
    expect(found).toMatch(/filnavn/);
    expect(found).toMatch(/comment=Made with Suno/);
    expect(found).toMatch(/cover-filnavn/);
  });

  it('manifest: renset tittel, egne standardverdier, ingen suno', async () => {
    const raw = await readFile(path.join(outDir, 'manifest.json'), 'utf8');
    expect(raw).not.toMatch(/suno/i);
    const m = JSON.parse(raw) as AssetManifest;
    expect(m.slug).toBe('night-drive');
    expect(m.title).toBe('Night Drive');
    expect(m.artist).toBe('Echo Groove');
    expect(m.album).toBe('Night Drive');
    expect(m.label).toBe('Groovehouse Records');
    expect(m.copyright).toBe(`℗ ${new Date().getFullYear()} Groovehouse Records`);
  });

  it('HLS-segmenter: ingen kildetags, ingen ffmpeg-signatur', async () => {
    const seg = path.join(outDir, 'hls', 'seg_00000.ts');
    const t = await tags(seg);
    expect(t).not.toMatch(/suno|lavf|lavc/i);
    expect(t).toMatch(/Groovehouse Vault/);
  });

  it('preview.m4a: bare våre egne tags', async () => {
    const t = JSON.parse(await tags(path.join(outDir, 'preview.m4a'))) as { format: { tags: Record<string, string> } };
    const f = t.format.tags;
    expect(JSON.stringify(t)).not.toMatch(/suno|lavf|lavc/i);
    expect(f.title).toBe('Night Drive');
    expect(f.artist).toBe('Echo Groove');
    expect(f.album).toBe('Night Drive');
    expect(f.copyright).toMatch(/^℗ \d{4} Groovehouse Records$/);
    expect(f.comment).toBeUndefined();
  });

  it('ingen fil som lages inneholder «suno», og coveret har ikke EXIF/XMP/C2PA', async () => {
    const files = ['manifest.json', 'analysis.json', 'preview.m4a', 'cover.jpg', 'cover_300.jpg', ...(await readdir(path.join(outDir, 'hls'))).map((f) => `hls/${f}`)];
    for (const f of files) {
      const buf = await readFile(path.join(outDir, f));
      expect(buf.toString('latin1'), f).not.toMatch(/suno/i);
    }
    for (const f of ['cover.jpg', 'cover_300.jpg']) {
      const s = (await readFile(path.join(outDir, f))).toString('latin1');
      expect(s, f).not.toMatch(/Exif\x00|http:\/\/ns\.adobe\.com\/xap|c2pa|jumb/i);
    }
  });

  it('eksportmappa er uendret (leses bare)', async () => {
    const now = await readdir(exportDir);
    expect(now.sort()).toEqual([...original.keys()].sort());
    const { stat } = await import('node:fs/promises');
    for (const [f, buf] of original) {
      expect((await readFile(path.join(exportDir, f))).equals(buf), f).toBe(true);
      expect((await stat(path.join(exportDir, f))).mtimeMs, f).toBe(mtimes.get(f));
    }
  });

  it('Studio-redigering: bare tags og manifest skrives på nytt', async () => {
    const { mkdir, writeFile, stat } = await import('node:fs/promises');
    const segBefore = (await stat(path.join(outDir, 'hls', 'seg_00000.ts'))).mtimeMs;
    await mkdir(path.join(mediaDir, 'night-drive'), { recursive: true });
    await writeFile(path.join(mediaDir, 'night-drive', 'meta.json'), JSON.stringify({ title: 'NIGHT DRIVE', album: 'Blue Fire' }));
    const [m] = await retagSlug(mediaDir, 'night-drive', cfg);
    expect(m!.title).toBe('NIGHT DRIVE');
    expect(m!.album).toBe('Blue Fire');
    const t = JSON.parse(await tags(path.join(outDir, 'preview.m4a'))) as { format: { tags: Record<string, string> } };
    expect(t.format.tags.title).toBe('NIGHT DRIVE');
    expect(t.format.tags.album).toBe('Blue Fire');
    expect((await stat(path.join(outDir, 'hls', 'seg_00000.ts'))).mtimeMs).toBe(segBefore);

    // Tømte felt i Studio → tilbake til verdiene fra kilden, og album følger tittelen igjen.
    await writeFile(path.join(mediaDir, 'night-drive', 'meta.json'), JSON.stringify({ title: 'Night Drive Reprise' }));
    const [r] = await retagSlug(mediaDir, 'night-drive', cfg);
    expect(r!.title).toBe('Night Drive Reprise');
    expect(r!.album).toBe('Night Drive Reprise');
    await writeFile(path.join(mediaDir, 'night-drive', 'meta.json'), '{}');
    const [z] = await retagSlug(mediaDir, 'night-drive', cfg);
    expect(z).toMatchObject({ title: 'Night Drive', album: 'Night Drive', artist: 'Echo Groove' });
  });
});
