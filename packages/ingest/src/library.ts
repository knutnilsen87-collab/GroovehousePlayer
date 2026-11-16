import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Del 14: små egne data ved siden av spillelistene (data/, gitignored):
 *  - favorites.json   hjertet per låt (slug) → innebygd smart liste «Favoritter»
 *  - lyrics/<slug>.lrc|.txt   sangtekst (synkronisert LRC eller ren tekst), redigeres i Studio
 *  - listens.json     egne avspillinger per låt (antall, tid lyttet, sist) → «Analyse»
 * Samme tilgangsregler som spillelistene (bare egne enheter, aldri /drop/). Skrives atomisk.
 */

export class LibraryError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
export const checkSlug = (slug: string) => {
  if (!SLUG_RE.test(slug)) throw new LibraryError(400, 'ugyldig slug');
  return slug;
};

async function writeAtomic(file: string, data: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Én skriving om gangen per fil (to raske hjerte-trykk skal ikke miste ett). */
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
}

// ---------------------------------------------------------------- Favoritter

export interface Favorites {
  slugs: string[];
  updatedAt: string;
}

export function createFavoritesStore(file: string, now: () => Date = () => new Date()) {
  const run = serial();
  const read = async (): Promise<Favorites> => {
    if (!existsSync(file)) return { slugs: [], updatedAt: new Date(0).toISOString() };
    const j = JSON.parse(await readFile(file, 'utf8')) as Partial<Favorites>;
    return { slugs: Array.isArray(j.slugs) ? j.slugs.filter((s) => typeof s === 'string' && SLUG_RE.test(s)) : [], updatedAt: j.updatedAt ?? new Date(0).toISOString() };
  };
  const set = (slug: string, on: boolean) =>
    run(async () => {
      checkSlug(slug);
      const f = await read();
      const has = f.slugs.includes(slug);
      if (has === on) return f;
      // Nyeste først, så «Favoritter» viser sist hjertede øverst
      const next: Favorites = { slugs: on ? [slug, ...f.slugs] : f.slugs.filter((s) => s !== slug), updatedAt: now().toISOString() };
      await writeAtomic(file, JSON.stringify(next, null, 2));
      return next;
    });
  return { read, set };
}
export type FavoritesStore = ReturnType<typeof createFavoritesStore>;

// ---------------------------------------------------------------- Sangtekst

export interface Lyrics {
  slug: string;
  format: 'lrc' | 'txt';
  text: string;
  /** Hvor teksten kommer fra. Mangler = skrevet/limt inn av Knut. */
  meta?: LyricsMeta | null;
}
/**
 * data/lyrics/<slug>.meta.json. `auto` = transkribert fra lyden (vises som «Auto – sjekk teksten» til
 * `approved`), `aligned` = Knuts tekst med beregnede ordtider, `manual` = skrevet/limt inn.
 */
export interface LyricsMeta {
  source: 'auto' | 'aligned' | 'manual' | 'instrumental';
  approved: boolean;
  at: string;
}
const MAX_LYRICS = 200_000;

