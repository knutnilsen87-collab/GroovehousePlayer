import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manualPalette, type AssetManifest, type CatalogIndex } from '@gv/shared';
import type { VaultConfig } from './config';
import { processCover } from './cover';
import { updateCatalog } from './ingest';
import { readOverrides } from './sources';
import { coverInputOf, readAnalysis, vaultCoverLogo, writeVaultCover } from './vault-cover';

/**
 * Del 23 nivå 1, etterfylling: lager Vault-cover for alle versjoner i media/ som mangler cover.
 * Ekte cover røres aldri. Manuell farge fra Studio beholdes; ellers hentes paletten fra Vault-coveret.
 * `force` = lag Vault-coverene på nytt også der de finnes (f.eks. etter at tegningen er endret).
 */
export async function fillVaultCovers(opts: {
  mediaDir: string;
  root: string;
  cfg: VaultConfig;
  force?: boolean;
  only?: string[];
  onItem?: (done: number, total: number, m: AssetManifest, ms: number, err?: unknown) => void;
}): Promise<{ made: number; failed: number; skipped: number }> {
  const media = path.resolve(opts.mediaDir);
  const idx = JSON.parse(await readFile(path.join(media, 'index.json'), 'utf8')) as CatalogIndex;
  const logo = vaultCoverLogo(opts.root);
  const todo: Array<{ dir: string; mp: string; m: AssetManifest }> = [];
  let skipped = 0;
  for (const a of idx.assets) {
    if (opts.only && !opts.only.includes(a.slug)) continue;
    const mp = path.join(media, a.manifest);
    if (!existsSync(mp)) continue;
    const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
    const generated = m.coverSource === 'generated';
    if (m.files.cover && !(generated && opts.force)) {
      skipped++;
      continue;
    }
    todo.push({ dir: path.dirname(mp), mp, m });
  }
  let made = 0;
  let failed = 0;
  let done = 0;
  for (const t of todo) {
    const t0 = Date.now();
    try {
      const png = await writeVaultCover(t.dir, coverInputOf(t.m, await readAnalysis(t.dir, t.m.files.analysis)), logo);
      const c = await processCover(png, t.dir, opts.cfg.colors);
      const overrides = await readOverrides(media, t.m.slug);
      let palette = c.palette;
      if (overrides.palette) {
        const mp = manualPalette(overrides.palette.primary, overrides.palette.secondary, 0);
        if (mp.ok) palette = mp.palette;
      } else if (t.m.palette.source === 'manual') palette = t.m.palette;
      // Les manifestet på nytt rett før skriving (Studio kan ha endret det imens)
      const fresh = JSON.parse(await readFile(t.mp, 'utf8')) as AssetManifest;
      if (fresh.files.cover && fresh.coverSource !== 'generated') {
        skipped++;
        continue;
      }
      const updated: AssetManifest = { ...fresh, coverSource: 'generated', palette, files: { ...fresh.files, cover: c.cover, coverThumb: c.coverThumb } };
      await writeFile(t.mp, JSON.stringify(updated, null, 2));
      await rm(path.join(t.dir, 'share'), { recursive: true, force: true }).catch(() => {});
      await updateCatalog(media, updated);
      made++;
      opts.onItem?.(++done, todo.length, updated, Date.now() - t0);
    } catch (err) {
      failed++;
      opts.onItem?.(++done, todo.length, t.m, Date.now() - t0, err);
    }
  }
  return { made, failed, skipped };
}
