import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isDraft, type AssetManifest, type CatalogIndex, type ReleaseInfo } from '@gv/shared';
import type { VaultConfig } from './config';
import { FFMPEG, run } from './ffmpeg';
import { findMaster } from './share';

/**
 * Del 24: release-pakke for LANDR. LANDR har ingen åpen API for distribusjon, så Vault gjør forarbeidet:
 *   releases/<dato>-<tittel>/  (gitignored)
 *     01 - Tittel.wav        24-bit / 44,1 kHz / stereo fra master.flac, med true peak- og klippesjekk
 *     cover.jpg              3000×3000 RGB (advarsel hvis generert eller AI-laget)
 *     metadata.json / .txt   alt LANDR spør om, i samme rekkefølge som skjemaet
 *     sjekkliste.txt         det som mangler
 * Umastrede låter blokkeres med mindre Knut bekrefter «Utgi likevel». Ingenting sendes noe sted.
 */
export const RELEASE_DEFAULTS = { artist: 'Echo Groove', label: 'Groovehouse Records', genre: 'Tech House', language: 'Engelsk', explicit: 'Nei' };

export interface PackItem {
  slug: string;
  variant: string | null;
  version: number;
}
export interface PackTrack {
  n: number;
  title: string;
  file: string;
  isrc: string | null;
  bpm: number | null;
  key: string | null;
  durationMs: number;
  truePeakDb: number | null;
  clipped: boolean;
  lyrics: string | null;
  status: string;
}
export interface PackResult {
  dir: string;
  relDir: string;
  title: string;
  tracks: PackTrack[];
  cover: { file: string | null; source: string; warning: string | null };
  metadata: Record<string, unknown>;
  fields: Array<{ label: string; value: string }>;
  checklist: Array<{ item: string; ok: boolean; note?: string }>;
  warnings: string[];
}

const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

