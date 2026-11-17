import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preferredVersion, type AssetManifest, type CatalogIndex, type GrooveSummary } from '@gv/shared';
import { findRoot } from './config';
import { lyricsPython, workerFor } from './lyrics-sync';
import { findMaster } from './share';

/**
 * Del 20 A: stem-analyse i bakgrunnen. Én låt om gangen i den samme vedvarende GPU-prosessen som teksten
 * (lyrics_sync.py --serve), så modellene lastes én gang og skjermkortminnet aldri deles mellom to jobber.
 *  - Resultatet (bare tall, ingen lyd) lagres som `stems.json` ved siden av analysis.json, og et sammendrag
 *    som `groove` i manifestet (brukes av settbyggeren og likhetsmålet).
 *  - Hver låt (foretrukket versjon per slug og variant, ikke live-sett) analyseres én gang. Nye versjoner
 *    tas med når de kommer. Pause og fortsett fra Studio; tilstanden ligger i data/stem-analysis.json.
 */
export const STEM_ANALYSIS_VERSION = 1;
export const STEMS_FILE = 'stems.json';

interface StemResult {
  schema: 1;
  grid: { bpm: number | null; firstDownbeatMs: number | null; bars: number[]; barBpm: number[] };
  groove: { swing: number | null; density: number | null; fourOnFloor: boolean | null; hats: number | null };
  bass: { sub: number | null; sustain: number | null; introActive: boolean; outroActive: boolean };
  vocals: Array<[number, number]>;
  vocalShare: number;
  ends: { intro: number | null; outro: number | null; introNoBass: number | null; outroNoBass: number | null };
  device?: string;
}

/** Sammendraget som legges i manifestet. Ren funksjon (testes). */
export function summarize(r: StemResult, at = new Date().toISOString()): GrooveSummary {
  return {
    v: STEM_ANALYSIS_VERSION,
    swing: r.groove.swing,
    density: r.groove.density,
    fourOnFloor: r.groove.fourOnFloor,
    hats: r.groove.hats,
    bassSub: r.bass.sub,
    bassSustain: r.bass.sustain,
    bassIntro: r.bass.introActive,
    bassOutro: r.bass.outroActive,
    introBars: r.ends.intro,
    outroBars: r.ends.outro,
    introNoBass: r.ends.introNoBass,
    outroNoBass: r.ends.outroNoBass,
    vocalShare: r.vocalShare,
    vocals: r.vocals.map(([a, b]) => [Math.round(a), Math.round(b)] as [number, number]),
    firstDownbeatMs: r.grid.firstDownbeatMs,
    gridBpm: r.grid.bpm,
    analyzedAt: at
  };
}

export interface StemJob {
  slug: string;
  variant: string | null;
  version: number;
  title: string;
  dir: string;
}

export interface StemQueueStatus {
  total: number;
  done: number;
  pending: number;
  paused: boolean;
  running: { title: string; startedAt: string } | null;
  failed: Array<{ title: string; error: string }>;
  /** Snittid per låt (s) for de siste. */
  avgSeconds: number | null;
  device: string | null;
}

