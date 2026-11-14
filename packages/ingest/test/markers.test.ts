import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetManifest, AssetMarker } from '@gv/shared';
import { createApiHandler } from '../src/api';
import { DEFAULTS, type VaultConfig } from '../src/config';
import { FFMPEG, run } from '../src/ffmpeg';
import { ingestRelease } from '../src/ingest';
import { releaseFromFolder, scanFlat } from '../src/sources';

const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = { ...DEFAULTS, exportDir: null };

/**
 * Del 2 «Ferdig når»: flytt Drop 1 i Studio (API), kjør ingest --force, og flyttingen står seg.
 * Ny versjon (_v2) får markørene overført som ubekreftede.
 */
describe.skipIf(!hasFfmpeg)('markør-editoren: rettelser overlever ny ingest (krever ffmpeg)', () => {
  let tmp: string;
  let exportDir: string;
  let mediaDir: string;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'gv-markers-'));
    exportDir = path.join(tmp, 'export');
    mediaDir = path.join(tmp, 'media');
    await mkdir(exportDir, { recursive: true });
    // 40 s: stille intro, så sterkere del – nok til at analysen foreslår noe
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=110:d=40', '-af', "volume='if(lt(t,12),0.15,0.9)':eval=frame", '-ac', '2', path.join(exportDir, 'Night Run.wav')]);
    const api = createApiHandler({ mediaDir, dataDir: path.join(tmp, 'data') });
    server = http.createServer((req, res) => void api(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);
  afterAll(async () => {
    server?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown, type = 'application/json') => fetch(base + p, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });

  it('flytt Drop 1 → --force → flyttingen står seg; slettede forslag kommer ikke tilbake', async () => {
    const release = (await scanFlat(exportDir, cfg)).releases.find((r) => r.slug === 'night-run')!;
    const [first] = await ingestRelease(release, { mediaDir, config: cfg });
    const url = `/api/assets/night-run/main/v1/markers`;
    const got = (await (await fetch(base + url)).json()) as { markers: AssetMarker[]; edited: boolean };
    expect(got.edited).toBe(false);
    console.log('forslag fra analysen:', got.markers.map((m) => `${m.label}@${m.startMs}`).join(', ') || '(ingen)');

    // Studio: Drop 1 flyttes til 20 s (manuell), første forslag godkjennes, ett annet slettes
    const suggestions = got.markers.filter((m) => m.label !== 'Drop 1' && Math.abs(m.startMs - 20_000) >= 1000);
    const approved = suggestions[0];
    const dismissedOne = suggestions[1];
    const edited: AssetMarker[] = [
      ...suggestions.filter((m) => m !== dismissedOne).map((m) => (m === approved ? { ...m, confirmed: true } : m)),
      { kind: 'chapter', source: 'manual', startMs: 20_000, label: 'Drop 1', confirmed: true }
    ];
    const dismissed = dismissedOne ? [`${dismissedOne.kind}:${(dismissedOne.label ?? '').toLowerCase()}`] : [];
    const saved = await post(url, { markers: edited, dismissed });
    expect(saved.status).toBe(200);
    const after = ((await saved.json()) as { manifest: AssetManifest }).manifest;
    expect(after.markers.find((m) => m.label === 'Drop 1')).toMatchObject({ startMs: 20_000, source: 'manual', confirmed: true });
    expect(existsSync(path.join(first!.outDir, 'markers.json'))).toBe(true);

    // ingest --force: ny analyse, men Knuts rettelser står seg
    const [again] = await ingestRelease(release, { mediaDir, config: cfg, force: true });
    const m = JSON.parse(await readFile(path.join(again!.outDir, 'manifest.json'), 'utf8')) as AssetManifest;
    const drops = m.markers.filter((k) => k.label === 'Drop 1');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ startMs: 20_000, source: 'manual', confirmed: true });
    if (approved) expect(m.markers.find((k) => k.label === approved.label && k.kind === approved.kind)?.confirmed).toBe(true);
    if (dismissedOne) expect(m.markers.some((k) => k.label === dismissedOne.label && k.kind === dismissedOne.kind)).toBe(false);
    expect(existsSync(path.join(again!.outDir, 'markers.json'))).toBe(true);
  }, 180_000);

  it('ny versjon (_v2): markørene foreslås fra v1 som ubekreftede', async () => {
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=110:d=40', '-af', "volume='if(lt(t,12),0.15,0.85)':eval=frame", '-ac', '2', path.join(exportDir, 'Night Run_v2.wav')]);
    const release = (await scanFlat(exportDir, cfg)).releases.find((r) => r.slug === 'night-run')!;
    const results = await ingestRelease(release, { mediaDir, config: cfg });
    const v2 = results.find((r) => r.manifest.version === 2)!;
    const d1 = v2.manifest.markers.find((k) => k.label === 'Drop 1')!;
    expect(d1).toMatchObject({ startMs: 20_000, confirmed: false });
    expect(existsSync(path.join(v2.outDir, 'markers.json'))).toBe(false); // ikke rettet ennå
  }, 180_000);

  it('ekte struktur (fixtures/blue-fire): flyttet Drop 1 og slettet DROP-forslag står seg etter --force', async () => {
    const fixture = path.resolve(__dirname, '../../../fixtures/blue-fire');
    if (!existsSync(fixture)) return;
    const release = await releaseFromFolder(fixture, cfg);
    const results = await ingestRelease(release, { mediaDir, config: cfg });
    const main = results.find((r) => r.manifest.variant === null)!;
    const v = main.manifest.version;
    const url = `/api/assets/blue-fire/main/v${v}/markers`;
    const got = (await (await fetch(base + url)).json()) as { markers: AssetMarker[] };
    const drop1 = got.markers.find((m) => m.kind === 'chapter' && m.label === 'Drop 1')!;
    const dropSuggestion = got.markers.find((m) => m.kind === 'drop');
    expect(drop1).toBeTruthy();
    const moved = drop1.startMs + 2000;
    const edited = got.markers.filter((m) => m !== dropSuggestion).map((m) => (m === drop1 ? { ...m, startMs: moved, source: 'manual' as const, confirmed: true } : m));
    const dismissed = dropSuggestion ? [`drop:${(dropSuggestion.label ?? '').toLowerCase()}`] : [];
    expect((await post(url, { markers: edited, dismissed })).status).toBe(200);

    const again = await ingestRelease(release, { mediaDir, config: cfg, force: true });
    const m = again.find((r) => r.manifest.variant === null)!.manifest;
    const chapters = m.markers.filter((k) => k.kind === 'chapter' && k.label === 'Drop 1');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({ startMs: moved, source: 'manual', confirmed: true });
    if (dropSuggestion) expect(m.markers.some((k) => k.kind === 'drop')).toBe(false);
    // Analyseforslag Knut ikke har rørt, kommer fortsatt fra analysen
    expect(m.markers.some((k) => k.label === 'Intro')).toBe(true);
  }, 240_000);

  it('validering: tid utenfor låta, ukjent type, krever JSON', async () => {
    const url = `/api/assets/night-run/main/v1/markers`;
    expect((await post(url, { markers: [{ kind: 'chapter', label: 'X', startMs: 999_999 }] })).status).toBe(400);
    expect((await post(url, { markers: [{ kind: 'boom', startMs: 1 }] })).status).toBe(400);
    expect((await post(url, { markers: [] }, 'text/plain')).status).toBe(415);
    expect((await fetch(base + '/api/assets/finnes-ikke/main/v1/markers')).status).toBe(404);
  });
});
