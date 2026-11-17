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

/**
 * Vokalkart fra ordtidene i teksten (WhisperX): ordene slås sammen når pausen er under 2,5 s, og korte biter
 * (under 1 s) fjernes. Treffer vokalen bedre enn vokalstammen alene, som kan ta med pads i introen.
 * Ren funksjon (testes).
 */
export function vocalsFromWords(words: Array<{ start?: number; end?: number }>, gapMs = 2500, minMs = 1000): Array<[number, number]> {
  const w = words
    .map((x) => [Math.round((x.start ?? 0) * 1000), Math.round((x.end ?? 0) * 1000)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of w) {
    const last = out[out.length - 1];
    if (last && a - last[1] < gapMs) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.filter(([a, b]) => b - a >= minMs);
}

/** Bytter vokalkart og ren intro/outro i sammendraget med det ordtidene gir (bass og groove beholdes). */
export function withWordVocals(g: GrooveSummary, vocals: Array<[number, number]>, durationMs: number): GrooveSummary {
  if (!vocals.length || !g.gridBpm) return { ...g, vocals, vocalShare: 0 };
  const bar = 240_000 / g.gridBpm;
  const down = g.firstDownbeatMs ?? 0;
  const r4 = (x: number) => Math.max(0, Math.floor(x / 4) * 4);
  const intro = r4(Math.floor((vocals[0]![0] - down) / bar));
  const outro = r4(Math.floor((durationMs - vocals[vocals.length - 1]![1]) / bar));
  return {
    ...g,
    vocals,
    vocalShare: Math.round((vocals.reduce((s, [a, b]) => s + b - a, 0) / Math.max(1, durationMs)) * 1000) / 1000,
    introBars: intro,
    outroBars: outro,
    introNoBass: g.introNoBass == null ? null : Math.min(g.introNoBass, intro),
    outroNoBass: g.outroNoBass == null ? null : Math.min(g.outroNoBass, outro),
    vocalSource: 'words'
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
  const retried = new Set<string>();

  /** Ordtidene fra teksten, hvis låta har dem (data/lyrics/<slug>.words.json). */
  async function preferWords(slug: string, g: GrooveSummary, durationMs: number): Promise<GrooveSummary> {
    const wf = path.join(opts.dataDir, 'lyrics', `${slug}.words.json`);
    if (!existsSync(wf)) return g;
    try {
      const words = JSON.parse(await readFile(wf, 'utf8')) as Array<{ start?: number; end?: number }>;
      return Array.isArray(words) && words.length >= 10 ? withWordVocals(g, vocalsFromWords(words), durationMs) : g;
    } catch {
      return g;
    }
  }

  /** Analyserte låter som har fått tekst siden: vokalkart og ren intro/outro fra ordene. */
  async function refreshFromWords(): Promise<number> {
    const media = path.resolve(opts.mediaDir);
    const idxFile = path.join(media, 'index.json');
    if (!existsSync(idxFile)) return 0;
    const idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
    let n = 0;
    for (const e of idx.assets) {
      const mp = path.join(media, e.manifest);
      if (!existsSync(path.join(path.dirname(mp), STEMS_FILE))) continue;
      const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
      if (!m.groove || m.groove.vocalSource === 'words') continue;
      const g = await preferWords(m.slug, m.groove, m.durationMs);
      if (g === m.groove) continue;
      await writeFile(`${mp}.tmp`, JSON.stringify({ ...m, groove: g }, null, 2));
      await rename(`${mp}.tmp`, mp);
      n++;
    }
    return n;
  }

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
      const next: AssetManifest = { ...fresh, groove: await preferWords(job.slug, summarize(result), fresh.durationMs) };
      await writeFile(`${manifestPath}.tmp`, JSON.stringify(next, null, 2));
      await rename(`${manifestPath}.tmp`, manifestPath);
      done++;
      times.push(Date.now() - t0);
      if (times.length > 20) times.shift();
      log(`  ✓ Analyse: ${job.title} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (err) {
      // Prosessen stoppet (krasj eller omstart): prøv låta én gang til senere, ikke merk den som feilet
      if (err instanceof Error && /prosessen stoppet/i.test(err.message) && !retried.has(job.dir)) {
        retried.add(job.dir);
        queue.push(job);
        log(`  ↻ Analyse: ${job.title} – prøves igjen (${err.message})`);
        return;
      }
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
      const fixed = await refreshFromWords().catch(() => 0);
      if (fixed) log(`Analyse: vokalkart fra teksten for ${fixed} låter`);
      // Ny tekst kommer i bakgrunnen: sjekk hvert 10. minutt
      setInterval(() => void refreshFromWords().catch(() => 0), 10 * 60_000).unref?.();
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