/** Teksten uten tidskoder (LRC), eller null. */
async function lyricsText(dataDir: string, slug: string): Promise<string | null> {
  for (const ext of ['txt', 'lrc']) {
    const f = path.join(dataDir, 'lyrics', `${slug}.${ext}`);
    if (!existsSync(f)) continue;
    const t = (await readFile(f, 'utf8'))
      .replace(/\[\d+:\d+(?:\.\d+)?\]|<\d+:\d+(?:\.\d+)?>/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (t) return t;
  }
  return null;
}

/** True peak (dBTP) fra ffmpeg ebur128, og om fila er klippet (true peak over 0). */
export async function truePeak(file: string): Promise<number | null> {
  const r = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { allowFail: true });
  const m = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/i.exec(r.stderr);
  if (!m) return null;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

/** Ren funksjon: sjekklista ut fra det som er samlet (testes). */
export function releaseChecklist(o: { tracks: Array<Pick<PackTrack, 'title' | 'isrc' | 'clipped' | 'truePeakDb' | 'lyrics' | 'status'>>; info: ReleaseInfo | null; cover: PackResult['cover']; aiMusic: string | null; aiCover: string | null; genre: string }) {
  const c: PackResult['checklist'] = [];
  c.push({ item: 'Cover 3000×3000', ok: !!o.cover.file, note: o.cover.file ? (o.cover.warning ?? undefined) : 'Mangler cover' });
  c.push({ item: 'Utgivelsesdato', ok: !!o.info?.date, note: o.info?.date ? undefined : 'Velg dato (LANDR anbefaler minst 2–3 uker fram)' });
  c.push({ item: 'Sjanger', ok: !!o.genre });
  c.push({ item: 'AI brukt i musikken (ja/nei)', ok: o.aiMusic === 'ja' || o.aiMusic === 'nei', note: 'Velg selv for hver utgivelse' });
  c.push({ item: 'AI brukt i coveret (ja/nei)', ok: o.aiCover === 'ja' || o.aiCover === 'nei', note: 'Velg selv for hver utgivelse' });
  for (const t of o.tracks) {
    if (t.status === 'draft') c.push({ item: `«${t.title}» er umastret`, ok: false, note: 'Send til LANDR-mastering først, eller bekreft «Utgi likevel»' });
    if (t.clipped) c.push({ item: `«${t.title}» klipper (true peak ${t.truePeakDb} dBTP)`, ok: false, note: 'Master på nytt med lavere nivå' });
    else if (t.truePeakDb != null && t.truePeakDb > -1) c.push({ item: `«${t.title}» true peak ${t.truePeakDb} dBTP`, ok: false, note: 'Over −1 dBTP kan gi forvrengning etter koding hos strømmetjenestene' });
    c.push({ item: `ISRC for «${t.title}»`, ok: !!t.isrc, note: t.isrc ? undefined : 'Ikke påkrevd – LANDR tildeler ISRC hvis du ikke har en' });
  }
  if (!o.info?.upc) c.push({ item: 'UPC/EAN', ok: false, note: 'Ikke påkrevd – LANDR tildeler UPC hvis du ikke har en' });
  return c;
}

export async function prepareRelease(o: {
  mediaDir: string;
  dataDir: string;
  root: string;
  cfg: VaultConfig;
  items: PackItem[];
  title?: string;
  genre?: string;
  confirmDraft?: boolean;
  aiMusic?: string | null;
  aiCover?: string | null;
  releases?: Record<string, ReleaseInfo>;
  now?: Date;
}): Promise<PackResult> {
  if (!o.items.length || o.items.length > 30) throw Object.assign(new Error('Velg 1–30 låter'), { status: 400 });
  const idx = JSON.parse(await readFile(path.join(path.resolve(o.mediaDir), 'index.json'), 'utf8')) as CatalogIndex;
  const loaded: Array<{ m: AssetManifest; dir: string; master: string }> = [];
  for (const it of o.items) {
    const e = idx.assets.find((a) => a.slug === it.slug && (a.variant ?? null) === (it.variant ?? null) && a.version === it.version);
    if (!e) throw Object.assign(new Error(`Fant ikke ${it.slug} v${it.version}`), { status: 404 });
    const dir = path.dirname(path.join(path.resolve(o.mediaDir), e.manifest));
    const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as AssetManifest;
    const master = findMaster(dir);
    if (!master) throw Object.assign(new Error(`«${m.title}» mangler master.flac`), { status: 409 });
    loaded.push({ m, dir, master });
  }
  // Umastrede blokkeres (pkt. 3) med mindre Knut har bekreftet
  const drafts = loaded.filter((x) => isDraft(x.m));
  if (drafts.length && !o.confirmDraft) throw Object.assign(new Error(`Umastret: ${drafts.map((d) => d.m.title).join(', ')}. Bekreft «Utgi likevel» eller send til LANDR-mastering først.`), { status: 409, drafts: drafts.map((d) => d.m.slug) });

  const first = loaded[0]!.m;
  const title = (o.title ?? (loaded.length === 1 ? first.title : first.album ?? first.title)).trim();
  const info = o.releases?.[first.slug] ?? null;
  const date = (o.now ?? new Date()).toISOString().slice(0, 10);
  const relDir = path.join('releases', `${date}-${safeName(title).replace(/ /g, '-')}`);
  const dir = path.join(o.root, relDir);
  await mkdir(dir, { recursive: true });

  const tracks: PackTrack[] = [];
  const warnings: string[] = [];
  for (const [i, x] of loaded.entries()) {
    const n = i + 1;
    const file = `${String(n).padStart(2, '0')} - ${safeName(x.m.variantLabel ? `${x.m.title} (${x.m.variantLabel})` : x.m.title)}.wav`;
    const out = path.join(dir, file);
    await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-i', x.master, '-map_metadata', '-1', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s24le', `${out}.partial.wav`]);
    await rename(`${out}.partial.wav`, out);
    const tp = await truePeak(out);
    const tpR = tp == null ? null : Math.round(tp * 10) / 10;
    const clipped = tpR != null && tpR > 0;
    if (clipped) warnings.push(`«${x.m.title}» klipper (true peak ${tpR} dBTP)`);
    tracks.push({
      n,
      title: x.m.variantLabel ? `${x.m.title} (${x.m.variantLabel})` : x.m.title,
      file,
      isrc: o.releases?.[x.m.slug]?.isrc ?? null,
      bpm: x.m.bpm,
      key: x.m.key ? `${x.m.key.name} (${x.m.key.camelot})` : null,
      durationMs: x.m.durationMs,
      truePeakDb: tpR,
      clipped,
      lyrics: await lyricsText(o.dataDir, x.m.slug),
      status: isDraft(x.m) ? 'draft' : 'release'
    });
  }

  // Cover: 3000×3000 RGB JPG fra coveret til første låt
  let cover: PackResult['cover'] = { file: null, source: 'mangler', warning: 'Mangler cover' };
  const coverSrc = first.files.cover ? path.join(loaded[0]!.dir, first.files.cover) : null;
  if (coverSrc && existsSync(coverSrc)) {
    await sharp(coverSrc).resize(3000, 3000, { fit: 'cover' }).toColourspace('srgb').removeAlpha().jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(path.join(dir, 'cover.jpg'));
    const src = first.coverSource === 'ai' ? 'AI-generert' : first.coverSource === 'generated' ? 'Vault-cover (generert)' : 'Eget cover';
    cover = { file: 'cover.jpg', source: src, warning: first.coverSource === 'ai' || first.coverSource === 'generated' ? `${src}: velg bevisst om det skal brukes i utgivelsen` : null };
    if (cover.warning) warnings.push(cover.warning);
  }

  const year = (info?.date ?? date).slice(0, 4);
  const genre = o.genre?.trim() || RELEASE_DEFAULTS.genre;
  const metadata = {
    schema: 1,
    title,
    type: info?.releaseType ?? (loaded.length === 1 ? 'single' : loaded.length <= 6 ? 'ep' : 'album'),
    artist: first.artist ?? RELEASE_DEFAULTS.artist,
    label: first.label ?? RELEASE_DEFAULTS.label,
    pLine: `℗ ${year} ${first.label ?? RELEASE_DEFAULTS.label}`,
    cLine: `© ${year} ${first.label ?? RELEASE_DEFAULTS.label}`,
    genre,
    language: RELEASE_DEFAULTS.language,
    explicit: RELEASE_DEFAULTS.explicit,
    releaseDate: info?.date ?? null,
    upc: info?.upc ?? null,
    aiMusic: o.aiMusic ?? null,
    aiCover: o.aiCover ?? null,
    cover: cover.file ? { file: cover.file, source: cover.source } : null,
    tracks: tracks.map((t) => ({ n: t.n, title: t.title, file: t.file, isrc: t.isrc, bpm: t.bpm, key: t.key, duration: `${Math.floor(t.durationMs / 60000)}:${String(Math.round((t.durationMs % 60000) / 1000)).padStart(2, '0')}`, truePeakDb: t.truePeakDb, lyrics: t.lyrics })),
    credits: { producer: first.artist ?? RELEASE_DEFAULTS.artist, composer: first.artist ?? RELEASE_DEFAULTS.artist },
    preparedAt: (o.now ?? new Date()).toISOString()
  };
  // Feltene i samme rekkefølge som LANDRs utgivelsesskjema (kopier-knappene)
  const fields: PackResult['fields'] = [
    { label: 'Tittel på utgivelsen', value: title },
    { label: 'Hovedartist', value: metadata.artist },
    { label: 'Plateselskap', value: metadata.label },
    { label: 'Sjanger', value: genre },
    { label: 'Språk', value: metadata.language },
    { label: 'Utgivelsesdato', value: metadata.releaseDate ?? '' },
    { label: '℗-linje', value: metadata.pLine },
    { label: '©-linje', value: metadata.cLine },
    { label: 'UPC', value: metadata.upc ?? '' },
    ...tracks.flatMap((t) => [
      { label: `Spor ${t.n}: tittel`, value: t.title },
      { label: `Spor ${t.n}: ISRC`, value: t.isrc ?? '' },
      { label: `Spor ${t.n}: eksplisitt`, value: metadata.explicit },
      ...(t.lyrics ? [{ label: `Spor ${t.n}: sangtekst`, value: t.lyrics }] : [])
    ])
  ];
  const checklist = releaseChecklist({ tracks, info, cover, aiMusic: o.aiMusic ?? null, aiCover: o.aiCover ?? null, genre });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await writeFile(path.join(dir, 'metadata.txt'), fields.map((f) => `${f.label}: ${f.value}`).join('\n') + '\n');
  await writeFile(path.join(dir, 'sjekkliste.txt'), checklist.map((c) => `[${c.ok ? 'x' : ' '}] ${c.item}${c.note ? ` – ${c.note}` : ''}`).join('\n') + '\n');
  return { dir, relDir, title, tracks, cover, metadata, fields, checklist, warnings };
}

