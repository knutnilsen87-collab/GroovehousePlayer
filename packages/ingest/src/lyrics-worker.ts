import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Vedvarende Python-prosess for tekst (lyrics_sync.py --serve). Demucs-, Whisper- og align-modellene lastes
 * én gang og gjenbrukes for hver låt. Prosessen kjører med lav prioritet (så PC-en er brukbar imens) og
 * avsluttes av seg selv etter 10 minutter uten jobb; neste jobb starter den igjen.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', 'scripts', 'lyrics_sync.py');
export const IDLE_MS = 10 * 60 * 1000;

export interface WorkerJob {
  /** «analyze» = del 20 A (stemmer → groove m.m.), ellers tekst. */
  kind?: 'lyrics' | 'analyze';
  audio: string;
  /** Del 20 A: hvor resultatet skrives, og BPM fra analysen som hint. */
  out?: string;
  bpm?: number | null;
  out_json?: string;
  out_lrc?: string;
  text?: string | null;
  model?: string;
  language?: string | null;
}
export interface WorkerResult {
  ok: boolean;
  instrumental?: boolean;
  ratio?: number;
  words?: number;
  language?: string;
  error?: string;
}

export function createLyricsWorker(opts: { python: string; idleMs?: number; log?: (l: string) => void; spawnFn?: typeof spawn }) {
  const idleMs = opts.idleMs ?? IDLE_MS;
  let proc: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let seq = 0;
  const waiting = new Map<string, { resolve: (r: WorkerResult) => void; onStage?: (s: string) => void }>();

  const stopIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = () => {
    stopIdle();
    if (waiting.size) return;
    idleTimer = setTimeout(() => {
      opts.log?.('♪ Tekst-prosessen avsluttes (10 min uten jobb)');
      proc?.stdin.end();
    }, idleMs);
    idleTimer.unref?.();
  };

  function start(): Promise<void> {
    const p = (opts.spawnFn ?? spawn)(opts.python, [SCRIPT, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }) as ChildProcessWithoutNullStreams;
    proc = p;
    try {
      if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* ikke kritisk */
    }
    ready = new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: p.stdout });
      rl.on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.ready) return resolve();
        const w = waiting.get(String(msg.id));
        if (!w) return;
        waiting.delete(String(msg.id));
        w.resolve(msg as unknown as WorkerResult);
        armIdle();
      });
      createInterface({ input: p.stderr }).on('line', (line) => {
        const m = /^STAGE: (\S+) (\w+)/.exec(line);
        if (m) waiting.get(m[1]!)?.onStage?.(m[2]!);
      });
      p.on('error', (err) => reject(new Error(`Kunne ikke starte Python (${err.message}). Sjekk .venv-lyrics.`)));
      p.on('close', (code) => {
        if (proc === p) {
          proc = null;
          ready = null;
        }
        reject(new Error(`Python avsluttet før den var klar (kode ${code})`));
        for (const [id, w] of waiting) {
          waiting.delete(id);
          w.resolve({ ok: false, error: `Tekst-prosessen stoppet (kode ${code})` });
        }
      });
    });
    return ready;
  }

  return {
    async run(job: WorkerJob, onStage?: (s: string) => void): Promise<WorkerResult> {
      stopIdle();
      if (!proc || !ready) await start();
      else await ready;
      const id = `j${++seq}`;
      return new Promise<WorkerResult>((resolve) => {
        waiting.set(id, { resolve, onStage });
        proc!.stdin.write(JSON.stringify({ id, ...job }) + '\n');
      });
    },
    running: () => !!proc,
    stop: () => {
      stopIdle();
      proc?.stdin.end();
    }
  };
}
export type LyricsWorker = ReturnType<typeof createLyricsWorker>;
