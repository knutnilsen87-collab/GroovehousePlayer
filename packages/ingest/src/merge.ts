import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DRAFT_BASE, slugify, type AssetManifest, type CatalogIndex } from '@gv/shared';
import { cleanDisplayTitle, COPY_SUFFIX_FILE_RE, findDuplicateGroups, isLandr, memberKey, type DupeReport } from './dupes';
import { similarity } from './fingerprint';
import { createFingerprintStore } from './incoming';
import { readSources, sourcesFile } from './source-index';

/**
 * Sammenslåing av duplikater og nye titler (Knuts regler 2026-11-17):
 *  - Samme lyd (likhet ≥ 0,94) → versjoner av samme variant. LANDR-fila blir versjonen «LANDR-master»
 *    (release-klar, den som vises og spilles).
 *  - Annen lengde eller ulik lyd → variant. Navn fra parentesen (Extend → Extended, Original, New;
 *    MAIN = hovedvarianten), ellers «Kort» (under ca. 60–65 % av lengden), ellers «Alt 2», «Alt 3».
 *  - «1Echo Groove låter» og «1FerdigMix» deles opp: tittelen står etter «__» i filnavnet.
 *  - Arbeidstitler beholdes og merkes titleNeedsReview. Testlåta fra fixtures skjules.
 *  - Spillelister, favoritter, avspillingslogg, posisjon, delinger og tekster følger med.
 *
 * Alt flyttes (rename på samme disk), aldri kopieres eller slettes. Før noe flyttes, tas backup av data/*.json,
 * media/index.json og alle manifester som endres, i data/merges/<tid>/. `undoMerge` legger alt tilbake.
 * Kildemappene (REASONDONE, umastrede) røres ikke.
 */

export const SAME_SOUND = 0.94;
export const SHORT_RATIO = 0.65;

/** Arbeidstitler Knut navngir selv: beholdes og merkes for sjekk. Ingen gjetting av apostrofer. */
export const WORK_TITLES = ['Nottome1.1medvokal2', 'Newdolla', 'X103', 'GIUny', 'IslandGirlMIX', 'EpicPiano', 'Taylor swift2', 'Cant Let Go', 'Input', 'Easy', 'Retro'];
const SHARE_BLOCKED: Record<string, string> = { 'Taylor swift2': 'arbeidstittel med artistnavn – gi låta nytt navn før deling og utgivelse' };

/** Kilde-nøkkel (slug::variant) → fast tittel / variant (Knuts rettelser). */
const TITLE_OVERRIDES: Record<string, { title?: string; variant?: { slug: string; label: string } }> = {
  '1echo-groove-later::fxdeep-extended': { title: 'FX Deep', variant: { slug: 'extended', label: 'Extended' } },
  '1echo-groove-later::landr-every-day-ferdig-eshort-balanced-medium': { title: 'Every Day', variant: { slug: 'kort', label: 'Kort' } },
  '1echo-groove-later::deep-toolsny': { title: 'Deep Tools' },
  '1echo-groove-later::deep-tools1-6': { title: 'Deep Tools' },
  '6-no-lights-just-heat::': { variant: { slug: 'extended', label: 'Extended' } }
};
/** Skal være nyeste versjon («deep toolsNy» er en ny versjon av «Deep Tools»). */
const NEWER = new Set(['1echo-groove-later::deep-toolsny']);
/** Grupper der tittelen er bestemt av Knut (nøkkel = en av kildene). */
const GROUP_TITLES: Array<{ anyOf: string[]; title: string }> = [
  { anyOf: ['like-the-sun::', 'love-you-like-the-sun::'], title: 'Like The Sun' },
  { anyOf: ['9-blue-fire::', '9-silk-voltage::'], title: 'Blue Fire' }
];
/** Kilder som ikke skal få ny tittel (uklart hva tittelen er – Knut avgjør). */
const KEEP_TITLE = /^(echo groove musikk|fineste)/i;
/** Variantord i parentes → variant. MAIN = hovedvarianten. */
const PAREN_VARIANT: Array<[RegExp, { slug: string; label: string } | 'main' | 'ignore']> = [
  [/^extend(?:ed)?(?: mix)?$/i, { slug: 'extended', label: 'Extended' }],
  [/^original$/i, { slug: 'original', label: 'Original' }],
  [/^(?:new|ny)$/i, { slug: 'new', label: 'New' }],
  [/^(?:e?short|kort)$/i, { slug: 'kort', label: 'Kort' }],
  [/^main$/i, 'main'],
  [/^denne$/i, 'ignore']
];

interface Unit {
  key: string;
  slug: string;
  variant: string | null;
  versions: Array<{ version: number; manifest: AssetManifest; rel: string; fileName: string | null; landr: boolean }>;
  /** Foretrukket versjon (den som vises). */
  main: AssetManifest;
  dir: string;
  fileName: string | null;
  cleanTitle: string;
  paren: string | null;
}

