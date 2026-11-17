import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot } from './config';
import { findMaster } from './share';
import { createLyricsWorker, type LyricsWorker } from './lyrics-worker';
import type { LyricsStore } from './library';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(here, '..', 'scripts', 'lyrics_sync.py');

/**
 * Python med demucs og whisperx. Egen venv i prosjektroten (.venv-lyrics, gitignored) hvis den finnes,
 * ellers GH_LYRICS_PYTHON, ellers «python» i PATH.
 */
export function lyricsPython(root = findRoot()): string {
  if (process.env.GH_LYRICS_PYTHON) return process.env.GH_LYRICS_PYTHON;
  const venv = process.platform === 'win32' ? path.join(root, '.venv-lyrics', 'Scripts', 'python.exe') : path.join(root, '.venv-lyrics', 'bin', 'python');
  return existsSync(venv) ? venv : 'python';
}

/** Finner nyeste versjonsmappe i media/<slug>/ som har master.flac eller preview.m4a. */
async function findAudioForSlug(mediaDir: string, slug: string): Promise<string | null> {
  const root = path.join(path.resolve(mediaDir), slug);
  if (!existsSync(root)) return null;
  const candidates: Array<{ version: number; file: string }> = [];
  for (const variantDir of await readdir(root, { withFileTypes: true })) {
    if (!variantDir.isDirectory()) continue;
    for (const vDir of await readdir(path.join(root, variantDir.name), { withFileTypes: true })) {
      if (!vDir.isDirectory() || vDir.name.endsWith('.partial')) continue;
      const dir = path.join(root, variantDir.name, vDir.name);
      const vNum = Number(vDir.name.replace(/^v/, '')) || 0;
      const master = findMaster(dir);
      if (master) {
        candidates.push({ version: vNum, file: master });
      } else if (existsSync(path.join(dir, 'preview.m4a'))) {
        candidates.push({ version: vNum, file: path.join(dir, 'preview.m4a') });
      }
    }
  }
  candidates.sort((a, b) => b.version - a.version);
  return candidates[0]?.file ?? null;
}

export type LyricsStage = 'demucs' | 'language' | 'transcribe' | 'align' | 'write';

const workers = new Map<string, LyricsWorker>();
/** Én vedvarende tekst-prosess per Python-tolk. */
export function workerFor(python: string): LyricsWorker {
  let w = workers.get(python);
  if (!w) workers.set(python, (w = createLyricsWorker({ python, log: (l) => console.log(l) })));
  return w;
}

/**
 * Kjører Demucs + WhisperX-skriptet (packages/ingest/scripts/lyrics_sync.py) på låtas master-lydfil
 * og lagrer både JSON (`data/lyrics/<slug>.words.json`) og Enhanced LRC (`data/lyrics/<slug>.lrc`).
 *
 * Med `text` (Knuts egen tekst) beregnes bare ordtidene (forced alignment); ellers transkriberes lyden.
 * Metadata: `auto` (transkribert, merkes «Auto – sjekk teksten» til den er godkjent) eller `aligned`.
 */
export async function transcribeLyricsForSlug(opts: {
  mediaDir: string;
  dataDir: string;
  slug: string;
  lyricsStore: LyricsStore;
  model?: string;
  language?: string;
  /** Kjent tekst: bare ordtider beregnes. */
  text?: string | null;
  python?: string;
  onStage?: (s: LyricsStage) => void;
}): Promise<{ format: 'lrc' | 'txt'; text: string; wordCount: number; mode: 'auto' | 'aligned' | 'instrumental' }> {
  const audioFile = await findAudioForSlug(opts.mediaDir, opts.slug);
  if (!audioFile) {
    throw new Error('Fant ingen lydfil (master.flac) for denne låta i media/.');
  }
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(`Fant ikke Python-skriptet: ${SCRIPT_PATH}`);
  }

  const lyricsDir = path.join(opts.dataDir, 'lyrics');
  await mkdir(lyricsDir, { recursive: true });
  const outJson = path.join(lyricsDir, `${opts.slug}.words.json`);
  const outLrc = path.join(lyricsDir, `${opts.slug}.lrc.tmp`);
  const mode: 'auto' | 'aligned' = opts.text?.trim() ? 'aligned' : 'auto';

  // Vedvarende Python-prosess (modellene lastes én gang); avsluttes selv etter 10 min uten jobb
  const python = opts.python ?? lyricsPython(findRoot(opts.mediaDir));
  const worker = workerFor(python);
  const r = await worker.run({ audio: audioFile, out_json: outJson, out_lrc: outLrc, text: opts.text?.trim() || null, model: opts.model, language: opts.language ?? null }, (st) => opts.onStage?.(st as LyricsStage));
  if (!r.ok) throw new Error(r.error ?? 'tekst-jobben feilet');
  if (r.instrumental) {
    // Demucs fant (nesten) ingen vokal: merkes «Instrumental», WhisperX hoppes over
    await opts.lyricsStore.setMeta(opts.slug, { source: 'instrumental', approved: true });
    return { format: 'txt', text: '', wordCount: 0, mode: 'instrumental' };
  }

  const lrcText = existsSync(outLrc) ? await readFile(outLrc, 'utf8') : '';
  await rm(outLrc, { force: true }).catch(() => {});
  const jsonText = existsSync(outJson) ? await readFile(outJson, 'utf8') : '[]';
  const words = JSON.parse(jsonText) as unknown[];
  if (!lrcText.trim() && words.length === 0) {
    throw new Error('Fant ingen vokal eller gjenkjennelig tekst i lydsporet.');
  }

  const saved = await opts.lyricsStore.put(opts.slug, 'lrc', lrcText || jsonText);
  await opts.lyricsStore.setMeta(opts.slug, { source: mode, approved: mode === 'aligned' });
  return {
    format: saved?.format ?? 'lrc',
    text: saved?.text ?? lrcText,
    wordCount: Array.isArray(words) ? words.length : 0,
    mode
  };
}
