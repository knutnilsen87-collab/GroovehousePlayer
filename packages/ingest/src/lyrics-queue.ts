import { existsSync } from 'node:fs';
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
  mode: 'auto' | 'aligned' | null;
  reason: 'ingest' | 'studio' | 'pasted';
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
}

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
      if (existing && existing.format === 'lrc' && hasWordTimes(existing.text) && job.reason === 'ingest') {
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
      log(`  ✓ Tekst: ${job.title} – ${res.wordCount} ord (${res.mode === 'auto' ? 'automatisk, sjekk teksten' : 'ordtider'}) på ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (err) {
      job.status = 'failed';
      job.note = err instanceof Error ? err.message.split('\n')[0]!.slice(0, 300) : String(err);
      log(`  ✗ Tekst: ${job.title} – ${job.note}`);
    } finally {
      job.stage = null;
      job.finishedAt = now();
      job.ms = Date.now() - t0;
      sidecars.delete(job.slug);
      trim();
    }
  }

  function kick() {
    if (busy) return;
    busy = (async () => {
      for (let job = jobs.find((j) => j.status === 'waiting'); job; job = jobs.find((j) => j.status === 'waiting')) await work(job);
    })().finally(() => {
      busy = null;
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
      return { enabled: settings().auto, python: existsSync(p) ? '.venv-lyrics' : null, jobs: jobs.map((j) => ({ ...j })) };
    },
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
