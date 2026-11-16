import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { preferredVersion, type AssetManifest, type CatalogIndex } from '@gv/shared';
import { SIMILARITY_THRESHOLD, SAME_DURATION_MS, similarity } from './fingerprint';
import { createFingerprintStore } from './incoming';
import { readSources, sourcesFile } from './source-index';

/**
 * Duplikater i katalogen: samme låt importert flere ganger under ulike titler (LANDR-master, ny eksport,
 * spornummer, kopimerker). To låter regnes som samme låt når
 *  - titlene er like etter rensing (titleKey), eller
 *  - lyden er lik: kromagram-likhet ≥ SIMILARITY_THRESHOLD og varighet innenfor ±2 s.
 * Gruppene (sammenhengende komponenter) lagres i data/dupe-groups.json og brukes av settbyggeren, som aldri
 * velger to låter fra samme gruppe, også før de er slått sammen.
 */

/** Mappe-/spillelisteprefiks som har havnet i filnavnet («1Echo Groove låter__Love me.wav»). */
// Også andre mapper som er sortert øverst med «1» foran («1FerdigMix__Input.wav»)
export const FOLDER_PREFIX_RE = /^\s*(?:\d*\s*echo\s*groove\s*l[åa]ter(?:\s*__\s*|\s+|$)|1[a-zæøå][^_\s]*__|1ferdigmix\s+)/i;
/** Artistnavnet foran tittelen («Echo Groove - Unique»). */
const ARTIST_PREFIX_RE = /^\s*echo\s*groove\s*[-–—]\s*/i;
/** LANDR: «LANDR-<navn>-Balanced-Medium» (stil Warm/Balanced/Open, styrke Low/Medium/High). */
const LANDR_PREFIX_RE = /^\s*landr[\s_-]+/i;
const LANDR_SUFFIX_RE = /[\s_-]+(?:warm|balanced|open)[\s_-]+(?:low|medium|high)\s*$/i;
/** Spornummer først: «01.», «02 —», «1.», «5. », «3.Better Now», «07 - …», «07_…». */
const TRACK_NO_RE = /^\s*\d{1,3}\s*(?:[.)]|\s[—–-]|[—–]|_)\s*(?=\D)/;
/** Kopimerker til slutt: « 1», « 2», « 1.6», « C», « Cool», «1.6» limt på ordet, «(1)», « kopi». */
// Ikke «Pt 1», «Part 2», «Vol 3», «No 5»: der er tallet en del av tittelen
const COPY_MARK_RE = /(?:(?<!\b(?:pt|part|vol|nr|no)\.?)\s+(?:\d{1,2}(?:\.\d{1,2})?|copy|kopi|final|v\d+)|(?<=[a-zæøå])\d{1,2}\.\d{1,2}|\s*\((?:\d{1,2}|copy|kopi)\)\s*(?:c|cool)?)\s*$/i;
/** «02. PAY ATTENTION (1)COOL.wav» ble til tittelen «Pay Attention Cool»: «C»/«Cool» er bare kopimerke etter «(n)». */
export const COPY_SUFFIX_FILE_RE = /\(\d{1,2}\)\s*(c|cool)\.[a-z0-9]+$/i;

export function isLandr(name: string): boolean {
  return LANDR_PREFIX_RE.test(name) || LANDR_SUFFIX_RE.test(name.replace(/\.[a-z0-9]+$/i, ''));
}

/** Foreslått visningstittel (beholder store bokstaver og parenteser som «(Extended)»). */
export function cleanDisplayTitle(t: string): string {
  // Apostrofer beholdes som de er (Knut: ikke gjett apostrofer)
  let s = t.replace(/\.[a-z0-9]{2,4}$/i, '');
  s = s.replace(FOLDER_PREFIX_RE, '').replace(ARTIST_PREFIX_RE, '');
  s = s.replace(LANDR_PREFIX_RE, '').replace(LANDR_SUFFIX_RE, '');
  s = s.replace(TRACK_NO_RE, '');
  for (let i = 0; i < 3; i++) {
    const n = s.replace(COPY_MARK_RE, '');
    if (n === s || !n.trim()) break;
    s = n;
  }
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // Helt små bokstaver (fra filnavnet): stor forbokstav
  if (s && s === s.toLowerCase()) s = s[0]!.toUpperCase() + s.slice(1);
  return s || t.trim();
}

