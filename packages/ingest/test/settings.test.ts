import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetManifest, AssetMarker } from '@gv/shared';
import { DEFAULTS, formatCopyright, loadConfig, matchRule, ruleMatches, type VaultConfig } from '../src/config';
import { FFMPEG, run } from '../src/ffmpeg';
import { ingestRelease, retagSlug, shiftMarkers } from '../src/ingest';
import { BACKUP_FILE, previewExport, saveSettings, validateSettings } from '../src/settings';
import { overridePath, scanFlat } from '../src/sources';

const base: VaultConfig = { ...DEFAULTS, exportDir: null };

describe('innstillinger: validering (del 8)', () => {
  it('godtar standardverdiene', () => {
    expect(validateSettings({}, base)).toEqual([]);
    expect(validateSettings({ audio: { targetLufs: -16 }, colors: { minContrast: 3 } }, base)).toEqual([]);
  });
  it('avviser verdier utenfor området, med forklaring', () => {
    expect(validateSettings({ audio: { targetLufs: -10 } }, base).join()).toMatch(/−16 og −11/);
    expect(validateSettings({ colors: { minContrast: 2.9 } }, base).join()).toMatch(/kontrast/);
    expect(validateSettings({ ingest: { setThresholdMinutes: 2.5 } }, base).join()).toMatch(/Sett-grensen/);
    expect(validateSettings({ ingest: { rules: [{ pattern: '' }] } }, base).join()).toMatch(/Regel 1/);
    expect(validateSettings({ ingest: { rules: [{ pattern: '*Club*', variant: 'Club Mix' }] } }, base).join()).toMatch(/variant/);
    expect(validateSettings({ drops: { maxDevices: 0 } }, base).join()).toMatch(/enheter/);
    expect(validateSettings({ exportDir: 'relativ/sti' }, base).join()).toMatch(/full sti/);
    expect(validateSettings({ titleCleanup: { remove: [''] } }, base).join()).toMatch(/Rensingslisten/);
  });
});

describe('innstillinger: atomisk lagring med backup', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'gv-settings-'));
    writeFileSync(path.join(root, 'groovehouse.config.json'), JSON.stringify({ ports: { server: 41733, dev: 41734 }, lan: { enabled: false, rememberDays: 30 } }, null, 2));
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lagrer, beholder resten av fila og tar backup av forrige versjon', () => {
    const before = readFileSync(path.join(root, 'groovehouse.config.json'), 'utf8');
    const cfg = saveSettings(root, { audio: { targetLufs: -12 }, ingest: { setThresholdMinutes: 30, rules: [{ pattern: '* (Live *)', kind: 'set' }] } });
    expect(cfg.audio.targetLufs).toBe(-12);
    expect(cfg.ingest.setThresholdMinutes).toBe(30);
    const j = JSON.parse(readFileSync(path.join(root, 'groovehouse.config.json'), 'utf8'));
    expect(j.ports).toEqual({ server: 41733, dev: 41734 });
    expect(readFileSync(path.join(root, BACKUP_FILE), 'utf8')).toBe(before);
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('ugyldig endring skriver ingenting', () => {
    const before = readFileSync(path.join(root, 'groovehouse.config.json'), 'utf8');
    expect(() => saveSettings(root, { audio: { targetLufs: -20 } })).toThrow(/LUFS/);
    expect(readFileSync(path.join(root, 'groovehouse.config.json'), 'utf8')).toBe(before);
  });

  it('eksportmappa lagres bare lokalt (groovehouse.local.json)', () => {
    const dir = path.join(root, 'export');
    mkdirSync(dir);
    saveSettings(root, { exportDir: dir });
    expect(JSON.parse(readFileSync(path.join(root, 'groovehouse.local.json'), 'utf8')).exportDir).toBe(dir);
    expect(JSON.parse(readFileSync(path.join(root, 'groovehouse.config.json'), 'utf8')).exportDir).toBeUndefined();
    expect(loadConfig(root).exportDir).toBe(dir);
  });
});

