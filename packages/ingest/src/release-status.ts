import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetManifest, CatalogIndex } from '@gv/shared';

/**
 * Del 24 pkt. 4: utgivelsesstatus per låt (data/release-status.json).
 * Ikke planlagt → Til mastering → Forberedt → Sendt til LANDR → Planlagt (dato) → Ute.
 */
export const RELEASE_STATUSES = ['none', 'mastering', 'prepared', 'sent', 'planned', 'out'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export interface ReleaseStatusEntry {
  status: ReleaseStatus;
  date?: string;
  relDir?: string;
  at: string;
}

export async function readReleaseStatus(dataDir: string): Promise<Record<string, ReleaseStatusEntry>> {
  try {
    return ((JSON.parse(await readFile(path.join(dataDir, 'release-status.json'), 'utf8')) as { items?: Record<string, ReleaseStatusEntry> }).items ?? {}) as Record<string, ReleaseStatusEntry>;
  } catch {
    return {};
  }
}

let chain: Promise<unknown> = Promise.resolve();
export function setReleaseStatus(dataDir: string, slugs: string[], patch: Partial<ReleaseStatusEntry> & { status: ReleaseStatus }): Promise<Record<string, ReleaseStatusEntry>> {
  const p = chain.then(async () => {
    const items = await readReleaseStatus(dataDir);
    for (const s of slugs) {
      if (patch.status === 'none') delete items[s];
      else items[s] = { ...items[s], ...patch, at: new Date().toISOString() };
    }
    await mkdir(dataDir, { recursive: true });
    const f = path.join(dataDir, 'release-status.json');
    await writeFile(`${f}.tmp`, JSON.stringify({ schema: 1, items }, null, 2));
    await rename(`${f}.tmp`, f);
    return items;
  });
  chain = p.catch(() => {});
  return p;
}

/** «Ute»: versjonen som ble gitt ut, får status Utgitt (manifest og index). Endrer ikke lyden. */
export async function markReleased(mediaDir: string, slug: string, variant: string | null, version: number): Promise<boolean> {
  const media = path.resolve(mediaDir);
  const idxFile = path.join(media, 'index.json');
  if (!existsSync(idxFile)) return false;
  const idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
  const e = idx.assets.find((a) => a.slug === slug && (a.variant ?? null) === (variant ?? null) && a.version === version);
  if (!e || e.status === 'draft') return false;
  const mf = path.join(media, e.manifest);
  const m = JSON.parse(await readFile(mf, 'utf8')) as AssetManifest;
  if (m.status === 'released') return false;
  await writeFile(`${mf}.tmp`, JSON.stringify({ ...m, status: 'released' }, null, 2));
  await rename(`${mf}.tmp`, mf);
  e.status = 'released';
  idx.updatedAt = new Date().toISOString();
  await writeFile(`${idxFile}.tmp`, JSON.stringify(idx, null, 2));
  await rename(`${idxFile}.tmp`, idxFile);
  return true;
}
