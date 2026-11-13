import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPlaylistColor, pickColor, PLAYLIST_LIMITS, type Playlist, type PlaylistEntry, type PlaylistsFile } from '@gv/shared';

/**
 * Spillelistene i data/playlists.json (gitignored). Én skriver om gangen (kø), atomisk skriving
 * (tempfil + rename) og forrige versjon som playlists.backup.json.
 */
export class PlaylistError extends Error {
  constructor(
    public status: number,
    message: string,
    public current?: Playlist
  ) {
    super(message);
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

export interface EntryInput {
  slug: string;
  variant?: string | null;
  version?: number | null;
}

export interface CreateInput {
  name: string;
  kind?: 'manual' | 'smart';
  query?: string | null;
  entries?: EntryInput[];
  color?: string;
}

export interface PatchInput {
  /** Påkrevd: updatedAt slik klienten sist så lista. */
  updatedAt: string;
  name?: string;
  /** Hele lista i ny rekkefølge (flytt/fjern). Oppføringer identifiseres med id; nye får id. */
  entries?: Array<EntryInput & { id?: string; addedAt?: string }>;
  /** Legg til bakerst. */
  add?: EntryInput[];
  query?: string;
  color?: string;
}

export function createPlaylistStore(file: string, now: () => Date = () => new Date()) {
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;

  /** Strengt stigende tidsstempel, så to endringer i samme millisekund ikke får samme updatedAt. */
  const stamp = () => {
    last = Math.max(now().getTime(), last + 1);
    return new Date(last).toISOString();
  };

  async function read(): Promise<PlaylistsFile> {
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as PlaylistsFile;
      if (j && Array.isArray(j.playlists)) {
        for (const p of j.playlists) {
          last = Math.max(last, Date.parse(p.updatedAt) || 0);
          // Eldre filer: fyll inn felt som kom senere (farge, cover, versjon).
          if (!isPlaylistColor(p.color)) p.color = pickColor(j.playlists.map((x) => x.color).filter(isPlaylistColor));
          p.cover ??= null;
          for (const e of p.entries) e.version ??= null;
        }
        return j;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new PlaylistError(500, `Klarte ikke å lese ${path.basename(file)}: ${(err as Error).message}`);
    }
    return { schema: 1, playlists: [] };
  }

  async function write(data: PlaylistsFile) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await copyFile(file, file.replace(/\.json$/, '.backup.json')).catch(() => {});
    await rename(tmp, file);
  }

  /** Kjør endringer etter hverandre, så to samtidige forespørsler ikke overskriver hverandre. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  const entry = (e: EntryInput & { id?: string; addedAt?: string }, at: string): PlaylistEntry => {
    if (!e || typeof e.slug !== 'string' || !SLUG_RE.test(e.slug)) throw new PlaylistError(400, 'ugyldig slug');
    const variant = e.variant ?? null;
    if (variant !== null && (typeof variant !== 'string' || !SLUG_RE.test(variant))) throw new PlaylistError(400, 'ugyldig variant');
    const version = e.version ?? null;
    if (version !== null && (!Number.isInteger(version) || version < 1 || version > 9999)) throw new PlaylistError(400, 'ugyldig versjon');
    return { id: typeof e.id === 'string' && /^[\w-]{1,64}$/.test(e.id) ? e.id : randomUUID(), slug: e.slug, variant, version, addedAt: typeof e.addedAt === 'string' ? e.addedAt : at };
  };
  const name = (v: unknown) => {
    const n = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (!n) throw new PlaylistError(400, 'navn mangler');
    if (n.length > PLAYLIST_LIMITS.name) throw new PlaylistError(400, 'navnet er for langt');
    return n;
  };
  const query = (v: unknown) => {
    const q = typeof v === 'string' ? v.trim() : '';
    if (!q) throw new PlaylistError(400, 'søk mangler');
    if (q.length > PLAYLIST_LIMITS.query) throw new PlaylistError(400, 'søket er for langt');
    return q;
  };
  const color = (v: unknown) => {
    if (!isPlaylistColor(v)) throw new PlaylistError(400, 'ukjent farge');
    return v;
  };
  const checkSize = (n: number) => {
    if (n > PLAYLIST_LIMITS.entries) throw new PlaylistError(400, 'for mange låter i lista');
  };

  return {
    file,
    list: () => serial(async () => (await read()).playlists),

    create: (input: CreateInput) =>
      serial(async () => {
        const data = await read();
        if (data.playlists.length >= PLAYLIST_LIMITS.playlists) throw new PlaylistError(400, 'for mange spillelister');
        const at = stamp();
        const kind = input.kind === 'smart' ? 'smart' : 'manual';
        const entries = kind === 'manual' ? (Array.isArray(input.entries) ? input.entries : []).map((e) => entry(e, at)) : [];
        checkSize(entries.length);
        const p: Playlist = {
          id: randomUUID(),
          name: name(input.name),
          kind,
          entries,
          query: kind === 'smart' ? query(input.query) : null,
          color: input.color !== undefined ? color(input.color) : pickColor(data.playlists.map((x) => x.color)),
          cover: null,
          createdAt: at,
          updatedAt: at,
          usedAt: entries.length ? at : null
        };
        data.playlists.push(p);
        await write(data);
        return p;
      }),

    patch: (id: string, input: PatchInput) =>
      serial(async () => {
        const data = await read();
        const i = data.playlists.findIndex((p) => p.id === id);
        if (i < 0) throw new PlaylistError(404, 'fant ikke spillelista');
        const cur = data.playlists[i]!;
        if (input.updatedAt !== cur.updatedAt) throw new PlaylistError(409, 'lista er endret et annet sted', cur);
        const at = stamp();
        const next: Playlist = { ...cur, updatedAt: at };
        if (input.name !== undefined) next.name = name(input.name);
        if (input.color !== undefined) next.color = color(input.color);
        if (cur.kind === 'smart') {
          if (input.entries !== undefined || input.add !== undefined) throw new PlaylistError(400, 'smarte lister kan ikke sorteres eller fylles manuelt');
          if (input.query !== undefined) next.query = query(input.query);
        } else {
          if (input.query !== undefined) throw new PlaylistError(400, 'bare smarte lister har søk');
          if (input.entries !== undefined) {
            if (!Array.isArray(input.entries)) throw new PlaylistError(400, 'entries må være en liste');
            next.entries = input.entries.map((e) => entry(e, at));
            if (new Set(next.entries.map((e) => e.id)).size !== next.entries.length) throw new PlaylistError(400, 'duplikat oppførings-id');
          }
          if (input.add !== undefined) {
            if (!Array.isArray(input.add) || input.add.length === 0) throw new PlaylistError(400, 'add må være en ikke-tom liste');
            next.entries = [...next.entries, ...input.add.map((e) => entry({ slug: e.slug, variant: e.variant, version: e.version }, at))];
            next.usedAt = at;
          }
          checkSize(next.entries.length);
        }
        data.playlists[i] = next;
        await write(data);
        return next;
      }),

    remove: (id: string, updatedAt: string | undefined) =>
      serial(async () => {
        const data = await read();
        const cur = data.playlists.find((p) => p.id === id);
        if (!cur) throw new PlaylistError(404, 'fant ikke spillelista');
        if (updatedAt !== cur.updatedAt) throw new PlaylistError(409, 'lista er endret et annet sted', cur);
        data.playlists = data.playlists.filter((p) => p.id !== id);
        await write(data);
      })
  };
}

export type PlaylistStore = ReturnType<typeof createPlaylistStore>;
