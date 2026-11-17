import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { AssetManifest, CatalogIndex } from '@gv/shared';
import { DEFAULTS, type VaultConfig } from '../src/config';
import { FFMPEG, FFPROBE, run } from '../src/ffmpeg';
import { createFingerprintStore, createHashCache, createSkippedStore } from '../src/incoming';
import { ingestRelease } from '../src/ingest';
import { prepareRelease, releaseChecklist } from '../src/release-pack';
import { scanFlat } from '../src/sources';
import { startWatcher } from '../src/watcher';

/** Del 24: release-pakke for LANDR og kobling av LANDR-mastere (krever ffmpeg). */
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const repo = path.resolve(__dirname, '..', '..', '..');

describe('release-pakke (ren)', () => {
  it('releases/ står i .gitignore', () => {
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toMatch(/^\/releases\/$/m);
  });
  it('sjekklista: dato, AI-feltene og ISRC/UPC mangler; klipping og umastret merkes', () => {
    const c = releaseChecklist({ tracks: [{ title: 'A', isrc: null, clipped: true, truePeakDb: 0.4, lyrics: null, status: 'draft' }], info: null, cover: { file: 'cover.jpg', source: 'Eget cover', warning: null }, aiMusic: null, aiCover: 'nei', genre: 'Tech House' });
    const open = c.filter((x) => !x.ok).map((x) => x.item);
    expect(open).toEqual(expect.arrayContaining(['Utgivelsesdato', 'AI brukt i musikken (ja/nei)', '«A» er umastret', '«A» klipper (true peak 0.4 dBTP)', 'ISRC for «A»', 'UPC/EAN']));
    expect(open).not.toContain('AI brukt i coveret (ja/nei)');
  });
});

describe.skipIf(!hasFfmpeg)('release-pakke og LANDR (krever ffmpeg)', () => {
  let tmp = '';
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });
  it('lager WAV 24-bit/44,1 kHz, cover 3000×3000 RGB og metadata; blokkerer umastret; kobler LANDR-master', { timeout: 180_000 }, async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-rel-'));
    const src = path.join(tmp, 'src');
    const drafts = path.join(tmp, 'umastret');
    const landr = path.join(tmp, 'LANDR', 'Mastere');
    const mediaDir = path.join(tmp, 'media');
    const dataDir = path.join(tmp, 'data');
    await mkdir(src, { recursive: true });
    await mkdir(drafts, { recursive: true });
    await mkdir(landr, { recursive: true });
    const cfg: VaultConfig = { ...DEFAULTS, defaults: { artist: 'Echo Groove', label: 'Groovehouse Records', copyright: null } };
    const tone = (file: string, f: number, vol = 0.5) => run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${f}:d=12`, '-af', `volume=${vol}`, '-ac', '2', '-ar', '48000', file]);
    const noise = (file: string, vol: number) => run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:seed=7', '-f', 'lavfi', '-i', 'sine=f=110:d=30', '-filter_complex', `[0:a][1:a]amix=inputs=2,volume=${vol}`, '-ac', '2', '-ar', '48000', file]);
    await noise(path.join(src, 'Blue Fire.wav'), 0.5);
    await tone(path.join(drafts, 'Night Drive.wav'), 330);
    for (const r of (await scanFlat(src, cfg)).releases) await ingestRelease(r, { mediaDir, config: cfg, status: 'release' });
    for (const r of (await scanFlat(drafts, cfg, { lossy: true })).releases) await ingestRelease(r, { mediaDir, config: cfg, status: 'draft' });

    const res = await prepareRelease({ mediaDir, dataDir, root: tmp, cfg, items: [{ slug: 'blue-fire', variant: null, version: 1 }], genre: 'Tech House', now: new Date('2026-11-17T10:00:00Z') });
    expect(res.relDir.replace(/\\/g, '/')).toBe('releases/2026-11-17-Blue-Fire');
    const wav = path.join(res.dir, '01 - Blue Fire.wav');
    const pr = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,bits_per_sample,codec_name', '-of', 'json', wav]);
    const st = (JSON.parse(pr.stdout) as { streams: Array<{ sample_rate: string; channels: number; bits_per_sample: number; codec_name: string }> }).streams[0]!;
    expect([st.codec_name, st.sample_rate, st.channels, st.bits_per_sample]).toEqual(['pcm_s24le', '44100', 2, 24]);
    expect(res.tracks[0]!.truePeakDb).not.toBeNull();
    expect(res.tracks[0]!.clipped).toBe(false);
    const meta = await sharp(path.join(res.dir, 'cover.jpg')).metadata();
    expect([meta.width, meta.height, meta.channels, meta.space]).toEqual([3000, 3000, 3, 'srgb']);
    const md = JSON.parse(await readFile(path.join(res.dir, 'metadata.json'), 'utf8')) as Record<string, unknown>;
    expect(md).toMatchObject({ title: 'Blue Fire', artist: 'Echo Groove', label: 'Groovehouse Records', genre: 'Tech House', language: 'Engelsk', explicit: 'Nei', aiMusic: null, aiCover: null });
    expect(res.fields[0]).toEqual({ label: 'Tittel på utgivelsen', value: 'Blue Fire' });
    expect(res.checklist.find((c) => c.item === 'AI brukt i musikken (ja/nei)')?.ok).toBe(false);

    // Umastret blokkeres – og går med «Utgi likevel»
    const draftItem = { slug: 'night-drive', variant: null, version: 1001 };
    await expect(prepareRelease({ mediaDir, dataDir, root: tmp, cfg, items: [draftItem] })).rejects.toMatchObject({ status: 409 });
    const ok = await prepareRelease({ mediaDir, dataDir, root: tmp, cfg, items: [draftItem], confirmDraft: true });
    expect(ok.checklist.some((c) => c.item.includes('umastret'))).toBe(true);

    // LANDR-master av Blue Fire (samme låt, høyere nivå) kobles til låta som «LANDR-master», release-klar
    await noise(path.join(landr, 'Blue Fire - LANDR.wav'), 0.9);
    // … og en master som ikke ligner (sinustone med samme tittel): usikker, til Studio med «LANDR-master» ved bekreftelse
    await tone(path.join(landr, 'Night Drive (LANDR).wav'), 660);
    const incoming = { ctx: { mediaDir, dataDir, hashes: createHashCache(dataDir), fingerprints: createFingerprintStore(dataDir) }, skipped: createSkippedStore(dataDir) };
    const w = startWatcher({ exportDir: landr, mediaDir, config: cfg, status: 'release', link: 'landr', incoming, log: () => {} });
    try {
      await w.catchUp();
      await w.idle();
    } finally {
      await w.close();
    }
    const idx = JSON.parse(await readFile(path.join(mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
    const bf = idx.assets.filter((a) => a.slug === 'blue-fire').map((a) => a.version).sort();
    expect(bf).toEqual([1, 2]);
    const m2 = JSON.parse(await readFile(path.join(mediaDir, 'blue-fire', 'main', 'v2', 'manifest.json'), 'utf8')) as AssetManifest;
    expect([m2.versionLabel, m2.status]).toEqual(['LANDR-master', 'release']);
    const listed = (await incoming.skipped.list()).find((s) => s.fileName === 'Night Drive (LANDR).wav');
    expect(listed).toMatchObject({ status: 'release', label: 'LANDR-master', matchSlug: 'night-drive' });
  });
});
