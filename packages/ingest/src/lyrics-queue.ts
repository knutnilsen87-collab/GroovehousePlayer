import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findRoot, loadConfig } from './config';
import { createLyricsStore, type LyricsStore } from './library';
import { transcribeLyricsForSlug, type LyricsStage } from './lyrics-sync';

/**
 * Bakgrunnskø for tekst (Demucs + WhisperX). Ingest legger låta her og går videre; køen kjører én jobb
 * om gangen i samme prosess, så den stopper aldri ingest. Studio leser status via GET /api/lyrics-queue.
 *
 * Rekkefølge for hver låt:
 *  1. Har låta allerede ordtider (LRC med <mm:ss>-tagger) → hopp over.
 *  2. Tekst limt inn i Studio (data/lyrics/<slug>.txt) → bare ordtider (forced alignment).
 *  3. .txt med samme navn som lydfila i eksport-/utkastmappa → bare ordtider.
 *  4. Ellers transkriberes lyden, og teksten merkes «Auto – sjekk teksten» til Knut godkjenner den.
 *
 * Av/på: Innstillinger → Tekst (`lyrics.auto` i groovehouse.config.json). Av gjelder bare automatikken
 * etter ingest; «Synkroniser nå» i Studio virker fortsatt.
 */

export type LyricsJobStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
export interface LyricsJob {
  slug: string;
  title: string;
  status: LyricsJobStatus;
  /** Hva som skjer nå (bare når status = running). */
  stage: LyricsStage | 'start' | null;
  /** auto = transkribert fra lyden, aligned = Knuts tekst med ordtider. */
  mode: 'auto' | 'aligned' | 'instrumental' | null;
  reason: 'ingest' | 'studio' | 'pasted' | 'batch';
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ms: number | null;
  words: number | null;
  note: string | null;
}
export interface LyricsQueueStatus {
  enabled: boolean;
  python: string | null;
  jobs: LyricsJob[];
  batch: BatchStatus | null;
}

/**
 * Nattkjøring: tekst på mange låter. Lagres i data/lyrics-batch.json (overlever omstart), kjører bare i
 * nattvinduet (standard 01–07) og bare når ingen andre tekstjobber venter. Kan settes på pause i Studio.
 */
export interface BatchFile {
  slugs: Array<{ slug: string; title: string }>;
  done: string[];
  paused: boolean;
  window: { from: number; to: number };
  startedAt: string;
}
export interface BatchStatus {
  total: number;
  done: number;
  paused: boolean;
  inWindow: boolean;
  window: { from: number; to: number };
  next: string | null;
}
export const inNightWindow = (d: Date, w: { from: number; to: number }) => {
  const h = d.getHours();
  return w.from <= w.to ? h >= w.from && h < w.to : h >= w.from || h < w.to;
};

/** Har teksten ordtider (Enhanced LRC)? */
export const hasWordTimes = (text: string) => /<\d{1,2}:\d{2}(?:\.\d+)?>/.test(text);

/** .txt ved siden av lydfila (samme navn), hvis den finnes. */
export async function sidecarText(audioFile: string | null | undefined): Promise<string | null> {
  if (!audioFile) return null;
  const f = audioFile.replace(/\.[^.\\/]+$/, '.txt');
  if (f === audioFile || !existsSync(f)) return null;
  const t = (await readFile(f, 'utf8')).replace(/^﻿/, '').trim();
  return t || null;
}

export interface LyricsQueueOptions {
  mediaDir: string;
  dataDir: string;
  root?: string;
  log?: (line: string) => void;
  /** Leses ved hver jobb, så endringer i Innstillinger gjelder uten omstart. */
  settings?: () => { auto: boolean; model: string; language: string | null };
  /** Kan byttes i tester. */
  run?: typeof transcribeLyricsForSlug;
  /** Klokka (tester). */
  clock?: () => Date;
}

const HISTORY = 30;

