import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Loudness } from '@gv/shared';
import { FFMPEG, run } from './ffmpeg';

/**
 * Våre egne tags. Alt fra kilden fjernes (-map_metadata -1) før disse settes, og bitexact hindrer
 * ffmpeg i å skrive sin egen «Lavf/Lavc»-signatur. ffmpeg tillater ikke en egen encoder-tag uten
 * å overskrive den, så programnavnet står i handler_name (m4a) og service_provider (HLS/ts).
 */
export interface EmbedTags {
  title: string;
  artist: string | null;
  album: string | null;
  copyright: string | null;
}

export const ENCODER_NAME = 'Groovehouse Vault';

const STRIP = ['-map', '0:a:0', '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact'];

function tagArgs(t: EmbedTags): string[] {
  const out: string[] = [];
  const add = (k: string, v: string | null) => v && out.push('-metadata', `${k}=${v}`);
  add('title', t.title);
  add('artist', t.artist);
  add('album', t.album);
  add('copyright', t.copyright);
  out.push('-metadata:s:a:0', `handler_name=${ENCODER_NAME}`);
  return out;
}

/** Målnivå ved avspilling. Masteren endres aldri; vi lagrer bare en gain. */
export const TARGET_LUFS = -14;

/** Del 16: første passering av loudnorm (måling). Brukes bare for utkast. */
export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}
export async function measureLoudnorm(input: string, targetLufs: number): Promise<LoudnormMeasure> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', input, '-af', `loudnorm=I=${targetLufs}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-']);
  const m = stderr.slice(stderr.lastIndexOf('{')).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Klarte ikke å lese loudnorm-målingen');
  return JSON.parse(m[0]) as LoudnormMeasure;
}
/** Filteret for andre passering: lineær normalisering til målet, true peak −1 dBTP. */
export const loudnormFilter = (targetLufs: number, m: LoudnormMeasure) =>
  `loudnorm=I=${targetLufs}:TP=-1:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;

export async function encodeHls(input: string, outDir: string, onProgress?: (ms: number) => void, filter?: string): Promise<string> {
  const hlsDir = path.join(outDir, 'hls');
  await mkdir(hlsDir, { recursive: true });
  await run(FFMPEG, [
    '-v', 'error', '-y',
    ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []),
    '-i', input,
    ...STRIP,
    '-metadata', `service_provider=${ENCODER_NAME}`,
    '-metadata', `service_name=${ENCODER_NAME}`,
    ...(filter ? ['-af', filter] : []),
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
    path.join(hlsDir, 'index.m3u8')
  ], { onProgress });
  return 'hls/index.m3u8';
}

export async function measureLoudness(input: string, targetLufs = TARGET_LUFS): Promise<Loudness> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', input, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  // Bruk sammendraget nederst i loggen
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => {
    const m = summary.match(re);
    return m ? Number(m[1]) : null;
  };
  const integrated = num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  if (integrated === null || !Number.isFinite(integrated)) throw new Error('Klarte ikke å lese LUFS fra ebur128');
  const truePeak = num(/Peak:\s+(-?[\d.]+)\s+dBFS/);
  const lra = num(/LRA:\s+(-?[\d.]+)\s+LU/);
  // Aldri løft over 0 dBTP: positiv gain begrenses av headroom.
  let gain = targetLufs - integrated;
  if (gain > 0) gain = Math.min(gain, truePeak !== null ? Math.max(0, -1 - truePeak) : 0);
  return { integratedLufs: integrated, truePeakDbtp: truePeak, lra, playbackGainDb: Math.round(gain * 10) / 10 };
}

export async function encodePreview(input: string, outDir: string, startMs: number, durationMs: number, tags: EmbedTags): Promise<string> {
  const len = Math.min(30, Math.max(5, Math.floor(durationMs / 1000) - 1));
  const start = Math.max(0, Math.min(startMs / 1000, durationMs / 1000 - len));
  await run(FFMPEG, [
    '-v', 'error', '-y',
    '-ss', start.toFixed(2), '-t', String(len),
    '-i', input,
    ...STRIP,
    ...tagArgs(tags),
    '-af', `afade=t=in:st=0:d=1,afade=t=out:st=${len - 1.5}:d=1.5`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    path.join(outDir, 'preview.m4a')
  ]);
  return 'preview.m4a';
}

/** Skriver nye tags i preview.m4a uten å kode lyden på nytt (brukes når Studio endrer tittel o.l.). */
export async function retagPreview(file: string, tags: EmbedTags): Promise<void> {
  const tmp = file.replace(/\.m4a$/, '.retag.m4a');
  await run(FFMPEG, ['-v', 'error', '-y', '-i', file, ...STRIP, ...tagArgs(tags), '-c', 'copy', tmp]);
  await rm(file, { force: true });
  await rename(tmp, file);
}
