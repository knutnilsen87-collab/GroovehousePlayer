import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Loudness } from '@gv/shared';
import { FFMPEG, run } from './ffmpeg';

/** Målnivå ved avspilling. Masteren endres aldri; vi lagrer bare en gain. */
export const TARGET_LUFS = -14;

export async function encodeHls(input: string, outDir: string): Promise<string> {
  const hlsDir = path.join(outDir, 'hls');
  await mkdir(hlsDir, { recursive: true });
  await run(FFMPEG, [
    '-v', 'error', '-y',
    '-i', input,
    '-vn',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
    path.join(hlsDir, 'index.m3u8')
  ]);
  return 'hls/index.m3u8';
}

export async function measureLoudness(input: string): Promise<Loudness> {
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
  let gain = TARGET_LUFS - integrated;
  if (gain > 0) gain = Math.min(gain, truePeak !== null ? Math.max(0, -1 - truePeak) : 0);
  return { integratedLufs: integrated, truePeakDbtp: truePeak, lra, playbackGainDb: Math.round(gain * 10) / 10 };
}

export async function encodePreview(input: string, outDir: string, startMs: number, durationMs: number): Promise<string> {
  const len = Math.min(30, Math.max(5, Math.floor(durationMs / 1000) - 1));
  const start = Math.max(0, Math.min(startMs / 1000, durationMs / 1000 - len));
  await run(FFMPEG, [
    '-v', 'error', '-y',
    '-ss', start.toFixed(2), '-t', String(len),
    '-i', input,
    '-vn',
    '-af', `afade=t=in:st=0:d=1,afade=t=out:st=${len - 1.5}:d=1.5`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    path.join(outDir, 'preview.m4a')
  ]);
  return 'preview.m4a';
}
