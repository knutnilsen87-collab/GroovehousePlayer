import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot } from './config';
import { findMaster } from './share';
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
}): Promise<{ format: 'lrc' | 'txt'; text: string; wordCount: number; mode: 'auto' | 'aligned' }> {
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

  const args = [SCRIPT_PATH, audioFile, outJson, '--lrc', outLrc];
  let tmpDir: string | null = null;
  if (mode === 'aligned') {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gv-lyrics-'));
    const tf = path.join(tmpDir, 'text.txt');
    await writeFile(tf, opts.text!, 'utf8');
    args.push('--text', tf);
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.language) args.push('--language', opts.language);
  const python = opts.python ?? lyricsPython(findRoot(opts.mediaDir));

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        stderr += s;
        for (const m of s.matchAll(/^STAGE: (\w+)/gm)) opts.onStage?.(m[1] as LyricsStage);
      });
      proc.on('error', (err) => {
        reject(new Error(`Kunne ikke starte Python (${err.message}). Sørg for at Python med demucs og whisperx er installert (.venv-lyrics).`));
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else {
          const tail = stderr.trim().split(/\r?\n/).filter((l) => !l.startsWith('STAGE:')).slice(-4).join(' | ');
          reject(new Error(tail || `Python-transkribering avsluttet med kode ${code}. Sjekk at demucs og whisperx er installert (.venv-lyrics).`));
        }
      });
    });
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