export function createLyricsQueue(opts: LyricsQueueOptions) {
  const root = opts.root ?? findRoot(opts.mediaDir);
  const store: LyricsStore = createLyricsStore(path.join(opts.dataDir, 'lyrics'));
  const settings = opts.settings ?? (() => loadConfig(root).lyrics);
  const run = opts.run ?? transcribeLyricsForSlug;
  const log = opts.log ?? (() => {});
  const jobs: LyricsJob[] = [];
  const sidecars = new Map<string, string | null>();
  let busy: Promise<void> | null = null;
  const clock = opts.clock ?? (() => new Date());
  const batchPath = path.join(opts.dataDir, 'lyrics-batch.json');
  const readBatch = (): BatchFile | null => {
    try {
      return existsSync(batchPath) ? (JSON.parse(readFileSync(batchPath, 'utf8')) as BatchFile) : null;
    } catch {
      return null;
    }
  };
  const writeBatch = (b: BatchFile | null) => {
    if (!b) return void rmSync(batchPath, { force: true });
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(`${batchPath}.tmp`, JSON.stringify(b, null, 2));
    renameSync(`${batchPath}.tmp`, batchPath);
  };
  /** Legger neste låt fra nattkjøringen i køen hvis det er natt, ikke pause, og ingenting annet venter. */
  const feedBatch = () => {
    const b = readBatch();
    if (!b || b.paused || !inNightWindow(clock(), b.window)) return;
    if (jobs.some((j) => j.status === 'waiting' || j.status === 'running')) return;
    const next = b.slugs.find((x) => !b.done.includes(x.slug));
    if (!next) {
      log(`♪ Nattkjøring ferdig: tekst på ${b.done.length} låter`);
      writeBatch(null);
      return;
    }
    const job: LyricsJob = { slug: next.slug, title: next.title, status: 'waiting', stage: null, mode: null, reason: 'batch', queuedAt: now(), startedAt: null, finishedAt: null, ms: null, words: null, note: null };
    jobs.push(job);
    kick();
  };
  const markBatchDone = (slug: string) => {
    const b = readBatch();
    if (!b || b.done.includes(slug)) return;
    b.done.push(slug);
    writeBatch(b);
  };
  const tick = setInterval(feedBatch, 60_000);
  tick.unref?.();

  const now = () => new Date().toISOString();
  const trim = () => {
    const finished = jobs.filter((j) => j.status !== 'waiting' && j.status !== 'running');
    for (const old of finished.slice(0, Math.max(0, finished.length - HISTORY))) jobs.splice(jobs.indexOf(old), 1);
  };

  async function work(job: LyricsJob) {
    job.status = 'running';
    job.stage = 'start';
    job.startedAt = now();
    const t0 = Date.now();
    try {
      const existing = await store.get(job.slug);
      const meta = await store.getMeta(job.slug);
      if (meta?.source === 'instrumental' && job.reason !== 'studio') {
        job.status = 'skipped';
        job.note = 'instrumental';
        return;
      }
      if (existing && existing.format === 'lrc' && hasWordTimes(existing.text) && job.reason !== 'studio') {
        job.status = 'skipped';
        job.note = 'har ordtider fra før';
        return;
      }
      let text: string | null = null;
      if (existing?.format === 'txt') {
        text = existing.text;
        job.note = 'tekst fra Studio';
      } else {
        text = await sidecarText(sidecars.get(job.slug));
        if (text) job.note = '.txt ved lydfila';
      }
      const s = settings();
      log(`♪ Tekst: ${job.title} – ${text ? 'beregner ordtider for kjent tekst' : 'transkriberer fra lyden'}`);
      const res = await run({
        mediaDir: opts.mediaDir,
        dataDir: opts.dataDir,
        slug: job.slug,
        lyricsStore: store,
        model: s.model,
        language: s.language ?? undefined,
        text,
        onStage: (st) => (job.stage = st)
      });
      job.mode = res.mode;
      job.words = res.wordCount;
      job.status = 'done';
      log(res.mode === 'instrumental' ? `  ✓ Tekst: ${job.title} – instrumental (ingen vokal)` : `  ✓ Tekst: ${job.title} – ${res.wordCount} ord (${res.mode === 'auto' ? 'automatisk, sjekk teksten' : 'ordtider'}) på ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (err) {
      job.status = 'failed';
      job.note = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err);
      log(`  ✗ Tekst: ${job.title} – ${job.note}`);
    } finally {
      job.stage = null;
      job.finishedAt = now();
      job.ms = Date.now() - t0;
      sidecars.delete(job.slug);
      // Nattkjøringen går videre også om én låt feiler (den står som feilet i Studio)
      if (job.reason === 'batch') markBatchDone(job.slug);
      trim();
    }
  }

  function kick() {
    if (busy) return;
    busy = (async () => {
      for (let job = jobs.find((j) => j.status === 'waiting'); job; job = jobs.find((j) => j.status === 'waiting')) await work(job);
    })().finally(() => {
      busy = null;
      feedBatch();
    });
  }

  return {
    /**
     * Legger låta i køen. Fra ingest bare når automatikken er på. `audioFile` = kildefila i eksport-/
     * utkastmappa, så en .txt med samme navn kan brukes. Returnerer jobben, eller null hvis den ikke ble lagt inn.
     */
    enqueue(slug: string, o: { title?: string; audioFile?: string | null; reason?: LyricsJob['reason'] } = {}): LyricsJob | null {
      const reason = o.reason ?? 'ingest';
      // Automatikken (ingest og innliming) kan slås av; «Synkroniser nå» i Studio virker alltid
      if (reason !== 'studio' && !settings().auto) return null;
      if (o.audioFile !== undefined) sidecars.set(slug, o.audioFile);
      const waiting = jobs.find((j) => j.slug === slug && j.status === 'waiting');
      if (waiting) return waiting;
      const job: LyricsJob = { slug, title: o.title ?? slug, status: 'waiting', stage: null, mode: null, reason, queuedAt: now(), startedAt: null, finishedAt: null, ms: null, words: null, note: null };
      jobs.push(job);
      kick();
      return job;
    },
    status(): LyricsQueueStatus {
      const p = path.join(root, '.venv-lyrics');
      const b = readBatch();
      const batch: BatchStatus | null = b
        ? { total: b.slugs.length, done: b.done.length, paused: b.paused, inWindow: inNightWindow(clock(), b.window), window: b.window, next: b.slugs.find((x) => !b.done.includes(x.slug))?.title ?? null }
        : null;
      return { enabled: settings().auto, python: existsSync(p) ? '.venv-lyrics' : null, jobs: jobs.map((j) => ({ ...j })), batch };
    },
    /** Start nattkjøring for disse låtene (erstatter en eventuell gammel liste). */
    startBatch(slugs: Array<{ slug: string; title: string }>, window = { from: 1, to: 7 }) {
      writeBatch({ slugs, done: [], paused: false, window, startedAt: now() });
      feedBatch();
    },
    /** Pause/fortsett/stopp fra Studio. Pause stopper ikke en låt som allerede er i gang. */
    controlBatch(action: 'pause' | 'resume' | 'stop') {
      const b = readBatch();
      if (!b) return false;
      if (action === 'stop') writeBatch(null);
      else writeBatch({ ...b, paused: action === 'pause' });
      if (action === 'resume') feedBatch();
      return true;
    },
    /** Kjør nattkjøringen nå (tester og «Start nå» i Studio). */
    feedBatch,
    close: () => clearInterval(tick),
    /** Venter til en bestemt jobb er ferdig (Studio-knappen «Synkroniser nå» bruker samme kø). */
    wait: async (job: LyricsJob): Promise<LyricsJob> => {
      while (job.status === 'waiting' || job.status === 'running') await new Promise((r) => setTimeout(r, 500));
      return { ...job };
    },
    /** Venter til køen er tom (tester). */
    idle: async () => {
      while (busy) await busy;
    },
    store
  };
}
export type LyricsQueue = ReturnType<typeof createLyricsQueue>;

/** Én kø per datamappe (serveren: watcher og API deler den). */
const shared = new Map<string, LyricsQueue>();
export function sharedLyricsQueue(opts: LyricsQueueOptions): LyricsQueue {
  const key = path.resolve(opts.dataDir);
  let q = shared.get(key);
  if (!q) shared.set(key, (q = createLyricsQueue(opts)));
  return q;
}
