import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { FALLBACK_PALETTE, type AssetManifest } from '@gv/shared';
import { buildCoverPrompt, bulkImgStatus, lyricThemes, OVERDUE_MS, receiveFromBulkImg, sendToBulkImg, takeOverdueWarnings } from '../src/bulkimg';
import { DEFAULTS, type VaultConfig } from '../src/config';

/** Del 23 nivå 2: CSV til bulkIMGs innboks, cover inn fra eksportmappa. bulkIMG simuleres med mapper. */
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gv-bulk-'));
  const mediaDir = path.join(root, 'media');
  const dataDir = path.join(root, 'data');
  const bulk = path.join(root, 'bulkIMG');
  const cfg: VaultConfig = { ...DEFAULTS, covers: { bulkimgInbox: path.join(bulk, 'imports', 'groovehouse'), bulkimgExports: path.join(bulk, 'repo', 'exports') } };
  const m = {
    schema: 1, id: 'x', slug: 'blue-fire', variant: null, variantLabel: null, version: 1, versionLabel: null, kind: 'track', status: 'release',
    title: 'Blue "Fire"', artist: 'Echo Groove', album: null, label: null, copyright: null, durationMs: 1000, sampleRate: 48000, channels: 2,
    bpm: 124, bpmConfidence: 1, key: { name: 'Am', camelot: '8A', confidence: 1 }, masterSha256: 'a', coverSha256: null, coverSource: 'generated',
    loudness: { integratedLufs: -9, truePeakDb: -1, playbackGainDb: 0 }, palette: { ...FALLBACK_PALETTE }, markers: [], performedAt: null, venue: null,
    files: { hls: 'hls/index.m3u8', analysis: 'analysis.json', preview: 'preview.m4a', cover: 'cover.jpg', coverThumb: 'cover_300.jpg' }, createdAt: new Date().toISOString()
  } as unknown as AssetManifest;
  const vdir = path.join(mediaDir, 'blue-fire', 'main', 'v1');
  await mkdir(vdir, { recursive: true });
  await writeFile(path.join(vdir, 'manifest.json'), JSON.stringify(m));
  await writeFile(path.join(mediaDir, 'index.json'), JSON.stringify({ schema: 1, updatedAt: '', assets: [{ slug: 'blue-fire', variant: null, version: 1, manifest: 'blue-fire/main/v1/manifest.json', title: m.title, kind: 'track' }] }));
  return { root, mediaDir, dataDir, bulk, cfg, m, vdir };
}

/** Lager en bulkIMG-eksport (bilder + manifest.json) og run-data slik desktop-appen gjør. */
async function fakeExport(bulk: string, name: string, files: string[], runId = 'run_1') {
  const dir = path.join(bulk, 'repo', 'exports', name);
  await mkdir(dir, { recursive: true });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#E645C6' } }).png().toBuffer();
  for (const f of files) await writeFile(path.join(dir, f), png);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ exportId: `export_${name}`, runId, files: files.map((f, i) => ({ filename: f.replace(/_\d+\.png$/, '.png'), exportedFilename: f, path: path.join(dir, f), candidateId: `cand_${i}` })) }));
  const run = path.join(bulk, 'repo', 'generated', 'runs', runId);
  await mkdir(run, { recursive: true });
  await writeFile(path.join(run, 'assets.json'), JSON.stringify(files.map((f, i) => ({ candidateId: `cand_${i}`, filename: f, prompt: 'prompt fra bulkIMG', providerId: 'openai', model: 'gpt-image-1' }))));
}

