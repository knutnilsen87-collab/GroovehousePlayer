import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DRAFT_BASE, toDraftVersion, type AssetStatus, type CatalogIndex } from '@gv/shared';
import type { VaultConfig } from './config';
import type { SkippedItem } from './incoming';
import { ingestRelease, type IngestResult } from './ingest';
import { scanFlat, type ReleaseSource } from './sources';

/**
 * Knuts valg i lista «Hoppet over – finnes allerede» (Studio). Ingenting importeres dobbelt uten dette valget.
 *  - «version»: fila blir en ny versjon av låta den ligner på (samme slug og variant, neste versjonsnummer).
 *    For utgitte låter (del 25) heter versjonen «Utgitt master», og låta får status Utgitt.
 *  - «separate»: fila importeres som en egen låt med egen slug (tittelen fra filnavnet beholdes).
 * Kildefila leses bare.
 */
export async function importSkipped(it: SkippedItem, choice: 'version' | 'separate', o: { mediaDir: string; cfg: VaultConfig }): Promise<IngestResult[]> {
  if (!existsSync(it.file)) throw new Error(`Fila finnes ikke lenger: ${it.file}`);
  const status: AssetStatus = it.status ?? 'release';
  const { release, master } = await sourceFor(it.file, status, o.cfg);
  if (choice === 'version') return ingestAsVersionOf(release, master, { slug: it.matchSlug, variant: it.matchVariant, title: it.matchTitle }, status, o);
  const idx = await readIndex(o.mediaDir);
  const taken = new Set(idx.assets.map((a) => a.slug));
  let slug = master.slug;
  for (let n = 2; taken.has(slug); n++) slug = `${master.slug}-${n}`;
  master.slug = slug;
  release.slug = slug;
  if (status === 'draft') master.version = toDraftVersion(master.version);
  release.masters = [master];
  return ingestRelease(release, { mediaDir: o.mediaDir, config: o.cfg, status });
}

/** Fila tolket som release (flat mappe), med lossy-formater for umastrede og utgitte låter. */
export async function sourceFor(file: string, status: AssetStatus, cfg: VaultConfig) {
  const scan = await scanFlat(path.dirname(file), cfg, { lossy: status !== 'release' });
  const release = scan.releases.find((r) => r.masters.some((m) => m.path === file));
  if (!release) throw new Error('Fant ikke fila i mappa (kanskje en eldre versjon ved siden av en nyere?)');
  return { release, master: release.masters.find((m) => m.path === file)! };
}

async function readIndex(mediaDir: string): Promise<CatalogIndex> {
  const f = path.join(path.resolve(mediaDir), 'index.json');
  return existsSync(f) ? (JSON.parse(await readFile(f, 'utf8')) as CatalogIndex) : { schema: 1, updatedAt: '', assets: [] };
}

/** Neste versjonsnummer for låta: utkast i eget nummerområde (1000 + N), release og utgitt i det vanlige. */
export function nextVersionIn(idx: CatalogIndex, slug: string, variant: string | null, status: AssetStatus): number {
  const draft = status === 'draft';
  const versions = idx.assets.filter((a) => a.slug === slug && (a.variant ?? null) === (variant ?? null)).map((a) => a.version).filter((v) => (draft ? v > DRAFT_BASE : v <= DRAFT_BASE));
  const next = (versions.length ? Math.max(...versions) : draft ? DRAFT_BASE : 0) + 1;
  return draft ? toDraftVersion(next) : next;
}

/** Ingest fila som en ny versjon av en låt som allerede finnes (samme slug, variant og tittel). */
export async function ingestAsVersionOf(
  release: ReleaseSource,
  master: ReleaseSource['masters'][number],
  to: { slug: string; variant: string | null; title: string },
  status: AssetStatus,
  o: { mediaDir: string; cfg: VaultConfig; report?: Parameters<typeof ingestRelease>[1]['report'] }
): Promise<IngestResult[]> {
  const idx = await readIndex(o.mediaDir);
  master.slug = to.slug;
  master.variant = to.variant;
  master.version = nextVersionIn(idx, to.slug, to.variant, status);
  master.titleFromFile = to.title;
  release.slug = to.slug;
  release.masters = [master];
  return ingestRelease(release, { mediaDir: o.mediaDir, config: o.cfg, status, report: o.report });
}