export function createStemQueue(opts: { mediaDir: string; dataDir: string; root?: string; log?: (l: string) => void; run?: (job: StemJob, out: string, bpm: number | null) => Promise<{ ok: boolean; error?: string; device?: string }> }) {
  const root = opts.root ?? findRoot(opts.mediaDir);
  const log = opts.log ?? (() => {});
  const stateFile = path.join(opts.dataDir, 'stem-analysis.json');
  const readState = (): { paused: boolean; failed: Record<string, string> } => {
    try {
      return { paused: false, failed: {}, ...(JSON.parse(readFileSync(stateFile, 'utf8')) as object) };
    } catch {
      return { paused: false, failed: {} };
    }
  };
  const writeState = (s: { paused: boolean; failed: Record<string, string> }) => {
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(s, null, 2));
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  const run =
    opts.run ??
    (async (job: StemJob, out: string, bpm: number | null) => {
      const w = workerFor(lyricsPython(root));
      const master = findMaster(job.dir);
      if (!master) return { ok: false, error: 'mangler master.flac' };
      return w.run({ kind: 'analyze', audio: master, out, bpm });
    });

  let queue: StemJob[] = [];
  let total = 0;
  let done = 0;
  let running: StemQueueStatus['running'] = null;
  let busy: Promise<void> | null = null;
  let device: string | null = null;
  const times: number[] = [];

  /** Alle låter som mangler analyse (eller har en eldre versjon av den). */
  async function scan(): Promise<StemJob[]> {
    const media = path.resolve(opts.mediaDir);
    const idxFile = path.join(media, 'index.json');
    if (!existsSync(idxFile)) return [];
    const idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
    const groups = new Map<string, CatalogIndex['assets']>();
    for (const a of idx.assets) {
      if (a.kind === 'set') continue;
      const k = `${a.slug}::${a.variant ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    const failed = readState().failed;
    const out: StemJob[] = [];
    let all = 0;
    for (const list of groups.values()) {
      const e = preferredVersion(list);
      if (!e) continue;
      all++;
      const dir = path.dirname(path.join(media, e.manifest));
      const key = `${e.slug}::${e.variant ?? ''}::${e.version}`;
      if (failed[key]) continue;
      const have = existsSync(path.join(dir, STEMS_FILE)) ? (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as AssetManifest).groove : undefined;
      if (have && have.v >= STEM_ANALYSIS_VERSION) continue;
      out.push({ slug: e.slug, variant: e.variant ?? null, version: e.version, title: e.title, dir });
    }
    total = all;
    done = all - out.length;
    return out;
  }

  async function work(job: StemJob) {
    const t0 = Date.now();
    running = { title: job.title, startedAt: new Date().toISOString() };
    const manifestPath = path.join(job.dir, 'manifest.json');
    try {
      const m = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
      const tmp = path.join(job.dir, `${STEMS_FILE}.partial`);
      const r: { ok: boolean; error?: string; device?: string } = await run(job, tmp, m.bpm ?? null);
      if (r.device) device = r.device;
      if (!r.ok) throw new Error(r.error ?? 'ukjent feil');
      const result = JSON.parse(await readFile(tmp, 'utf8')) as StemResult;
      if (result.device) device = result.device;
      await rename(tmp, path.join(job.dir, STEMS_FILE));
      // Manifestet leses på nytt rett før skriving (kan være endret i Studio imens)
      const fresh = JSON.parse(await readFile(manifestPath, 'utf8')) as AssetManifest;
      const next: AssetManifest = { ...fresh, groove: summarize(result) };
      await writeFile(`${manifestPath}.tmp`, JSON.stringify(next, null, 2));
      await rename(`${manifestPath}.tmp`, manifestPath);
      done++;
      times.push(Date.now() - t0);
      if (times.length > 20) times.shift();
      log(`  ✓ Analyse: ${job.title} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      const s = readState();
      s.failed[`${job.slug}::${job.variant ?? ''}::${job.version}`] = err instanceof Error ? err.message.slice(0, 200) : String(err);
      writeState(s);
      log(`  ✗ Analyse: ${job.title} – ${err instanceof Error ? err.message : err}`);
    } finally {
      running = null;
    }
  }

  function kick() {
    if (busy) return;
    busy = (async () => {
      while (queue.length && !readState().paused) await work(queue.shift()!);
    })().finally(() => {
      busy = null;
    });
  }

  return {
    /** Finn alt som mangler og start (i bakgrunnen). */
    async start() {
      queue = await scan();
      if (queue.length) log(`Analyse (del 20 A): ${queue.length} av ${total} låter mangler – kjører én om gangen i bakgrunnen`);
      kick();
    },
    /** Ny versjon fra ingest: ta den med først. */
    async enqueueNew() {
      const fresh = await scan();
      const known = new Set(queue.map((q) => q.dir));
      queue = [...fresh.filter((f) => !known.has(f.dir)), ...queue.filter((q) => fresh.some((f) => f.dir === q.dir))];
      kick();
    },
    status(): StemQueueStatus {
      const s = readState();
      return {
        total,
        done,
        pending: queue.length + (running ? 1 : 0),
        paused: s.paused,
        running,
        failed: Object.entries(s.failed).slice(0, 10).map(([k, e]) => ({ title: k.split('::')[0]!, error: e })),
        avgSeconds: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length / 100) / 10 : null,
        device
      };
    },
    pause() {
      writeState({ ...readState(), paused: true });
    },
    resume() {
      writeState({ ...readState(), paused: false });
      kick();
    },
    /** Prøv feilede på nytt. */
    async retryFailed() {
      writeState({ ...readState(), failed: {} });
      queue = await scan();
      kick();
    },
    idle: async () => {
      while (busy) await busy;
    }
  };
}
export type StemQueue = ReturnType<typeof createStemQueue>;

const shared = new Map<string, StemQueue>();
export function sharedStemQueue(opts: Parameters<typeof createStemQueue>[0]): StemQueue {
  const key = path.resolve(opts.dataDir);
  let q = shared.get(key);
  if (!q) shared.set(key, (q = createStemQueue(opts)));
  return q;
}
