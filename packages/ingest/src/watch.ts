#!/usr/bin/env node
import path from 'node:path';
import { watch } from 'chokidar';
import { probe } from './ffmpeg';
import { ingestFolder } from './ingest';

/**
 * Overvåker eksportmappa. Reason skriver bounce-filen gradvis, så vi venter til:
 *  1) størrelsen har stått stille i 4 s (awaitWriteFinish), og
 *  2) ffprobe klarer å lese en gyldig lydstrøm.
 * Deretter kjøres ingest på hele release-mappa. Jobbene kjøres én om gangen.
 */
const base = process.env.INIT_CWD ?? process.cwd();
const exportDir = path.resolve(base, process.argv[2] ?? process.env.GH_EXPORT_DIR ?? 'fixtures');
const mediaDir = path.resolve(base, process.env.GH_MEDIA_DIR ?? 'media');
const TRIGGER = /\.(wav|wave|aif|aiff|flac)$|^cover\.(png|jpe?g|webp)$|^live_log\.json$/i;

const queue: string[] = [];
let busy = false;

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const folder = queue.shift()!;
    const stamp = new Date().toLocaleTimeString('nb-NO');
    console.log(`\n[${stamp}] ${path.basename(folder)}`);
    try {
      const wav = await firstAudio(folder);
      if (!wav) {
        console.log('  ! ingen lydfil ennå – venter');
        continue;
      }
      await probe(wav); // kaster hvis fila er halvskrevet
      const results = await ingestFolder(folder, {
        mediaDir,
        report: (step, status, detail) => status !== 'start' && console.log(`  ${status === 'ok' ? '✓' : status === 'warn' ? '!' : '↷'} ${step.padEnd(10)} ${detail ?? ''}`)
      });
      for (const res of results) console.log(`  ${res.status === 'ingested' ? '✓ klar' : '↷ uendret'}: ${res.manifest.title}${res.manifest.variantLabel ? ` (${res.manifest.variantLabel})` : ''}`);
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  busy = false;
}

async function firstAudio(folder: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises');
  const f = (await readdir(folder)).find((x) => /\.(wav|wave|aif|aiff|flac)$/i.test(x));
  return f ? path.join(folder, f) : null;
}

function enqueue(file: string) {
  if (!TRIGGER.test(path.basename(file))) return;
  const folder = path.dirname(file);
  if (path.resolve(folder) === exportDir) {
    console.log(`  ! ${path.basename(file)} ligger rett i eksportmappa – legg den i en undermappe <slug>/`);
    return;
  }
  if (!queue.includes(folder)) queue.push(folder);
  void drain();
}

console.log(`Watcher aktiv\n  eksport: ${exportDir}\n  media:   ${mediaDir}\n  (Ctrl+C for å stoppe)`);
watch(exportDir, {
  depth: 1,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 500 }
})
  .on('add', enqueue)
  .on('change', enqueue)
  .on('error', (e) => console.error('Watcher-feil:', e));