export interface MergeOp {
  from: { slug: string; variant: string | null; version: number };
  to: { slug: string; variant: string | null; version: number };
  title: string;
  variantLabel: string | null;
  versionLabel: string | null;
  status: 'release' | 'draft';
  titleNeedsReview?: boolean;
  shareBlocked?: string;
  hidden?: boolean;
  /** Bare for visning i planen. */
  fromTitle: string;
  song: string;
}

export interface MergePlan {
  createdAt: string;
  ops: MergeOp[];
  counts: { before: Counts; after: Counts };
}
interface Counts {
  songs: number;
  tracks: number;
  versions: number;
  visible: number;
}

/** Vanlig tittelformat: «GOT SOMETHING TO SAY» → «Got Something To Say», «Love me» → «Love Me». */
export function titleCase(t: string): string {
  return t
    .split(/(\s+)/)
    .map((w) => {
      if (!/[a-zæøå]/i.test(w)) return w;
      const letters = w.replace(/[^a-zæøåA-ZÆØÅ]/g, '');
      if (letters.length > 1 && letters === letters.toUpperCase()) w = w.toLowerCase();
      return w.replace(/^([("'«]?)([a-zæøå])/, (_m, p: string, c: string) => p + c.toUpperCase());
    })
    .join('');
}

const parenOf = (raw: string): string | null => {
  const m = /\(([^)]+)\)\s*$/.exec(raw.replace(/\.[a-z0-9]{2,4}$/i, ''));
  return m ? m[1]!.trim() : null;
};

/** Sangtittel: renset, mashup uten gjentakelse. Ved sammenslåing også uten variantord i parentes («(MAIN)», «(Extend)»). */
export function songTitle(clean: string, stripVariantParen = true): string {
  let t = clean.replace(/^(.+?)\s+X\s+\d{1,3}\.\s*\1\s*\((mashup)\)$/i, '$1 (Mashup)');
  const p = parenOf(t);
  if (stripVariantParen && p && PAREN_VARIANT.some(([re]) => re.test(p))) t = t.replace(/\s*\([^)]+\)\s*$/, '');
  return WORK_TITLES.includes(t) ? t : titleCase(t);
}

async function loadUnits(mediaDir: string, dataDir: string): Promise<Map<string, Unit>> {
  const media = path.resolve(mediaDir);
  const idx = JSON.parse(await readFile(path.join(media, 'index.json'), 'utf8')) as CatalogIndex;
  const sources = (await readSources(sourcesFile(mediaDir, dataDir))).entries as Record<string, { fileName?: string }>;
  const units = new Map<string, Unit>();
  for (const e of idx.assets) {
    const mp = path.join(media, e.manifest);
    if (!existsSync(mp)) continue;
    const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
    const key = memberKey(m.slug, m.variant);
    const fileName = sources[`${m.slug}::${m.variant ?? 'main'}::v${m.version}`]?.fileName ?? null;
    const v = { version: m.version, manifest: m, rel: e.manifest, fileName, landr: isLandr(fileName ?? m.title) || (m.variant ?? '').startsWith('landr-') };
    const u = units.get(key);
    if (u) u.versions.push(v);
    else units.set(key, { key, slug: m.slug, variant: m.variant, versions: [v], main: m, dir: path.dirname(mp), fileName, cleanTitle: '', paren: null });
  }
  for (const u of units.values()) {
    u.versions.sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt) || a.version - b.version);
    const rel = u.versions.filter((v) => v.manifest.status !== 'draft' && v.version < DRAFT_BASE);
    const pick = rel.length ? rel[rel.length - 1]! : u.versions[u.versions.length - 1]!;
    u.main = pick.manifest;
    u.dir = path.join(media, path.dirname(pick.rel));
    u.fileName = pick.fileName;
    // Tittel: fra filnavnet når tittelen er et mappenavn (1Echo Groove låter__X, 1FerdigMix__X)
    const raw = u.fileName && /__/.test(u.fileName) && /^\s*1/.test(u.fileName) ? u.fileName : u.main.title + (u.main.variantLabel && u.slug.startsWith('1') ? ` ${u.main.variantLabel}` : '');
    u.cleanTitle = cleanDisplayTitle(raw);
    // «(1)COOL.wav» → tittelen fikk «Cool» på slutten; det er et kopimerke
    const mark = u.fileName ? COPY_SUFFIX_FILE_RE.exec(u.fileName) : null;
    if (mark) u.cleanTitle = u.cleanTitle.replace(new RegExp(`\\s+${mark[1]}$`, 'i'), '');
    u.paren = parenOf(u.fileName ?? u.main.title) ?? parenOf(u.main.title);
  }
  return units;
}

const countsOf = (ms: AssetManifest[]): Counts => ({
  songs: new Set(ms.map((m) => m.slug)).size,
  tracks: new Set(ms.map((m) => memberKey(m.slug, m.variant))).size,
  versions: ms.length,
  visible: new Set(ms.filter((m) => !m.hidden).map((m) => memberKey(m.slug, m.variant))).size
});

