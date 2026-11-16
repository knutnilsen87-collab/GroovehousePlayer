import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DRAFT_BASE, toDraftVersion, type CatalogIndex } from '@gv/shared';
import type { VaultConfig } from './config';
import type { SkippedItem } from './incoming';
import { ingestRelease, type IngestResult } from './ingest';
import { scanFlat } from './sources';

/**
 * Knuts valg i lista «Hoppet over – finnes allerede» (Studio). Ingenting importeres dobbelt uten dette valget.
 *  - «version»: fila blir en ny versjon av låta den ligner på (samme slug og variant, neste versjonsnummer).
 *  - «separate»: fila importeres som en egen låt med egen slug (tittelen fra filnavnet beholdes).
 * Kildefila leses bare.
 */
export async function importSkipped(it: SkippedItem, choice: 'version' | 'separate', o: { mediaDir: string; cfg: VaultConfig }): Promise<IngestResult[]> {
  if (!existsSync(it.file)) throw new Error(`Fila finnes ikke lenger: ${it.file}`);
  const draft = it.status === 'draft';
  const scan = await scanFlat(path.dirname(it.file), o.cfg, { lossy: draft });
  const release = scan.releases.find((r) => r.masters.some((m) => m.path === it.file));
  if (!release) throw new Error('Fant ikke fila i mappa (kanskje en eldre versjon ved siden av en nyere?)');
  const master = release.masters.find((m) => m.path === it.file)!;
  const idx = JSON.parse(await readFile(path.join(path.resolve(o.mediaDir), 'index.json'), 'utf8')) as CatalogIndex;

  if (choice === 'version') {
    const same = idx.assets.filter((a) => a.slug === it.matchSlug && (a.variant ?? null) === (it.matchVariant ?? null));
    const versions = same.map((a) => a.version).filter((v) => (draft ? v > DRAFT_BASE : v <= DRAFT_BASE));
    const next = (versions.length ? Math.max(...versions) : draft ? DRAFT_BASE : 0) + 1;
    master.slug = it.matchSlug;
    master.variant = it.matchVariant;
    master.version = draft ? toDraftVersion(next) : next;
    master.titleFromFile = it.matchTitle;
    release.slug = it.matchSlug;
  } else {
    const taken = new Set(idx.assets.map((a) => a.slug));
    let slug = master.slug;
    for (let n = 2; taken.has(slug); n++) slug = `${master.slug}-${n}`;
    master.slug = slug;
    release.slug = slug;
    if (draft) master.version = toDraftVersion(master.version);
  }
  release.masters = [master];
  return ingestRelease(release, { mediaDir: o.mediaDir, config: o.cfg, status: draft ? 'draft' : 'release' });
}