describe('filnavnregler, copyright-mal og forskyvning', () => {
  it('regler med * som jokertegn, første som passer vinner', () => {
    expect(ruleMatches('* (Live *)', 'Oslo (Live at Blå).wav')).toBe(true);
    expect(ruleMatches('* (Live *)', 'Livewire.wav')).toBe(false);
    const cfg = { ingest: { setThresholdMinutes: 20, rules: [{ pattern: '*club*', variant: 'club' }, { pattern: '*', kind: 'track' as const }] } };
    expect(matchRule(cfg, 'Night Drive (Club Mix).wav')?.variant).toBe('club');
    expect(matchRule(cfg, 'Night Drive.wav')?.kind).toBe('track');
  });
  it('forhåndsvisning av eksportmappa leser bare filnavn', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gv-prev-'));
    writeFileSync(path.join(dir, 'Sunset suno v4.5.wav'), '');
    writeFileSync(path.join(dir, 'Oslo (Live at Blå).wav'), '');
    const p = previewExport(dir, { ingest: { setThresholdMinutes: 20, rules: [{ pattern: '* (Live *)', kind: 'set' }] }, titleCleanup: { remove: ['suno', 'v4.5'] } }, base);
    expect(p.total).toBe(2);
    expect(p.rows.find((r) => r.file.startsWith('Oslo'))?.kind).toBe('set');
    expect(p.rows.find((r) => r.file.startsWith('Sunset'))?.title).toBe('Sunset');
    rmSync(dir, { recursive: true, force: true });
  });
  it('copyright-mal med {år} og {label}', () => {
    expect(formatCopyright('℗ {år} {label}', 2026, 'Groovehouse Records')).toBe('℗ 2026 Groovehouse Records');
    expect(formatCopyright('℗ {year} Groovehouse Records', 2025)).toBe('℗ 2025 Groovehouse Records');
  });
  it('forskyvning flytter alle markører og holder dem innenfor låta', () => {
    const mk = (startMs: number, endMs?: number): AssetMarker => ({ kind: 'chapter', source: 'live_log', startMs, ...(endMs !== undefined ? { endMs } : {}), confirmed: true });
    expect(shiftMarkers([mk(0, 1000), mk(1000, 9800)], 500, 10_000).map((m) => [m.startMs, m.endMs])).toEqual([
      [500, 1500],
      [1500, 10_000]
    ]);
    expect(shiftMarkers([mk(200)], -500, 10_000)[0]!.startMs).toBe(0);
  });
});

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('per låt: manuell palett og live-forskyvning overlever ny ingest (krever ffmpeg)', () => {
  let tmp: string;
  let exportDir: string;
  let mediaDir: string;
  const cfg: VaultConfig = { ...base, ingest: { setThresholdMinutes: 20, rules: [{ pattern: '* (Live *)', kind: 'set' }] } };

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gv-look-'));
    exportDir = path.join(tmp, 'export');
    mediaDir = path.join(tmp, 'media');
    await mkdir(exportDir, { recursive: true });
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-ac', '2', path.join(exportDir, 'Blue Hour.wav')]);
    await sharp({ create: { width: 400, height: 400, channels: 3, background: '#2050d0' } })
      .png()
      .toFile(path.join(exportDir, 'Blue Hour.png'));
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=10', '-ac', '2', path.join(exportDir, 'Oslo (Live at Blå).wav')]);
  }, 60_000);
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('manuell palett vinner over coveret ved ny ingest, og «tilbakestill» gir coverets farge igjen', async () => {
    const scan = await scanFlat(exportDir, cfg);
    const release = scan.releases.find((r) => r.slug === 'blue-hour')!;
    const first = await ingestRelease(release, { mediaDir, config: cfg });
    expect(first[0]!.manifest.palette.source).toBe('cover');

    await writeFile(overridePath(mediaDir, 'blue-hour'), JSON.stringify({ palette: { primary: '#FF8800', secondary: '#AA2266' } }));
    const again = await ingestRelease(release, { mediaDir, config: cfg, force: true });
    expect(again[0]!.manifest.palette).toMatchObject({ primary: '#FF8800', secondary: '#AA2266', source: 'manual' });

    await writeFile(overridePath(mediaDir, 'blue-hour'), JSON.stringify({}));
    const [reset] = await retagSlug(mediaDir, 'blue-hour', cfg);
    expect(reset!.palette.source).toBe('cover');
  }, 120_000);

  it('filnavnregel gjør «(Live …)» til sett, og forskyvning flytter markørene', async () => {
    const scan = await scanFlat(exportDir, cfg);
    const release = scan.releases.find((r) => r.slug.startsWith('oslo'))!;
    const [res] = await ingestRelease(release, { mediaDir, config: cfg });
    expect(res!.manifest.kind).toBe('set');
    // Live-logg-markører som ingest ville laget (testen setter dem direkte i manifestet)
    const mp = path.join(res!.outDir, 'manifest.json');
    const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
    m.markers = [
      { kind: 'chapter', source: 'live_log', startMs: 1000, endMs: 4000, label: 'A', confirmed: true },
      { kind: 'chapter', source: 'live_log', startMs: 4000, endMs: 10_000, label: 'B', confirmed: true }
    ];
    await writeFile(mp, JSON.stringify(m));
    const slug = res!.manifest.slug;

    await writeFile(overridePath(mediaDir, slug), JSON.stringify({ liveOffsetMs: 500 }));
    let [u] = await retagSlug(mediaDir, slug, cfg);
    expect(u!.markers.map((k) => k.startMs)).toEqual([1500, 4500]);
    expect(u!.liveOffsetMs).toBe(500);

    await writeFile(overridePath(mediaDir, slug), JSON.stringify({ liveOffsetMs: -250 }));
    [u] = await retagSlug(mediaDir, slug, cfg);
    expect(u!.markers.map((k) => k.startMs)).toEqual([750, 3750]);
    expect(existsSync(overridePath(mediaDir, slug))).toBe(true);
  }, 120_000);
});