/** Nøkkel for tittellikhet: renset tittel uten parenteser (versjonsnavn), små bokstaver, bare bokstaver/tall. */
export function titleKey(t: string): string {
  return cleanDisplayTitle(t)
    .replace(/[’`´]/g, "'")
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Versjonsord i parentes er samme låt; «(Mashup)» og «(Remix)» er en annen låt og blir stående
    .replace(/[([](?![^)\]]*\b(?:mashup|remix|cover)\b)[^)\]]*[)\]]/g, ' ')
    .replace(/\b(?:extended|extend|original|radio edit|edit|short|eshort|kort|denne|ny|new|main|mix|version|master(?:ed)?)\b/g, ' ')
    .replace(/[^a-z0-9æøå]+/g, ' ')
    .trim();
}

export interface DupeMember {
  slug: string;
  variant: string | null;
  version: number;
  title: string;
  /** Kildefilnavnet (data/sources.json), hvis kjent. */
  fileName: string | null;
  suggestedTitle: string;
  status: 'release' | 'draft';
  durationMs: number;
  landr: boolean;
}
export interface DupeLink {
  a: number;
  b: number;
  reason: 'tittel' | 'lyd';
  similarity: number | null;
}
export interface DupeGroup {
  id: string;
  members: DupeMember[];
  links: DupeLink[];
}
export interface DupeReport {
  updatedAt: string;
  groups: DupeGroup[];
  /** slug::variant → gruppe-id (bare låter som er i en gruppe). */
  byKey: Record<string, string>;
  /** Alle låter med foreslått ny tittel (også de som ikke er duplikater). */
  retitles: Array<Pick<DupeMember, 'slug' | 'variant' | 'title' | 'fileName' | 'suggestedTitle'>>;
}

export const memberKey = (slug: string, variant: string | null) => `${slug}::${variant ?? ''}`;

export async function findDuplicateGroups(o: { mediaDir: string; dataDir: string; onProgress?: (done: number, total: number) => void }): Promise<DupeReport> {
  const media = path.resolve(o.mediaDir);
  const idx = JSON.parse(await readFile(path.join(media, 'index.json'), 'utf8')) as CatalogIndex;
  const sources = (await readSources(sourcesFile(o.mediaDir, o.dataDir))).entries as Record<string, { fileName?: string }>;
  const groups = new Map<string, CatalogIndex['assets']>();
  for (const a of idx.assets) groups.set(memberKey(a.slug, a.variant), [...(groups.get(memberKey(a.slug, a.variant)) ?? []), a]);

  const members: Array<DupeMember & { dir: string; baseTitle: string }> = [];
  for (const list of groups.values()) {
    const e = preferredVersion(list)!;
    const mp = path.join(media, e.manifest);
    if (!existsSync(mp)) continue;
    const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
    if (m.kind === 'set' || m.hidden) continue; // skjulte (testlåta) er ikke med i katalogen
    const fileName = sources[`${m.slug}::${m.variant ?? 'main'}::v${m.version}`]?.fileName ?? null;
    // Tittelen hentes fra filnavnet når den bare er et mappenavn («1Echo Groove låter__Love me.wav»)
    let fromFile = fileName && FOLDER_PREFIX_RE.test(fileName) ? cleanDisplayTitle(fileName) : cleanDisplayTitle(m.title);
    const mark = fileName ? COPY_SUFFIX_FILE_RE.exec(fileName) : null;
    if (mark) fromFile = fromFile.replace(new RegExp(`\\s+${mark[1]}$`, 'i'), '');
    members.push({
      slug: m.slug,
      variant: m.variant,
      version: m.version,
      title: m.title + (m.variantLabel ? ` (${m.variantLabel})` : ''),
      baseTitle: m.title,
      fileName,
      suggestedTitle: fromFile,
      status: m.status === 'release' || (m.version < 1000 && m.status !== 'draft') ? 'release' : 'draft',
      durationMs: m.durationMs,
      landr: isLandr(fileName ?? m.title),
      dir: path.dirname(mp)
    });
  }

  // Union-find over tittel- og lydlikhet
  const parent = members.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const links: DupeLink[] = [];
  const keys = members.map((m) => titleKey(m.suggestedTitle));
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++)
      if (keys[i] && keys[i] === keys[j]) {
        links.push({ a: i, b: j, reason: 'tittel', similarity: null });
        parent[find(i)] = find(j);
      }

  const fps = createFingerprintStore(o.dataDir);
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) if (Math.abs(members[i]!.durationMs - members[j]!.durationMs) <= SAME_DURATION_MS) pairs.push([i, j]);
  const need = [...new Set(pairs.flat())];
  const fp = new Map<number, Awaited<ReturnType<typeof fps.forEntry>>>();
  let done = 0;
  for (const i of need) {
    const m = members[i]!;
    fp.set(i, await fps.forEntry({ slug: m.slug, variant: m.variant, title: m.title, norm: '', durationMs: m.durationMs, dir: m.dir }).catch(() => null));
    if (++done % 10 === 0) await fps.save();
    o.onProgress?.(done, need.length);
  }
  await fps.save();
  for (const [i, j] of pairs) {
    const a = fp.get(i);
    const b = fp.get(j);
    if (!a || !b) continue;
    const s = similarity(a, b, members[i]!.durationMs, members[j]!.durationMs);
    if (s >= SIMILARITY_THRESHOLD) {
      links.push({ a: i, b: j, reason: 'lyd', similarity: Math.round(s * 1000) / 1000 });
      parent[find(i)] = find(j);
    }
  }

  const comp = new Map<number, number[]>();
  members.forEach((_, i) => comp.set(find(i), [...(comp.get(find(i)) ?? []), i]));
  const out: DupeGroup[] = [];
  const byKey: Record<string, string> = {};
  for (const ids of comp.values()) {
    if (ids.length < 2) continue;
    const local = new Map(ids.map((g, k) => [g, k] as const));
    const first = members[ids[0]!]!;
    const id = `g-${first.slug}${first.variant ? `--${first.variant}` : ''}`;
    out.push({
      id,
      members: ids.map((i) => {
        const { dir: _dir, baseTitle: _b, ...m } = members[i]!;
        return m;
      }),
      links: links.filter((l) => local.has(l.a) && local.has(l.b)).map((l) => ({ ...l, a: local.get(l.a)!, b: local.get(l.b)! }))
    });
    for (const i of ids) byKey[memberKey(members[i]!.slug, members[i]!.variant)] = id;
  }
  out.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
  const retitles = members.filter((m) => m.suggestedTitle !== m.baseTitle.trim()).map(({ slug, variant, title, fileName, suggestedTitle }) => ({ slug, variant, title, fileName, suggestedTitle }));
  return { updatedAt: new Date().toISOString(), groups: out, byKey, retitles };
}

export async function writeDupeReport(dataDir: string, r: DupeReport): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const f = path.join(dataDir, 'dupe-groups.json');
  await writeFile(`${f}.tmp`, JSON.stringify(r, null, 1));
  await rename(`${f}.tmp`, f);
}

export async function readDupeReport(dataDir: string): Promise<DupeReport | null> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, 'dupe-groups.json'), 'utf8')) as DupeReport;
  } catch {
    return null;
  }
}