export async function planMerge(o: { mediaDir: string; dataDir: string; dupes?: DupeReport }): Promise<MergePlan> {
  const units = await loadUnits(o.mediaDir, o.dataDir);
  const dupes = o.dupes ?? (await findDuplicateGroups({ mediaDir: o.mediaDir, dataDir: o.dataDir }));
  const fixtures = new Set(['blue-fire']); // kildefilene er fixtures/blue-fire (samme sha256), sjekket 2026-11-17

  // ---- Sanger: union-find over enheter
  const parent = new Map<string, string>([...units.keys()].map((k) => [k, k]));
  const find = (k: string): string => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k)!)), parent.get(k)!));
  const union = (a: string, b: string) => units.has(a) && units.has(b) && parent.set(find(a), find(b));
  const bySlug = new Map<string, string[]>();
  for (const u of units.values()) bySlug.set(u.slug, [...(bySlug.get(u.slug) ?? []), u.key]);
  // Slugs der «låta» egentlig er et mappenavn («1Echo Groove låter__X», «1FerdigMix__X») deles opp per variant
  const folderSlug = (keys: string[]) => keys.some((k) => /^\s*1[^_]*__/.test(units.get(k)!.fileName ?? ''));
  for (const [, keys] of bySlug) if (!folderSlug(keys)) for (const k of keys.slice(1)) union(keys[0]!, k);
  union('1echo-groove-later::deep-tools1-6', '1echo-groove-later::deep-toolsny');
  for (const g of dupes.groups) {
    const keys = g.members.map((m) => memberKey(m.slug, m.variant)).filter((k) => units.has(k) && !fixtures.has(units.get(k)!.slug));
    // «1FerdigMix (Input)» og «Lost» havnet sammen bare fordi titlen var mappenavnet
    if (keys.every((k) => units.get(k)!.slug.startsWith('1ferdigmix'))) continue;
    for (const k of keys.slice(1)) union(keys[0]!, k);
  }
  const songs = new Map<string, Unit[]>();
  for (const u of units.values()) songs.set(find(u.key), [...(songs.get(find(u.key)) ?? []), u]);

  // ---- Lydlikhet mellom enheter i samme sang
  const fps = createFingerprintStore(o.dataDir);
  const fpOf = async (u: Unit) => fps.forEntry({ slug: u.slug, variant: u.variant, title: '', norm: '', durationMs: u.main.durationMs, dir: u.dir }).catch(() => null);
  const sameSound = async (a: Unit, b: Unit) => {
    const fa = await fpOf(a);
    const fb = await fpOf(b);
    return !!fa && !!fb && similarity(fa, fb, a.main.durationMs, b.main.durationMs) >= SAME_SOUND;
  };

  const ops: MergeOp[] = [];
  const usedSlugs = new Set<string>();
  // Slugs som blir ledige (testlåta flyttes til test-blue-fire) kan brukes av den ekte låta
  const reserved = new Set([...units.values()].map((u) => u.slug).filter((s) => !fixtures.has(s)));
  const songList = [...songs.values()].sort((a, b) => b.length - a.length);
  for (const members of songList) {
    const merged = members.length > 1 && new Set(members.map((m) => m.slug)).size > 1;
    const split = members.some((m) => m.slug === '1echo-groove-later' || m.slug.startsWith('1echo-groove-later-') || m.slug.startsWith('1ferdigmix'));
    const fixture = members.every((m) => fixtures.has(m.slug));

    // Klynger av samme lyd
    const clusters: Unit[][] = [];
    if (merged) {
      for (const u of members) {
        const ov = TITLE_OVERRIDES[u.key];
        let home: Unit[] | undefined;
        for (const c of clusters) if (!ov?.variant && !TITLE_OVERRIDES[c[0]!.key]?.variant && (await sameSound(u, c[0]!))) home = c;
        if (home) home.push(u);
        else clusters.push([u]);
      }
    } else if (members.length > 1 && members[0]!.slug === '1echo-groove-later') {
      clusters.push(members); // Deep Tools: «Ny» er en ny versjon (Knut)
    } else for (const u of members) clusters.push([u]);

    // Hovedklynge: MAIN > LANDR > flest > ren tittel uten kopimerke
    const score = (c: Unit[]) =>
      (c.some((u) => /^main$/i.test(u.paren ?? '')) ? 1000 : 0) +
      (c.some((u) => u.versions.some((v) => v.landr)) ? 100 : 0) +
      c.length * 10 +
      (c.some((u) => u.cleanTitle === u.main.title.trim() && !u.paren) ? 1 : 0) -
      (c.some((u) => TITLE_OVERRIDES[u.key]?.variant) ? 10_000 : 0);
    // Klart kortere (under SHORT_RATIO av den lengste) er aldri hovedvarianten («Old Soul Money» 94 s → Kort)
    const longest = Math.max(...clusters.map((c) => c[0]!.main.durationMs));
    const scoreL = (c: Unit[]) => score(c) - (c[0]!.main.durationMs < longest * SHORT_RATIO ? 50 : 0);
    const mainC = merged ? [...clusters].sort((a, b) => scoreL(b) - scoreL(a))[0]! : null;

    // Tittel og slug
    const groupT = GROUP_TITLES.find((g) => g.anyOf.some((k) => members.some((m) => m.key === k)));
    const lead = mainC?.[0] ?? members.find((m) => m.variant === null) ?? members[0]!;
    // Live-sett og uklare mappetitler beholder tittelen
    const keepTitle = KEEP_TITLE.test(lead.main.title) || lead.main.kind === 'set';
    const title = fixture ? 'Blue Fire (test)' : groupT?.title ?? TITLE_OVERRIDES[lead.key]?.title ?? (keepTitle ? lead.main.title : songTitle(lead.cleanTitle, merged));
    let slug = fixture ? 'test-blue-fire' : merged || split ? slugify(title) : lead.slug;
    if (merged || split) {
      // Bruk en eksisterende slug fra gruppa hvis den er lik; ellers unngå kollisjon med andre sanger
      let n = 2;
      const base = slug;
      while (usedSlugs.has(slug) || (reserved.has(slug) && !members.some((m) => m.slug === slug))) slug = `${base}-${n++}`;
    }
    usedSlugs.add(slug);
    const review = WORK_TITLES.includes(title);

    // Varianter
    const variantFor = new Map<Unit[], { slug: string | null; label: string | null }>();
    const usedLabels = new Set<string>();
    let alt = 2;
    for (const c of clusters) {
      if (!merged && !split && !fixture) {
        variantFor.set(c, { slug: c[0]!.variant, label: c[0]!.main.variantLabel });
        continue;
      }
      const ov = c.map((u) => TITLE_OVERRIDES[u.key]?.variant).find(Boolean);
      if (ov) {
        variantFor.set(c, ov);
        continue;
      }
      if (c === mainC || (!merged && (split || fixture))) {
        // Oppdelte enheter (1Echo …) blir hovedvarianten i sin egen sang; fixtures beholder variantene sine
        variantFor.set(c, fixture ? { slug: c[0]!.variant, label: c[0]!.main.variantLabel } : { slug: null, label: null });
        continue;
      }
      let v: { slug: string; label: string } | null = null;
      for (const u of c) {
        const hit = u.paren ? PAREN_VARIANT.find(([re]) => re.test(u.paren!)) : undefined;
        if (hit && typeof hit[1] === 'object') v = hit[1];
      }
      const mainMs = mainC![0]!.main.durationMs;
      if (!v && c[0]!.main.durationMs < mainMs * SHORT_RATIO) v = { slug: 'kort', label: 'Kort' };
      if (!v) v = { slug: `alt-${alt}`, label: `Alt ${alt++}` };
      while (usedLabels.has(v.slug)) v = { slug: `${v.slug}-2`, label: `${v.label} 2` };
      usedLabels.add(v.slug);
      variantFor.set(c, v);
    }

    // Versjoner: utkast 1001, 1002 … i importrekkefølge; LANDR-mastere release 1, 2 … (vises og spilles)
    for (const c of clusters) {
      const vf = variantFor.get(c)!;
      const newer = (u: Unit) => (NEWER.has(u.key) ? 1 : 0);
      const all = c.flatMap((u) => u.versions.map((v) => ({ u, v }))).sort((a, b) => Number(a.v.landr) - Number(b.v.landr) || newer(a.u) - newer(b.u) || a.v.manifest.createdAt.localeCompare(b.v.manifest.createdAt));
      const untouched = !merged && !split && c.length === 1 && !all.some((x) => x.v.landr && x.v.manifest.status === 'draft');
      let rel = 0;
      let dr = 0;
      for (const { u, v } of all) {
        const isRel = v.landr || (v.manifest.status !== 'draft' && v.version < DRAFT_BASE);
        const version = untouched ? v.version : isRel ? ++rel : DRAFT_BASE + ++dr;
        const versionLabel = untouched ? (v.manifest.versionLabel ?? null) : v.landr ? 'LANDR-master' : isRel ? `v${version}` : `Umastret v${version - DRAFT_BASE}`;
        ops.push({
          from: { slug: u.slug, variant: u.variant, version: v.version },
          to: { slug, variant: vf.slug, version },
          title,
          variantLabel: vf.label,
          versionLabel,
          status: isRel ? 'release' : 'draft',
          ...(review ? { titleNeedsReview: true } : {}),
          ...(SHARE_BLOCKED[title] ? { shareBlocked: SHARE_BLOCKED[title] } : {}),
          ...(fixture ? { hidden: true } : {}),
          fromTitle: `${v.manifest.title}${v.manifest.variantLabel ? ` (${v.manifest.variantLabel})` : ''} · ${v.manifest.versionLabel ?? `v${v.version}`}`,
          song: title
        });
      }
    }
  }
  const before = [...units.values()].flatMap((u) => u.versions.map((v) => v.manifest));
  const after = ops.map((op) => ({ ...before.find((m) => m.slug === op.from.slug && m.variant === op.from.variant && m.version === op.from.version)!, slug: op.to.slug, variant: op.to.variant, version: op.to.version, hidden: op.hidden }));
  const clash = new Map<string, MergeOp>();
  for (const op of ops) {
    const k = `${op.to.slug}::${op.to.variant ?? ''}::${op.to.version}`;
    if (clash.has(k)) throw new Error(`To versjoner havner på samme sted: ${k} (${clash.get(k)!.fromTitle} og ${op.fromTitle})`);
    clash.set(k, op);
  }
  return { createdAt: new Date().toISOString(), ops, counts: { before: countsOf(before), after: countsOf(after as AssetManifest[]) } };
}

