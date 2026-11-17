import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AssetManifest, CatalogIndex } from '@gv/shared';
import { DEFAULTS, type VaultConfig } from '../src/config';
import { FFMPEG, run } from '../src/ffmpeg';
import { importSkipped } from '../src/import-actions';
import { createFingerprintStore, createHashCache, createSkippedStore } from '../src/incoming';
import { ingestRelease } from '../src/ingest';
import { scanFlat } from '../src/sources';
import { startWatcher } from '../src/watcher';

/**
 * Del 25: mappa for utgitte låter. Samme lyd → kobles som «Utgitt master» (status Utgitt); samme tittel men annen lyd
 * → usikkert, venter på bekreftelse; ny låt → status Utgitt. Mappa leses bare.
 */
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const cfg: VaultConfig = { ...DEFAULTS, defaults: { artist: 'Echo Groove', label: null, copyright: null } };

describe.skipIf(!hasFfmpeg)('utgitte låter (krever ffmpeg)', () => {
  let tmp = '';
  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('kobler, venter på OK og importerer nye – og endrer aldri mappa', async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'gv-rel-'));
    const exportDir = path.join(tmp, 'REASONDONE');
    const releasedDir = path.join(tmp, 'utgitt-sync');
    const mediaDir = path.join(tmp, 'media');
    const dataDir = path.join(tmp, 'data');
    await mkdir(exportDir, { recursive: true });
    await mkdir(path.join(releasedDir, 'LANDR'), { recursive: true });
    const tone = (file: string, f: number, d = 6) => run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${f}:d=${d}`, '-ac', '2', file]);

    // Låt som allerede finnes i Vault (fra REASONDONE)
    await tone(path.join(exportDir, 'Blue Fire.wav'), 110);
    await tone(path.join(exportDir, 'Night Drive.wav'), 220, 9);
    const scan = await scanFlat(exportDir, cfg);
    for (const r of scan.releases) await ingestRelease(r, { mediaDir, config: cfg, status: 'release' });

    // I mappa for utgitte: samme fil (hash), samme tittel med helt annen lyd (usikker), og en ny låt (i undermappe)
    await copyFile(path.join(exportDir, 'Blue Fire.wav'), path.join(releasedDir, 'Blue Fire - LANDR.wav'));
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink', '-ac', '2', path.join(releasedDir, 'Night Drive.wav')]);
    await tone(path.join(releasedDir, 'LANDR', 'Ute Allerede.wav'), 330, 5);
    const before = await snapshot(releasedDir);

    const incoming = { ctx: { mediaDir, dataDir, hashes: createHashCache(dataDir), fingerprints: createFingerprintStore(dataDir) }, skipped: createSkippedStore(dataDir) };
    const w = startWatcher({ exportDir: releasedDir, mediaDir, config: cfg, status: 'released', incoming, log: () => {} });
    try {
      await w.catchUp();
      await w.idle();
    } finally {
      await w.close();
    }

    const idx = JSON.parse(await readFile(path.join(mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
    const of = (slug: string) => idx.assets.filter((a) => a.slug === slug).map((a) => `v${a.version}:${a.status ?? 'release'}`).sort();
    // 1) Samme lyd: ny versjon av samme låt, «Utgitt master», status Utgitt
    expect(of('blue-fire')).toEqual(['v1:release', 'v2:released']);
    const bf = JSON.parse(await readFile(path.join(mediaDir, 'blue-fire', 'main', 'v2', 'manifest.json'), 'utf8')) as AssetManifest;
    expect(bf.status).toBe('released');
    expect(bf.versionLabel).toBe('Utgitt master');
    expect(bf.title).toBe('Blue Fire');
    // 2) Samme tittel, annen lyd: IKKE slått sammen – venter i Studio
    expect(of('night-drive')).toEqual(['v1:release']);
    const listed = await incoming.skipped.list();
    expect(listed.map((x) => [x.fileName, x.status, x.matchSlug])).toEqual([['Night Drive.wav', 'released', 'night-drive']]);
    // 3) Ny låt fra undermappe: status Utgitt
    expect(of('ute-allerede')).toEqual(['v1:released']);
    // Mappa er uendret (ingenting flyttet, endret eller slettet)
    expect(await snapshot(releasedDir)).toEqual(before);

    // Ny runde (f.eks. omstart): ingenting importeres på nytt
    const w2 = startWatcher({ exportDir: releasedDir, mediaDir, config: cfg, status: 'released', incoming, log: () => {} });
    try {
      await w2.catchUp();
      await w2.idle();
    } finally {
      await w2.close();
    }
    const idx2 = JSON.parse(await readFile(path.join(mediaDir, 'index.json'), 'utf8')) as CatalogIndex;
    expect(idx2.assets.length).toBe(idx.assets.length);

    // Knut bekrefter det usikre treffet: koblet som Utgitt master
    const it = await incoming.skipped.take(listed[0]!.id);
    const res = await importSkipped(it!, 'version', { mediaDir, cfg });
    expect(res.map((r) => [r.manifest.slug, r.manifest.version, r.manifest.status, r.manifest.versionLabel])).toEqual([['night-drive', 2, 'released', 'Utgitt master']]);
  }, 120_000);
});

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p);
        out.push(`${path.relative(dir, p)}:${s.size}:${s.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return out.sort();
}
