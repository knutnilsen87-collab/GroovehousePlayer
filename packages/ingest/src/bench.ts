/**
 * Del 4: måling av ingest-tid.  pnpm ingest:bench [--keep]
 *
 * Lager en fast 10-minutters testfil (støy + toner, 44,1 kHz/16-bit stereo) og ingester den og fixtures/
 * (blue-fire, live-sett-demo) til en midlertidig mediemappe med --force. Skriver veggtid totalt og per steg.
 * Rører verken media/ eller eksportmappa.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRoot, loadConfig } from './config';
import { FFMPEG, run } from './ffmpeg';
import { ingestRelease, type StepReporter } from './ingest';
import { releaseFromFolder } from './sources';

const root = findRoot(process.cwd());
const cfg = { ...loadConfig(root), exportDir: null };

async function testRelease(dir: string): Promise<string> {
  const folder = path.join(dir, 'bench-10min');
  const wav = path.join(folder, 'bench-10min_v1.wav');
  if (!existsSync(wav)) {
    await mkdir(folder, { recursive: true });
    // Rosa støy med en melodi oppå og en roligere midtdel: realistisk nok for analyse og koding
    await run(FFMPEG, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=600:sample_rate=44100:amplitude=0.25:seed=7',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=600:sample_rate=44100',
      '-filter_complex', "[0][1]amix=inputs=2:normalize=0,volume='if(between(t,240,330),0.3,0.9)':eval=frame,aformat=channel_layouts=stereo",
      '-c:a', 'pcm_s16le', wav
    ]);
  }
  return folder;
}

async function measure(folder: string, mediaDir: string) {
  const release = await releaseFromFolder(folder, cfg);
  const steps = new Map<string, { start: number; ms: number }>();
  const report: StepReporter = (step, status) => {
    const now = performance.now();
    if (status === 'start') steps.set(step, { start: now, ms: 0 });
    else if ((status === 'ok' || status === 'warn') && steps.get(step)?.start && !steps.get(step)!.ms) steps.get(step)!.ms = now - steps.get(step)!.start;
  };
  const t0 = performance.now();
  await ingestRelease(release, { mediaDir, config: cfg, force: true, report });
  return { total: performance.now() - t0, steps: [...steps].filter(([, v]) => v.ms > 0).map(([k, v]) => `${k} ${(v.ms / 1000).toFixed(1)} s`) };
}

const tmp = await mkdtemp(path.join(os.tmpdir(), 'gv-bench-'));
try {
  const cases: Array<[string, string]> = [['10-minutters fil', await testRelease(path.join(os.tmpdir(), 'gv-bench-input'))]];
  for (const f of ['blue-fire', 'live-sett-demo']) if (existsSync(path.join(root, 'fixtures', f))) cases.push([`fixtures/${f}`, path.join(root, 'fixtures', f)]);
  console.log(`Ingest-måling (${os.cpus().length} kjerner, ${os.cpus()[0]?.model.trim()})\n`);
  for (const [name, folder] of cases) {
    const r = await measure(folder, path.join(tmp, 'media'));
    console.log(`${name.padEnd(26)} ${(r.total / 1000).toFixed(1).padStart(6)} s   (${r.steps.join(' · ')})`);
  }
} finally {
  if (!process.argv.includes('--keep')) await rm(tmp, { recursive: true, force: true });
}
