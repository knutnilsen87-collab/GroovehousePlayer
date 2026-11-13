#!/usr/bin/env node
/**
 * Lager to syntetiske testmapper i fixtures/ så du kan prøve hele kjeden uten ekte musikk:
 *  - blue-fire/      96 s «låt» med stille intro og drop ved 0:25, cover og meta.json
 *  - live-sett-demo/ 3 min «sett» med sync-klikk ved 2 s og live_log.json
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { FFMPEG, run } from './ffmpeg';

const base = process.env.INIT_CWD ?? process.cwd();
const root = path.resolve(base, process.argv[2] ?? 'fixtures');

async function main() {
  const track = path.join(root, 'blue-fire');
  const set = path.join(root, 'live-sett-demo');
  await mkdir(track, { recursive: true });
  await mkdir(set, { recursive: true });

  console.log('… lager blue-fire_v2.wav');
  await run(FFMPEG, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', "aevalsrc='(if(lt(t,25),0.22,if(between(t,55,65),0.28,0.85)))*(exp(-mod(t,0.48)*28)*sin(2*PI*52*t)+0.25*sin(2*PI*220*t)*if(lt(t,25),0.3,1))':s=44100:d=96",
    '-ac', '2', path.join(track, 'blue-fire_v2.wav')
  ]);
  console.log('… lager blue-fire__extended_v1.wav (variant)');
  await run(FFMPEG, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', "aevalsrc='(if(lt(t,61.44),0.22,if(between(t,92,122),0.28,0.85)))*(exp(-mod(t,0.48)*28)*sin(2*PI*52*t)+0.25*sin(2*PI*220*t)*if(lt(t,61.44),0.3,1))':s=44100:d=168",
    '-ac', '2', path.join(track, 'blue-fire__extended_v1.wav')
  ]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1400">
<defs><radialGradient id="s" cx="45%" cy="40%" r="60%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.18" stop-color="#36d6f2"/><stop offset="0.6" stop-color="#1d3fd1"/><stop offset="1" stop-color="#0a0f2a"/></radialGradient></defs>
<rect width="1400" height="1400" fill="#06070c"/><circle cx="700" cy="640" r="380" fill="url(#s)"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(track, 'cover.png'));
  await writeFile(path.join(track, 'meta.json'), JSON.stringify({ artist: 'Echo Groove', variants: { extended: 'Extended Mix' } }, null, 2));

  console.log('… lager live-sett-demo.wav');
  await run(FFMPEG, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', "aevalsrc='if(between(t,2,2.02),0.95,0) + (if(lt(t,60),0.4,0.7))*exp(-mod(t,0.48)*28)*sin(2*PI*(if(lt(t,60),55,62))*t)*if(gt(t,3),1,0)':s=44100:d=180",
    '-ac', '2', path.join(set, 'live-sett-demo.wav')
  ]);
  await writeFile(
    path.join(set, 'live_log.json'),
    JSON.stringify(
      {
        schema: 1,
        events: [
          { tMs: 0, type: 'sync' },
          { tMs: 1500, type: 'track', slug: 'blue-fire', label: 'Blue Fire' },
          { tMs: 58000, type: 'track', slug: 'would-you-run', label: 'Would You Run' },
          { tMs: 120000, type: 'highlight', label: 'Publikum tar av' }
        ]
      },
      null,
      2
    )
  );
  await writeFile(path.join(set, 'meta.json'), JSON.stringify({ title: 'Live-sett (demo)', artist: 'Echo Groove', venue: '[Sted]' }, null, 2));
  console.log(`✓ Testmapper i ${root}\n  Neste: pnpm gh-ingest fixtures/blue-fire && pnpm gh-ingest fixtures/live-sett-demo`);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