export function createLyricsStore(dir: string) {
  const fileOf = (slug: string, format: 'lrc' | 'txt') => path.join(dir, `${checkSlug(slug)}.${format}`);
  const metaOf = (slug: string) => path.join(dir, `${checkSlug(slug)}.meta.json`);
  const readMeta = async (slug: string): Promise<LyricsMeta | null> => {
    try {
      return JSON.parse(await readFile(metaOf(slug), 'utf8')) as LyricsMeta;
    } catch {
      return null;
    }
  };
  const run = serial();
  return {
    async get(slug: string): Promise<Lyrics | null> {
      for (const format of ['lrc', 'txt'] as const) {
        const f = fileOf(slug, format);
        if (existsSync(f)) return { slug, format, text: (await readFile(f, 'utf8')).replace(/^﻿/, ''), meta: await readMeta(slug) };
      }
      return null;
    },
    getMeta: readMeta,
    /** Setter kilde/godkjenning (null fjerner). */
    setMeta: (slug: string, meta: Omit<LyricsMeta, 'at'> | null) =>
      run(async () => {
        if (!meta) return void (await rm(metaOf(slug), { force: true }));
        await mkdir(dir, { recursive: true });
        await writeAtomic(metaOf(slug), JSON.stringify({ ...meta, at: new Date().toISOString() }, null, 2) + '\n');
      }),
    /** Knut har sjekket en automatisk transkribert tekst: merket «Auto – sjekk teksten» forsvinner. */
    approve: (slug: string) =>
      run(async (): Promise<LyricsMeta | null> => {
        const m = await readMeta(slug);
        if (!m) return null;
        const next = { ...m, approved: true, at: new Date().toISOString() };
        await writeAtomic(metaOf(slug), JSON.stringify(next, null, 2) + '\n');
        return next;
      }),
    /** Slugs med tekst (lrc eller txt). */
    async slugs(): Promise<Set<string>> {
      if (!existsSync(dir)) return new Set();
      return new Set((await readdir(dir)).map((n) => /^(.+)\.(lrc|txt)$/.exec(n)?.[1]).filter((s): s is string => !!s));
    },
    /** Tom tekst sletter. Ny lagring i ett format fjerner det andre (én tekst per låt). */
    put: (slug: string, format: unknown, text: unknown) =>
      run(async (): Promise<Lyrics | null> => {
        if (format !== 'lrc' && format !== 'txt') throw new LibraryError(400, 'format må være lrc eller txt');
        if (typeof text !== 'string') throw new LibraryError(400, 'text mangler');
        if (text.length > MAX_LYRICS) throw new LibraryError(413, 'teksten er for lang');
        const clean = text.replace(/\r\n/g, '\n').trim();
        await rm(fileOf(slug, format === 'lrc' ? 'txt' : 'lrc'), { force: true });
        if (!clean) {
          await rm(fileOf(slug, format), { force: true });
          await rm(metaOf(slug), { force: true });
          return null;
        }
        await writeAtomic(fileOf(slug, format), `${clean}\n`);
        return { slug, format, text: `${clean}\n` };
      })
  };
}
export type LyricsStore = ReturnType<typeof createLyricsStore>;

// ---------------------------------------------------------------- Egne avspillinger (Analyse)

export interface ListenStat {
  plays: number;
  /** Tid lyttet (ms), summert fra hjerteslag/pause/slutt. */
  ms: number;
  lastAt: string;
}
export interface ListenLog {
  bySlug: Record<string, ListenStat>;
  /** Siste spilte, nyeste først (maks 50), til «Nylig spilt» på Hjem. */
  recent: Array<{ slug: string; at: string }>;
  /** Tid lyttet per dag (YYYY-MM-DD → ms), siste 90 dager. */
  byDay: Record<string, number>;
}

export function createListenStore(file: string, now: () => Date = () => new Date()) {
  const run = serial();
  const read = async (): Promise<ListenLog> => {
    if (!existsSync(file)) return { bySlug: {}, recent: [], byDay: {} };
    const j = JSON.parse(await readFile(file, 'utf8')) as Partial<ListenLog>;
    return { bySlug: j.bySlug ?? {}, recent: j.recent ?? [], byDay: j.byDay ?? {} };
  };
  return {
    read,
    /** `play` = ny avspilling startet; `ms` = lyttet tid siden forrige rapport (maks 5 min per rapport). */
    add: (events: unknown) =>
      run(async () => {
        if (!Array.isArray(events) || events.length > 200) throw new LibraryError(400, 'events må være en liste (maks 200)');
        const log = await read();
        const t = now();
        const day = t.toISOString().slice(0, 10);
        for (const e of events as Array<{ slug?: unknown; play?: unknown; ms?: unknown }>) {
          if (typeof e?.slug !== 'string' || !SLUG_RE.test(e.slug)) continue;
          const ms = typeof e.ms === 'number' && Number.isFinite(e.ms) ? Math.max(0, Math.min(300_000, Math.round(e.ms))) : 0;
          const s = (log.bySlug[e.slug] ??= { plays: 0, ms: 0, lastAt: t.toISOString() });
          s.ms += ms;
          s.lastAt = t.toISOString();
          if (e.play === true) {
            s.plays++;
            log.recent = [{ slug: e.slug, at: t.toISOString() }, ...log.recent.filter((r) => r.slug !== e.slug)].slice(0, 50);
          }
          if (ms) log.byDay[day] = (log.byDay[day] ?? 0) + ms;
        }
        const cutoff = new Date(t.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
        for (const d of Object.keys(log.byDay)) if (d < cutoff) delete log.byDay[d];
        await writeAtomic(file, JSON.stringify(log));
        return log;
      })
  };
}
export type ListenStore = ReturnType<typeof createListenStore>;
