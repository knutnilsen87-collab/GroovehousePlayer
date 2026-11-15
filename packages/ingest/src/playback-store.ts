import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mergePoint, type PlaybackClaim, type PlaybackPoint } from '@gv/shared';

export interface PlaybackFile {
  schema: 1;
  points: PlaybackPoint[];
  claim: PlaybackClaim | null;
}

const empty = (): PlaybackFile => ({ schema: 1, points: [], claim: null });

let chain: Promise<unknown> = Promise.resolve();
function lock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function read(file: string): Promise<PlaybackFile> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as PlaybackFile;
    return { schema: 1, points: Array.isArray(j.points) ? j.points : [], claim: j.claim ?? null };
  } catch {
    return empty();
  }
}

async function write(file: string, data: PlaybackFile) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

export function savePoint(file: string, incoming: PlaybackPoint, claim: boolean): Promise<PlaybackFile> {
  return lock(async () => {
    const data = await read(file);
    const i = data.points.findIndex((p) => p.slug === incoming.slug && p.variant === incoming.variant);
    const stored = mergePoint(i >= 0 ? data.points[i]! : null, incoming);
    if (i >= 0) data.points[i] = stored;
    else data.points.push(stored);
    if (claim) data.claim = { deviceId: incoming.deviceId, slug: incoming.slug, variant: incoming.variant, at: incoming.updatedAt };
    await write(file, data);
    return data;
  });
}

export function loadPlayback(file: string): Promise<PlaybackFile> {
  return lock(() => read(file));
}
