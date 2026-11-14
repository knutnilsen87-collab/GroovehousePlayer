import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { VaultConfig } from './config';
import { probe } from './ffmpeg';
import { ingestFolder, ingestRelease, type IngestResult, type StepStatus } from './ingest';
import { AUDIO_RE, IMAGE_RE, scanFlat } from './sources';

/**
 * Overvåker eksportmappa. Den leses bare: watcheren flytter, endrer eller sletter aldri noe der.
 * Bare nye eller endrede filer etter oppstart utløser ingest (gamle filer: `gh-ingest --backlog`).
 *  - Lydfil rett i mappa (flat): slug og tittel fra filnavnet, cover = bilde med samme navn.
 *  - Bilde rett i mappa: ingester låta med samme navn på nytt med nytt cover.
 *  - Filer i undermapper: release-mappe-konvensjonen (cover.png, meta.json, live_log.json).
 * Reason skriver bounce-fila gradvis, så vi venter til størrelsen har stått stille i 4 s
 * og ffprobe klarer å lese fila. Jobbene kjøres én om gangen.
 *
 * Brukes av gh-watch (CLI) og av apps/server (i samme prosess).
 */
export interface WatcherOptions {
  exportDir: string;
  mediaDir: string;
  config: VaultConfig;
  log?: (line: string) => void;
  /** Kalles for hver variant som faktisk ble ingestet eller fikk nye tags. */
  onIngested?: (res: IngestResult) => void;
  /**
   * Del 16: «draft» = utkastmappa (eller data/drafts-inbox). Alle lydfiler, også i undermapper (prosjekter),
   * behandles som flate filer i sin egen mappe og ingestes som utkast.
   */
  status?: 'release' | 'draft';
}

const SUBFOLDER_TRIGGER = /\.(wav|wave|aif|aiff|flac)$|^cover\.(png|jpe?g|webp)$|^live_log\.json$/i;

type Job = { kind: 'flat'; file: string } | { kind: 'folder'; folder: string };

export interface WatcherStatus {
  exportDir: string;
  /** Jobber i kø, inkludert den som kjører nå. */
  queued: number;
  busy: boolean;
  lastEvent: { at: string; text: string } | null;
}

export function startWatcher(opts: WatcherOptions): { close: () => Promise<void>; idle: () => Promise<void>; status: () => WatcherStatus } {
  const exportDir = path.resolve(opts.exportDir);
  const drafts = opts.status === 'draft';
  const log = opts.log ?? ((l: string) => console.log(l));
  const queue: Job[] = [];
  let busy: Promise<void> | null = null;
  let lastEvent: WatcherStatus['lastEvent'] = null;
  const event = (text: string) => (lastEvent = { at: new Date().toISOString(), text });

  let lastTen = -1;
  const say = (step: string, status: StepStatus, detail?: string) => {
    if (status === 'start') return;
    // Del 4: lange sett – loggen får hver 10. prosent (Studio leser alt fra media/ingest-progress.json)
    if (status === 'progress') {
      const ten = Math.floor(parseInt(detail ?? '0', 10) / 10);
      if (ten === lastTen) return;
      lastTen = ten;
      return log(`  ⏳ ${step.padEnd(10)} ${detail ?? ''}`);
    }
    log(`  ${status === 'ok' ? '✓' : status === 'warn' ? '!' : '↷'} ${step.padEnd(10)} ${detail ?? ''}`);
  };

  async function runJob(job: Job): Promise<IngestResult[]> {
    if (job.kind === 'folder') return ingestFolder(job.folder, { mediaDir: opts.mediaDir, config: opts.config, report: say, status: opts.status });
    // Utkast: fila tolkes i sin egen mappe (prosjektmapper); release: rett i eksportmappa som før
    const scan = await scanFlat(drafts ? path.dirname(job.file) : exportDir, opts.config);
    const isImage = IMAGE_RE.test(job.file);
    const release = scan.releases.find((r) => (isImage ? r.coverPath === job.file : r.masters.some((m) => m.path === job.file)));
    if (!release) {
      log(isImage ? '  ! fant ingen lydfil med samme navn som bildet – venter' : '  ↷ eldre versjon enn det som finnes – hopper over');
      return [];
    }
    for (const m of release.masters) await probe(m.path); // kaster hvis fila er halvskrevet
    return ingestRelease(release, { mediaDir: opts.mediaDir, config: opts.config, report: say, status: opts.status });
  }

  async function drainLoop() {
    while (queue.length) {
      const job = queue.shift()!;
      const stamp = new Date().toLocaleTimeString('nb-NO');
      log(`[${stamp}] ${job.kind === 'flat' ? path.basename(job.file) : path.basename(job.folder) + path.sep}`);
      try {
        for (const res of await runJob(job)) {
          const m = res.manifest;
          log(`  ${res.status === 'unchanged' ? '↷ uendret' : '✓ klar'}: ${m.title}${m.variantLabel ? ` (${m.variantLabel})` : ''}${m.bpm ? ` – ${Math.round(m.bpm)} BPM` : ''}${m.key ? ` · ${m.key.camelot}` : ''}`);
          event(`${res.status === 'unchanged' ? 'uendret' : 'klar'}: ${m.title}${m.variantLabel ? ` (${m.variantLabel})` : ''}`);
          if (res.status !== 'unchanged') opts.onIngested?.(res);
        }
      } catch (err) {
        log(`  ✗ ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        event(`feil: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
  }

  function kick() {
    if (busy) return;
    busy = drainLoop().finally(() => {
      busy = null;
      if (queue.length) kick();
    });
  }

  const same = (a: Job, b: Job) => (a.kind === 'flat' && b.kind === 'flat' ? a.file === b.file : a.kind === 'folder' && b.kind === 'folder' && a.folder === b.folder);

  function enqueue(file: string) {
    const name = path.basename(file);
    const folder = path.dirname(file);
    let job: Job | null = null;
    if (drafts || path.resolve(folder) === exportDir) {
      if (AUDIO_RE.test(name) || IMAGE_RE.test(name)) job = { kind: 'flat', file: path.resolve(file) };
    } else if (SUBFOLDER_TRIGGER.test(name)) {
      job = { kind: 'folder', folder };
    }
    if (!job || queue.some((q) => same(q, job!))) return;
    queue.push(job);
    kick();
  }

  const w: FSWatcher = watch(exportDir, {
    depth: drafts ? 8 : 1,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 4000, pollInterval: 500 }
  })
    .on('add', enqueue)
    .on('change', enqueue)
    .on('error', (e) => log(`Watcher-feil: ${e instanceof Error ? e.message : String(e)}`));

  return {
    close: async () => {
      await w.close();
      await busy;
    },
    status: () => ({ exportDir, queued: queue.length + (busy ? 1 : 0), busy: !!busy, lastEvent }),
    /** Venter til køen er tom (brukes i tester). */
    idle: async () => {
      while (busy) await busy;
    }
  };
}
