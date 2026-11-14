import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetManifest, CatalogIndex } from '@gv/shared';
import { findRoot } from './config';
import { AUDIO_RE } from './sources';

/**
 * Privat oversikt over hvilken kildefil hver versjon kom fra (del 11, «Kildefil» i Info og Studio).
 * Ligger i data/sources.json (gitignored). Originalnavnet kan inneholde «suno» o.l. og skal derfor
 * ALDRI inn i manifest, tags, delte filer eller noe som når /drop/... – bare Info og Studio leser det.
 * relPath (relativt til eksportmappa) brukes senere til å fylle inn Vaults egen master-kopi (del 10).
 */
export interface SourceRecord {
  /** Filnavnet slik det lå i eksportmappa, f.eks. «Eyes on you.wav». */
  fileName: string;
  /** Sti relativt til eksportmappa, eller null hvis fila lå et annet sted. */
  relPath: string | null;
  sha256: string;
  recordedAt: string;
}

export interface SourcesFile {
  schema: 1;
  entries: Record<string, SourceRecord>;
}

export const sourceKey = (slug: string, variant: string | null, version: number) => `${slug}::${variant ?? 'main'}::v${version}`;

export function sourcesFile(mediaDir: string, dataDir?: string): string {
  return path.join(dataDir ?? path.join(findRoot(mediaDir), 'data'), 'sources.json');
}

export async function readSources(file: string): Promise<SourcesFile> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as SourcesFile;
    if (j && typeof j.entries === 'object') return j;
  } catch {
    /* finnes ikke ennå */
  }
  return { schema: 1, entries: {} };
}

let chain: Promise<unknown> = Promise.resolve();
/** Legger til/oppdaterer oppføringer (én skriver om gangen, atomisk). */
export function recordSources(file: string, records: Record<string, SourceRecord>): Promise<void> {
  const run = async () => {
    const data = await readSources(file);
    Object.assign(data.entries, records);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export function relativeToExport(file: string, exportDir: string | undefined): string | null {
  if (!exportDir) return null;
  const rel = path.relative(path.resolve(exportDir), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Lydfiler i eksportmappa: rett i mappa og ett nivå ned (release-mapper). Bare lesing. */
async function listAudio(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && AUDIO_RE.test(e.name)) out.push(p);
    else if (e.isDirectory() && !e.name.startsWith('.')) {
      for (const f of await readdir(p, { withFileTypes: true }).catch(() => [])) if (f.isFile() && AUDIO_RE.test(f.name)) out.push(path.join(p, f.name));
    }
  }
  return out;
}

export interface IndexSourcesResult {
  scanned: number;
  matched: Array<{ key: string; fileName: string }>;
  missing: string[];
  /** Filer som ikke kunne leses (f.eks. låst mens Reason skriver). */
  skipped: Array<{ fileName: string; reason: string }>;
}

/**
 * Engangskjøring for låter som allerede er ingestet: hasher lydfilene i eksportmappa (kun lesing)
 * og kobler dem til versjonene i media/ via masterSha256. Rører ingenting i eksportmappa.
 */
export async function indexSources(opts: { exportDir: string; mediaDir: string; dataDir?: string; force?: boolean; onFile?: (name: string) => void }): Promise<IndexSourcesResult> {
  const file = sourcesFile(opts.mediaDir, opts.dataDir);
  const known = await readSources(file);
  const idxPath = path.join(opts.mediaDir, 'index.json');
  const idx = existsSync(idxPath) ? (JSON.parse(await readFile(idxPath, 'utf8')) as CatalogIndex) : { assets: [] };
  const bySha = new Map<string, string[]>();
  for (const a of idx.assets) {
    const key = sourceKey(a.slug, a.variant ?? null, a.version);
    if (!opts.force && known.entries[key]) continue;
    const m = JSON.parse(await readFile(path.join(opts.mediaDir, a.manifest), 'utf8')) as AssetManifest;
    if (m.masterSha256) bySha.set(m.masterSha256, [...(bySha.get(m.masterSha256) ?? []), key]);
  }
  const wanted = [...bySha.values()].flat();
  const files = wanted.length ? await listAudio(opts.exportDir) : [];
  const found: Record<string, SourceRecord> = {};
  const matched: IndexSourcesResult['matched'] = [];
  const skipped: IndexSourcesResult['skipped'] = [];
  for (const f of files) {
    opts.onFile?.(path.basename(f));
    let sha: string;
    try {
      sha = await sha256(f);
    } catch (err) {
      // F.eks. EBUSY mens Reason fortsatt skriver en bounce. Hopp over og fortsett; kjør igjen senere.
      skipped.push({ fileName: path.basename(f), reason: (err as NodeJS.ErrnoException).code ?? String(err) });
      continue;
    }
    for (const key of bySha.get(sha) ?? []) {
      found[key] = { fileName: path.basename(f), relPath: relativeToExport(f, opts.exportDir), sha256: sha, recordedAt: new Date().toISOString() };
      matched.push({ key, fileName: path.basename(f) });
    }
  }
  if (matched.length) await recordSources(file, found);
  return { scanned: files.length - skipped.length, matched, missing: wanted.filter((k) => !found[k]), skipped };
}