describe('AI-cover via bulkIMG (del 23 nivå 2)', () => {
  it('prompten bygges av tittel, stemning, tekst og stilmal – uten tekst, personer eller logoer i bildet', () => {
    const { m } = { m: { title: 'Blue Fire', bpm: 124, key: { camelot: '8A' }, energy: 8 } as unknown as AssetManifest };
    const p = buildCoverPrompt(m, { lyrics: '[00:01.00]<00:01.00>Ocean ocean night fire fire fire', style: 'echo-groove-nights' });
    expect(p).toContain('"Blue Fire"');
    expect(p).toMatch(/minor-key/);
    expect(p).toMatch(/peak-time/);
    expect(p).toMatch(/124 BPM/);
    expect(p).toMatch(/magenta/);
    expect(p).toMatch(/no text/i);
    expect(p).toMatch(/no recognizable real people/i);
    expect(lyricThemes('the the fire fire ocean')).toEqual(['fire', 'ocean']);
  });

  it('skriver CSV i bulkIMGs format (BOM, section,category,filename,prompt) til innboksen', async () => {
    const { cfg, dataDir, m } = await setup();
    const r = await sendToBulkImg({ cfg, dataDir, items: [{ manifest: m, prompt: 'Square cover, "quoted"' }] });
    expect(r.count).toBe(1);
    const csv = await readFile(r.csv, 'utf8');
    expect(csv.startsWith('﻿section,category,filename,prompt\r\n')).toBe(true);
    expect(csv).toContain('"GROOVEHOUSE","Album Cover","blue-fire__main.png","Square cover, ""quoted"""');
    expect((await bulkImgStatus(cfg, dataDir)).sent).toBe(1);
  });

  it('henter coveret fra eksporten, med leverandør og modell fra run-data, og ignorerer andre filer', async () => {
    const { cfg, dataDir, mediaDir, bulk, m, vdir } = await setup();
    // En gammel eksport med samme filnavn finnes fra før (laget før forsendelsen)
    await fakeExport(bulk, 'aaa-gammel', ['bear_01.png', 'blue-fire__main.png'], 'run_old');
    await new Promise((r) => setTimeout(r, 30));
    expect(await receiveFromBulkImg({ cfg, mediaDir, dataDir })).toEqual([]); // ingenting sendt ennå
    await sendToBulkImg({ cfg, dataDir, items: [{ manifest: m, prompt: 'p' }] });
    await fakeExport(bulk, '2026-11-16-groovehouse', ['blue-fire__main_2.png', 'annen__main.png']);
    const got = await receiveFromBulkImg({ cfg, mediaDir, dataDir });
    // Den gamle eksporten (sortert først) er laget før forsendelsen og ignoreres; den nye gir treff
    expect(got.map((g) => [g.slug, g.providerId, g.model])).toEqual([['blue-fire', 'openai', 'gpt-image-1']]);
    const after = JSON.parse(await readFile(path.join(vdir, 'manifest.json'), 'utf8')) as AssetManifest;
    expect(after.coverSource).toBe('ai');
    expect(after.coverAi).toEqual({ provider: 'openai', model: 'gpt-image-1' });
    expect(after.palette.source).toBe('cover');
    // Vault la tittelen oppå (bildet var ensfarget rosa) og lagret 3000 px til release
    const big = sharp(path.join(mediaDir, 'blue-fire', 'cover_ai.png'));
    const meta3000 = await big.metadata();
    expect([meta3000.width, meta3000.height, meta3000.channels]).toEqual([3000, 3000, 3]);
    const st0 = await sharp(path.join(mediaDir, 'blue-fire', 'cover_ai.png')).extract({ left: 0, top: 2400, width: 3000, height: 600 }).stats();
    expect(st0.channels[0]!.max - st0.channels[0]!.min).toBeGreaterThan(100);
    const meta = JSON.parse(await readFile(path.join(mediaDir, 'blue-fire', 'meta.json'), 'utf8'));
    expect(meta.aiCover).toMatchObject({ source: 'bulkimg', provider: 'openai', prompt: 'prompt fra bulkIMG', seed: null });
    // Samme eksport leses ikke på nytt
    expect(await receiveFromBulkImg({ cfg, mediaDir, dataDir })).toEqual([]);
    const st = await bulkImgStatus(cfg, dataDir);
    expect([st.sent, st.received, st.waiting.length]).toEqual([1, 1, 0]);
  });

  it('varsler én gang når noe er sendt og ingenting er kommet tilbake etter 24 timer', async () => {
    const { cfg, dataDir, m } = await setup();
    const sentAt = new Date('2026-11-16T10:00:00Z');
    await sendToBulkImg({ cfg, dataDir, items: [{ manifest: m, prompt: 'p' }], now: sentAt });
    expect(await takeOverdueWarnings(cfg, dataDir, sentAt.getTime() + OVERDUE_MS - 1000)).toEqual([]);
    expect(await takeOverdueWarnings(cfg, dataDir, sentAt.getTime() + OVERDUE_MS + 1000)).toEqual(['Blue "Fire"']);
    expect(await takeOverdueWarnings(cfg, dataDir, sentAt.getTime() + OVERDUE_MS + 5000)).toEqual([]);
    expect((await bulkImgStatus(cfg, dataDir, sentAt.getTime() + OVERDUE_MS + 1000)).overdue).toBe(true);
  });

  it('skriver aldri noe i bulkIMGs eksport- eller run-mapper', async () => {
    const { cfg, dataDir, mediaDir, bulk, m } = await setup();
    await sendToBulkImg({ cfg, dataDir, items: [{ manifest: m, prompt: 'p' }] });
    await fakeExport(bulk, 'e1', ['blue-fire__main.png']);
    const before = await readdir(path.join(bulk, 'repo', 'exports', 'e1'));
    await receiveFromBulkImg({ cfg, mediaDir, dataDir });
    expect(await readdir(path.join(bulk, 'repo', 'exports', 'e1'))).toEqual(before);
    expect(existsSync(path.join(bulk, 'repo', 'generated', 'runs', 'run_1', 'assets.json'))).toBe(true);
  });
});
