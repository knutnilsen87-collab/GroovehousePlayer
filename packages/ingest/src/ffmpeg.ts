import { spawn } from 'node:child_process';

/** ffmpeg/ffprobe finnes på PATH, eller pek på dem med FFMPEG_PATH / FFPROBE_PATH. */
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', (err) => {
      reject(new Error(`Fant ikke "${cmd}". Er ffmpeg installert og på PATH? (${err.message})`));
    });
    p.on('close', (code) => {
      const res = { code: code ?? 1, stdout, stderr };
      if (res.code !== 0 && !opts.allowFail) {
        reject(new Error(`${cmd} feilet (kode ${res.code}):\n${stderr.split('\n').slice(-15).join('\n')}`));
      } else resolve(res);
    });
  });
}

export interface ProbeInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  codec: string;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration',
    '-of', 'json',
    file
  ]);
  const j = JSON.parse(stdout) as {
    streams?: Array<{ codec_name: string; sample_rate: string; channels: number }>;
    format?: { duration?: string };
  };
  const s = j.streams?.[0];
  const dur = Number(j.format?.duration);
  if (!s || !Number.isFinite(dur) || dur <= 0) throw new Error(`ffprobe fant ingen gyldig lydstrøm i ${file}`);
  return { durationMs: Math.round(dur * 1000), sampleRate: Number(s.sample_rate), channels: s.channels, codec: s.codec_name };
}

/** Alle tags i kildefila (format + strømmer), som «nøkkel=verdi». Brukes bare til å varsle om uønskede tags. */
export async function probeTags(file: string): Promise<string[]> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', file], { allowFail: true });
  try {
    const j = JSON.parse(stdout) as { format?: { tags?: Record<string, string> }; streams?: Array<{ tags?: Record<string, string> }> };
    const all = [j.format?.tags ?? {}, ...(j.streams ?? []).map((s) => s.tags ?? {})];
    return all.flatMap((t) => Object.entries(t).map(([k, v]) => `${k}=${v}`));
  } catch {
    return [];
  }
}