export const changed = (op: MergeOp, m: AssetManifest) =>
  op.from.slug !== op.to.slug ||
  op.from.variant !== op.to.variant ||
  op.from.version !== op.to.version ||
  m.title !== op.title ||
  (m.variantLabel ?? null) !== op.variantLabel ||
  (m.versionLabel ?? null) !== op.versionLabel ||
  (m.status ?? 'release') !== op.status ||
  !!m.titleNeedsReview !== !!op.titleNeedsReview ||
  (m.shareBlocked ?? null) !== (op.shareBlocked ?? null) ||
  !!m.hidden !== !!op.hidden;

// ---------------------------------------------------------------- utføring og angring

interface Journal {
  stamp: string;
  done: boolean;
  /** Mapper flyttet, i rekkefølge (relativt til media/). */
  moves: Array<[string, string]>;
  /** Tekstfiler flyttet (relativt til data/lyrics/). */
  lyricMoves: Array<[string, string]>;
  /** Manifester som ble skrevet om: original plassering (relativt til media/) → backupfil i journalen. */
  manifests: Array<[string, string]>;
  dataFiles: string[];
}

const vdir = (s: { slug: string; variant: string | null; version: number }) => path.join(s.slug, s.variant ?? 'main', `v${s.version}`);

async function movePath(from: string, to: string) {
  await mkdir(path.dirname(to), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      // Google Drive-synk kan holde mappa et øyeblikk (EPERM/EBUSY)
      if (i >= 5 || !/EPERM|EBUSY|EACCES/.test(String((e as NodeJS.ErrnoException).code))) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function removeEmptyUp(dir: string, stop: string) {
  let d = dir;
  while (path.resolve(d) !== path.resolve(stop)) {
    try {
      if ((await readdir(d)).length) return;
      await rmdir(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

export async function rebuildIndex(mediaDir: string): Promise<CatalogIndex> {
  const media = path.resolve(mediaDir);
  const assets: CatalogIndex['assets'] = [];
  for (const s of await readdir(media, { withFileTypes: true })) {
    if (!s.isDirectory() || s.name.startsWith('.')) continue;
    for (const v of await readdir(path.join(media, s.name), { withFileTypes: true }).catch(() => [])) {
      if (!v.isDirectory()) continue;
      for (const n of await readdir(path.join(media, s.name, v.name), { withFileTypes: true }).catch(() => [])) {
        const mf = path.join(media, s.name, v.name, n.name, 'manifest.json');
        if (!n.isDirectory() || !/^v\d+$/.test(n.name) || !existsSync(mf)) continue;
        const m = JSON.parse(await readFile(mf, 'utf8')) as AssetManifest;
        assets.push({ slug: m.slug, variant: m.variant, version: m.version, manifest: `${m.slug}/${m.variant ?? 'main'}/v${m.version}/manifest.json`, title: m.title, kind: m.kind, ...(m.status === 'draft' ? { status: 'draft' as const } : {}) });
      }
    }
  }
  assets.sort((a, b) => a.slug.localeCompare(b.slug) || (a.variant ?? '').localeCompare(b.variant ?? '') || b.version - a.version);
  const idx: CatalogIndex = { schema: 1, updatedAt: new Date().toISOString(), assets };
  await writeFile(path.join(media, 'index.json'), JSON.stringify(idx, null, 2));
  return idx;
}

type Lyr = { source?: string; approved?: boolean };
const lyricRank = (m: Lyr | null, hasWords: boolean) => (m ? (m.source === 'manual' ? 40 : m.source === 'aligned' ? 30 : m.source === 'instrumental' ? 25 : 20) + (m.approved ? 5 : 0) : hasWords ? 10 : 0);

export async function applyMerge(o: { mediaDir: string; dataDir: string; plan: MergePlan; log?: (l: string) => void }): Promise<{ stamp: string; journalDir: string; moved: number; rewritten: number }> {
  const media = path.resolve(o.mediaDir);
  const dataDir = path.resolve(o.dataDir);
  const log = o.log ?? (() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jdir = path.join(dataDir, 'merges', stamp);
  await mkdir(path.join(jdir, 'data'), { recursive: true });
  await mkdir(path.join(jdir, 'manifests'), { recursive: true });
  await mkdir(path.join(jdir, 'lyrics'), { recursive: true });
  const j: Journal = { stamp, done: false, moves: [], lyricMoves: [], manifests: [], dataFiles: [] };
  const save = () => writeFile(path.join(jdir, 'journal.json'), JSON.stringify(j, null, 1));

  // 1. Backup: data/*.json, media/index.json og manifestene
  for (const f of await readdir(dataDir)) {
    if (!f.endsWith('.json')) continue;
    await copyFile(path.join(dataDir, f), path.join(jdir, 'data', f));
    j.dataFiles.push(f);
  }
  await copyFile(path.join(media, 'index.json'), path.join(jdir, 'index.json'));
  const touched = [];
  for (const [i, op] of o.plan.ops.entries()) {
    const rel = path.join(vdir(op.from), 'manifest.json');
    const m = JSON.parse(await readFile(path.join(media, rel), 'utf8')) as AssetManifest;
    if (!changed(op, m)) continue;
    const bak = `${i}.json`;
    await copyFile(path.join(media, rel), path.join(jdir, 'manifests', bak));
    j.manifests.push([vdir(op.to), bak]); // gjenopprettes på den gamle plassen etter at mappa er flyttet tilbake
    touched.push({ op, m, bak });
  }
  await save();
  log(`Backup: ${j.dataFiles.length} datafiler, index.json og ${touched.length} manifester → ${path.relative(path.dirname(dataDir), jdir)}`);

  try {
    // 2. Flytt i to trinn (via en mellommappe), så bytter og kjeder ikke kolliderer
    const moving = touched.filter(({ op }) => vdir(op.from) !== vdir(op.to));
    const stage = `.merge-${stamp}`;
    for (const [i, { op }] of moving.entries()) {
      const tmp = path.join(stage, String(i));
      await movePath(path.join(media, vdir(op.from)), path.join(media, tmp));
      j.moves.push([vdir(op.from), tmp]);
    }
    await save();
    for (const [i, { op }] of moving.entries()) {
      const tmp = path.join(stage, String(i));
      if (existsSync(path.join(media, vdir(op.to)))) throw new Error(`Finnes allerede: ${vdir(op.to)}`);
      await movePath(path.join(media, tmp), path.join(media, vdir(op.to)));
      j.moves.push([tmp, vdir(op.to)]);
      await removeEmptyUp(path.join(media, path.dirname(vdir(op.from))), media);
    }
    await removeEmptyUp(path.join(media, stage), media);
    await save();
    log(`Flyttet ${moving.length} versjoner`);

    // 3. Skriv manifestene
    const at = new Date().toISOString();
    for (const { op, m } of touched) {
      const next: AssetManifest = {
        ...m,
        slug: op.to.slug,
        variant: op.to.variant,
        variantLabel: op.variantLabel,
        version: op.to.version,
        versionLabel: op.versionLabel,
        status: op.status,
        title: op.title
      };
      if (op.titleNeedsReview) next.titleNeedsReview = true;
      else delete next.titleNeedsReview;
      if (op.shareBlocked) next.shareBlocked = op.shareBlocked;
      else delete next.shareBlocked;
      if (op.hidden) next.hidden = true;
      else delete next.hidden;
      if (op.from.slug !== op.to.slug || op.from.variant !== op.to.variant || op.from.version !== op.to.version) next.mergedFrom = m.mergedFrom ?? { slug: op.from.slug, variant: op.from.variant, version: op.from.version, title: m.title, at };
      await writeFile(path.join(media, vdir(op.to), 'manifest.json'), JSON.stringify(next, null, 2));
    }
    const idx = await rebuildIndex(media);
    log(`Skrev ${touched.length} manifester; index.json: ${idx.assets.length} versjoner`);

    // 4. Referanser i data/
    const keyMap = new Map<string, { slug: string; variant: string | null; version: number }>();
    const tvMap = new Map<string, { slug: string; variant: string | null }>();
    const slugTargets = new Map<string, Set<string>>();
    for (const op of o.plan.ops) {
      keyMap.set(`${op.from.slug}::${op.from.variant ?? ''}::${op.from.version}`, op.to);
      tvMap.set(`${op.from.slug}::${op.from.variant ?? ''}`, { slug: op.to.slug, variant: op.to.variant });
      slugTargets.set(op.from.slug, new Set([...(slugTargets.get(op.from.slug) ?? []), op.to.slug]));
    }
    /** Slug-referanser (favoritter, lyttelogg, tekst): bare entydige. En oppdelt slug (1Echo …) har ingen. */
    const slugMap = (s: string): string | null => {
      const t = slugTargets.get(s);
      return !t ? s : t.size === 1 ? [...t][0]! : null;
    };
    const tv = (slug: string, variant: string | null) => tvMap.get(`${slug}::${variant ?? ''}`) ?? (slugTargets.has(slug) ? null : { slug, variant });
    const rj = async <T>(f: string): Promise<T | null> => (existsSync(path.join(dataDir, f)) ? (JSON.parse(await readFile(path.join(dataDir, f), 'utf8')) as T) : null);
    const wj = (f: string, v: unknown) => writeFile(path.join(dataDir, f), JSON.stringify(v, null, 2));

    type PlEntry = { slug: string; variant: string | null; version: number | null };
    const pl = await rj<{ playlists: Array<{ entries?: PlEntry[] }> }>('playlists.json');
    let plMoved = 0;
    if (pl) {
      for (const p of pl.playlists)
        for (const e of p.entries ?? []) {
          // Låst versjon: følg akkurat den versjonen; ellers «følg nyeste» i den nye varianten
          const locked = e.version != null ? keyMap.get(`${e.slug}::${e.variant ?? ''}::${e.version}`) : undefined;
          const t: { slug: string; variant: string | null } | null | undefined = locked ?? (e.version == null ? tv(e.slug, e.variant) : undefined);
          if (!t || (t.slug === e.slug && t.variant === e.variant && (!locked || locked.version === e.version))) continue;
          e.slug = t.slug;
          e.variant = t.variant;
          if (locked) e.version = locked.version;
          plMoved++;
        }
      await wj('playlists.json', pl);
    }
    const fav = await rj<{ slugs: string[]; updatedAt?: string }>('favorites.json');
    if (fav) await wj('favorites.json', { ...fav, slugs: [...new Set(fav.slugs.map((s) => slugMap(s) ?? s))] });
    const lis = await rj<{ bySlug: Record<string, { plays: number; ms: number; lastAt: string }> }>('listens.json');
    if (lis) {
      const out: typeof lis.bySlug = {};
      for (const [s, v] of Object.entries(lis.bySlug)) {
        const t = slugMap(s) ?? s;
        const cur = out[t];
        out[t] = cur ? { plays: cur.plays + v.plays, ms: cur.ms + v.ms, lastAt: cur.lastAt > v.lastAt ? cur.lastAt : v.lastAt } : { ...v };
      }
      await wj('listens.json', { ...lis, bySlug: out });
    }
    const pb = await rj<{ points: Array<{ slug: string; variant: string; updatedAt: string; deviceId?: string }> }>('playback.json');
    if (pb) {
      for (const p of pb.points) {
        const t = tv(p.slug, p.variant === 'main' ? null : p.variant);
        if (t) {
          p.slug = t.slug;
          p.variant = t.variant ?? 'main';
        }
      }
      await wj('playback.json', pb);
    }
    const sh = await rj<{ shares: Array<{ slug: string; variant: string; version: number }> }>('shares.json');
    if (sh) {
      for (const e of sh.shares) {
        const t = keyMap.get(`${e.slug}::${e.variant === 'main' ? '' : e.variant}::${e.version}`);
        if (t) Object.assign(e, { slug: t.slug, variant: t.variant ?? 'main', version: t.version });
      }
      await wj('shares.json', sh);
    }
    const src = await rj<{ entries: Record<string, unknown> }>('sources.json');
    if (src) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src.entries)) {
        const [s, va, ve] = k.split('::');
        const t = keyMap.get(`${s}::${va === 'main' ? '' : va}::${String(ve).replace(/^v/, '')}`);
        out[t ? `${t.slug}::${t.variant ?? 'main'}::v${t.version}` : k] = v;
      }
      await wj('sources.json', { ...src, entries: out });
    }
    const fpf = await rj<Record<string, unknown>>('fingerprints.json');
    if (fpf) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fpf)) {
        const [s, va, ve] = k.split('::');
        const t = keyMap.get(`${s}::${va}::${String(ve).replace(/^v/, '')}`);
        out[t ? `${t.slug}::${t.variant ?? ''}::v${t.version}` : k] = v;
      }
      await wj('fingerprints.json', out);
    }
    const sk = await rj<{ items: Array<{ matchSlug: string; matchVariant: string | null; matchTitle: string }> }>('import-skipped.json');
    if (sk?.items) {
      for (const it of sk.items) {
        const t = tv(it.matchSlug, it.matchVariant);
        if (t) Object.assign(it, { matchSlug: t.slug, matchVariant: t.variant });
      }
      await wj('import-skipped.json', sk);
    }
    const lb = await rj<{ slugs: Array<{ slug: string; title: string }>; done?: string[] }>('lyrics-batch.json');
    if (lb) {
      const titleOf = new Map(o.plan.ops.map((op) => [op.to.slug, op.title]));
      const seen = new Set<string>();
      const next: Array<{ slug: string; title: string }> = [];
      // Oppdelte slugs (1Echo …) får én oppføring per ny låt
      for (const e of lb.slugs) {
        const ts = slugTargets.get(e.slug) ? [...slugTargets.get(e.slug)!] : [e.slug];
        for (const t of ts) if (!seen.has(t)) seen.add(t), next.push({ slug: t, title: titleOf.get(t) ?? e.title });
      }
      await wj('lyrics-batch.json', { ...lb, slugs: next, done: lb.done ? [...new Set(lb.done.flatMap((s) => (slugMap(s) ? [slugMap(s)!] : [])))] : lb.done });
    }

    // 5. Tekster: per ny slug beholdes den beste (manuell > justert > instrumental > auto, godkjent først)
    const lyrDir = path.join(dataDir, 'lyrics');
    const lyrFiles = existsSync(lyrDir) ? await readdir(lyrDir) : [];
    // Bare filer som fortsatt ligger der: en oppdelt slug (1Echo …) er kilde for flere nye låter, og den første la dem til side
    const filesOf = (slug: string) => lyrFiles.filter((f) => f.startsWith(`${slug}.`) && /^\.(lrc|txt|meta\.json|words\.json)$/.test(f.slice(slug.length)) && existsSync(path.join(lyrDir, f)));
    const bySong = new Map<string, Set<string>>();
    for (const op of o.plan.ops) bySong.set(op.to.slug, new Set([...(bySong.get(op.to.slug) ?? []), op.from.slug]));
    let lyrKept = 0;
    let lyrParked = 0;
    const lmove = async (from: string, to: string) => {
      await movePath(path.join(lyrDir, from), to.startsWith('@journal/') ? path.join(jdir, 'lyrics', to.slice(9)) : path.join(lyrDir, to));
      j.lyricMoves.push([from, to]);
    };
    for (const [target, froms] of bySong) {
      const cands = [];
      for (const s of froms) {
        const fs = filesOf(s);
        if (!fs.length) continue;
        const meta = fs.includes(`${s}.meta.json`) ? ((JSON.parse(await readFile(path.join(lyrDir, `${s}.meta.json`), 'utf8')) as Lyr) ?? null) : null;
        cands.push({ s, fs, rank: lyricRank(meta, fs.includes(`${s}.words.json`)) + (s === target ? 1 : 0) });
      }
      cands.sort((a, b) => b.rank - a.rank);
      const split = [...froms].some((s) => (slugTargets.get(s)?.size ?? 0) > 1);
      // Først legges de andre til side, så flyttes vinneren inn (ellers kunne den overskrive eller bli flyttet bort)
      const winner = split ? null : cands[0]; // oppdelt slug: teksten hørte til én av låtene – ny tekst lages i kø
      for (const c of cands) {
        if (c === winner) continue;
        for (const f of c.fs) if (existsSync(path.join(lyrDir, f))) await lmove(f, `@journal/${f}`);
        lyrParked++;
      }
      if (winner) {
        if (winner.s !== target) for (const f of winner.fs) await lmove(f, `${target}${f.slice(winner.s.length)}`);
        lyrKept++;
      }
    }
    log(`Spillelister: ${plMoved} oppføringer flyttet · tekster: ${lyrKept} beholdt, ${lyrParked} lagt til side i journalen`);
    j.done = true;
    await save();
    return { stamp, journalDir: jdir, moved: moving.length, rewritten: touched.length };
  } catch (err) {
    log(`✗ ${err instanceof Error ? err.message : String(err)} – ruller tilbake`);
    await save();
    await undoMerge({ mediaDir: o.mediaDir, dataDir: o.dataDir, stamp, log });
    throw err;
  }
}

export async function undoMerge(o: { mediaDir: string; dataDir: string; stamp: string; log?: (l: string) => void }): Promise<void> {
  const media = path.resolve(o.mediaDir);
  const dataDir = path.resolve(o.dataDir);
  const log = o.log ?? (() => {});
  const jdir = path.join(dataDir, 'merges', o.stamp);
  const j = JSON.parse(await readFile(path.join(jdir, 'journal.json'), 'utf8')) as Journal;
  const lyrDir = path.join(dataDir, 'lyrics');
  for (const [from, to] of [...j.lyricMoves].reverse()) {
    const src = to.startsWith('@journal/') ? path.join(jdir, 'lyrics', to.slice(9)) : path.join(lyrDir, to);
    if (existsSync(src)) await movePath(src, path.join(lyrDir, from));
  }
  // Manifestene skrives tilbake på den nye plassen før mappene flyttes tilbake
  for (const [rel, bak] of j.manifests) if (existsSync(path.join(media, rel))) await copyFile(path.join(jdir, 'manifests', bak), path.join(media, rel, 'manifest.json'));
  for (const [from, to] of [...j.moves].reverse()) {
    if (!existsSync(path.join(media, to))) continue;
    await movePath(path.join(media, to), path.join(media, from));
    await removeEmptyUp(path.join(media, path.dirname(to)), media);
  }
  for (const f of j.dataFiles) await copyFile(path.join(jdir, 'data', f), path.join(dataDir, f));
  await copyFile(path.join(jdir, 'index.json'), path.join(media, 'index.json'));
  j.done = false;
  await writeFile(path.join(jdir, 'journal.json'), JSON.stringify({ ...j, undoneAt: new Date().toISOString() }, null, 1));
  log(`Angret sammenslåing ${o.stamp}: ${j.moves.length / 2} versjoner og ${j.lyricMoves.length} tekstfiler flyttet tilbake, ${j.dataFiles.length} datafiler og index.json gjenopprettet`);
}