/**
 * «Send til LANDR-mastering»: WAV (24-bit/44,1 kHz) av låta i opplastingsmappa. Knut laster opp og ned selv
 * på landr.com; masteren som kommer tilbake i LANDR\Mastere kobles automatisk til låta.
 */
export async function sendToLandr(o: { mediaDir: string; cfg: VaultConfig; item: PackItem }): Promise<{ file: string }> {
  const idx = JSON.parse(await readFile(path.join(path.resolve(o.mediaDir), 'index.json'), 'utf8')) as CatalogIndex;
  const e = idx.assets.find((a) => a.slug === o.item.slug && (a.variant ?? null) === (o.item.variant ?? null) && a.version === o.item.version);
  if (!e) throw Object.assign(new Error('Fant ikke låta'), { status: 404 });
  const dir = path.dirname(path.join(path.resolve(o.mediaDir), e.manifest));
  const m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as AssetManifest;
  const master = findMaster(dir);
  if (!master) throw Object.assign(new Error(`«${m.title}» mangler master.flac`), { status: 409 });
  await mkdir(o.cfg.landr.uploadDir, { recursive: true });
  const name = `${safeName(m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title)}.wav`;
  const out = path.join(o.cfg.landr.uploadDir, name);
  await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-i', master, '-map_metadata', '-1', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s24le', `${out}.partial.wav`]);
  await rename(`${out}.partial.wav`, out);
  return { file: out };
}
