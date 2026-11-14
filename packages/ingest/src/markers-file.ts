import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetManifest, MarkersFile } from '@gv/shared';

/** Del 2: markers.json ved siden av manifest.json i versjonsmappa (media/<slug>/<variant|main>/v<N>/). */
export const MARKERS_FILE = 'markers.json';

export async function readMarkersFile(versionDir: string): Promise<MarkersFile | null> {
  const f = path.join(versionDir, MARKERS_FILE);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(await readFile(f, 'utf8')) as Partial<MarkersFile>;
    return { schema: 1, updatedAt: j.updatedAt ?? new Date(0).toISOString(), markers: Array.isArray(j.markers) ? j.markers : [], dismissed: Array.isArray(j.dismissed) ? j.dismissed : [] };
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  for (let n = 0; ; n++) {
    try {
      return await rename(tmp, file);
    } catch (err) {
      if (n >= 20 || !/EPERM|EBUSY|EACCES/.test(String((err as NodeJS.ErrnoException).code))) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export const writeMarkersFile = (versionDir: string, file: MarkersFile) => writeJsonAtomic(path.join(versionDir, MARKERS_FILE), file);

/**
 * Nyeste tidligere versjon av samme låt og variant der Knut har rettet markørene (har markers.json).
 * Brukes til å foreslå markørene på en ny versjon (_v4).
 */
export async function previousEdited(mediaDir: string, slug: string, variant: string | null, version: number): Promise<{ dir: string; manifest: AssetManifest } | null> {
  const base = path.join(mediaDir, slug, variant ?? 'main');
  if (!existsSync(base)) return null;
  const versions = (await readdir(base))
    .map((d) => /^v(\d+)$/.exec(d))
    .filter((m): m is RegExpExecArray => !!m && Number(m[1]) < version)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const v of versions) {
    const dir = path.join(base, `v${v}`);
    if (!existsSync(path.join(dir, MARKERS_FILE)) || !existsSync(path.join(dir, 'manifest.json'))) continue;
    return { dir, manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as AssetManifest };
  }
  return null;
}
