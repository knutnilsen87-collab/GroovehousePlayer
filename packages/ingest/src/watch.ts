#!/usr/bin/env node
import path from 'node:path';
import { watch } from 'chokidar';
import { findRoot, loadConfig, loadDotEnv } from './config';
import { probe } from './ffmpeg';
import { ingestFolder, ingestRelease, type IngestResult } from './ingest';
import { AUDIO_RE, IMAGE_RE, scanFlat } from './sources';

/**
 * Overvåker eksportmappa. Den leses bare: watcheren flytter, endrer eller sletter aldri noe der.
 * Bare nye eller endrede filer etter oppstart utløser ingest (gamle filer: `gh-ingest --backlog`).
 *  - Lydfil rett i mappa (flat): slug og tittel fra filnavnet, cover = bilde med samme navn.
 *  - Bilde rett i mappa: ingester låta med samme navn på nytt med nytt cover.
 *  - Filer i undermapper: release-mappe-konvensjonen (cover.png, meta.json, live_log.json).
 * Reason skriver bounce-fila gradvis, så vi venter til størrelsen har stått stille i 4 s
 * og ffprobe klarer å lese fila. Jobbene kjøres én om gangen.
 */
const root = findRoot();
loadDotEnv(root);
const cfg = loadConfig(root);
const base = process.env.INIT_CWD ?? process.cwd();
const exportDir = path.resolve(base, process.argv[2] ?? process.env.GH_EXPORT_DIR ?? 'fixtures');
const mediaDir = path.resolve(base, process.env.GH_MEDIA_DIR ?? path.join(root, 'media'));
const SUBFOLDER_TRIGGER = /\.(wav|wave|aif|aiff|flac)$|^cover\.(png|jpe?g|webp)$|^live_log\.json$/i;

type Job = { kind: 'flat'; file: string } | { kind: 'folder'; folder: string };
const queue: Job[] = [];
let busy = false;

const say = (step: string, status: string, detail?: string) => {
  if (status === 'start') return;
  const line = `  ${status === 'ok' ? '✓' : status === 'warn' ? '!' : '↷'} ${step.padEnd(10)} ${detail ?? ''}`;
  console.log(step === 'SUNO' ? `\x1b[33;1m${line}\x1b[0m` : line);
};

async function runJob(job: Job): Promise<IngestResult[]> {
  if (job.kind === 'folder') return ingestFolder(job.folder, { mediaDir, config: cfg, report: say });
  const scan = await scanFlat(exportDir, cfg);
  const isImage = IMAGE_RE.test(job.file);
  const release = scan.releases.find((r) => (isImage ? r.coverPath === job.file : r.masters.some((m) => m.path === job.file)));
  if (!release) {
    console.log(isImage ? '  ! fant ingen lydfil med samme navn som bildet – venter' : '  ↷ eldre versjon enn det som finnes – hopper over');
    return [];
  }
  for (const m of release.masters) await probe(m.path); // kaster hvis fila er halvskrevet
  return ingestRelease(release, { mediaDir, config: cfg, report: say });
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    const stamp = new Date().toLocaleTimeString('nb-NO');
    console.log(`\n[${stamp}] ${job.kind === 'flat' ? path.basename(job.file) : path.basename(job.folder) + path.sep}`);
    try {
      for (const res of await runJob(job)) {
        const m = res.manifest;
        console.log(`  ${res.status === 'unchanged' ? '↷ uendret' : '✓ klar'}: ${m.title}${m.variantLabel ? ` (${m.variantLabel})` : ''}${m.bpm ? ` – ${Math.round(m.bpm)} BPM` : ''}${m.key ? ` · ${m.key.camelot}` : ''}`);
      }
    } catch (err) {
      console.error(`  ✗ ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    }
  }
  busy = false;
}

function same(a: Job, b: Job): boolean {
  return a.kind === b.kind && (a.kind === 'flat' ? a.file === (b as typeof a).file : a.folder === (b as { folder: string }).folder);
}

function enqueue(file: string) {
  const name = path.basename(file);
  const folder = path.dirname(file);
  let job: Job | null = null;
  if (path.resolve(folder) === exportDir) {
    if (AUDIO_RE.test(name) || IMAGE_RE.test(name)) job = { kind: 'flat', file: path.resolve(file) };
  } else if (SUBFOLDER_TRIGGER.test(name)) {
    job = { kind: 'folder', folder };
  }
  if (!job || queue.some((q) => same(q, job!))) return;
  queue.push(job);
  void drain();
}

console.log(`Watcher aktiv (leser bare – flytter eller endrer aldri noe i eksportmappa)\n  eksport: ${exportDir}\n  media:   ${mediaDir}\n  Filer som lå der fra før: kjør «pnpm gh-ingest --backlog»\n  (Ctrl+C for å stoppe)`);
watch(exportDir, {
  depth: 1,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 500 }
})
  .on('add', enqueue)
  .on('change', enqueue)
  .on('error', (e) => console.error('Watcher-feil:', e));
