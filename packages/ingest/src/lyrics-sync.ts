import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMaster } from './share';
import type { LyricsStore } from './library';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(here, '..', 'scripts', 'lyrics_sync.py');

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

/**
 * Kjører Demucs + WhisperX-skriptet (packages/ingest/scripts/lyrics_sync.py) på låtas master-lydfil
 * og lagrer både JSON (`data/lyrics/<slug>.words.json`) og Enhanced LRC (`data/lyrics/<slug>.lrc`).
 */
export async function transcribeLyricsForSlug(opts: {
  mediaDir: string;
  dataDir: string;
  slug: string;
  lyricsStore: LyricsStore;
  model?: string;
  language?: string;
}): Promise<{ format: 'lrc' | 'txt'; text: string; wordCount: number }> {
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
  const outLrc = path.join(lyricsDir, `${opts.slug}.lrc`);

  const args = [SCRIPT_PATH, audioFile, outJson, '--lrc', outLrc];
  if (opts.model) args.push('--model', opts.model);
  if (opts.language) args.push('--language', opts.language);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('python', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      reject(new Error(`Kunne ikke starte Python (${err.message}). Sørg for at Python med demucs og whisperx er installert.`));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
        reject(new Error(tail || `Python-transkribering avsluttet med kode ${code}. Sjekk at demucs og whisperx er installert (pip install demucs whisperx).`));
      }
    });
  });

  const lrcText = existsSync(outLrc) ? await readFile(outLrc, 'utf8') : '';
  const jsonText = existsSync(outJson) ? await readFile(outJson, 'utf8') : '[]';
  const words = JSON.parse(jsonText) as unknown[];
  if (!lrcText.trim() && words.length === 0) {
    throw new Error('Fant ingen vokal eller gjenkjennelig tekst i lydsporet.');
  }

  const saved = await opts.lyricsStore.put(opts.slug, 'lrc', lrcText || jsonText);
  return {
    format: saved?.format ?? 'lrc',
    text: saved?.text ?? lrcText,
    wordCount: Array.isArray(words) ? words.length : 0
  };
}
