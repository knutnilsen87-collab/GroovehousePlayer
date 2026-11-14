import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { shareFileName, type AssetManifest, type ShareKind } from '@gv/shared';
import { FFMPEG, FFPROBE, run } from './ffmpeg';

/**
 * Del 10: Vaults egen tapsfrie kopi av masteren, og filene som deles (WhatsApp, e-post …).
 *
 * Master: media/<slug>/<variant>/v<N>/master.flac, laget ved ingest (eller fylt inn én gang fra
 * REASONDONE, kun lesing). Deling lages aldri fra HLS (tapsbasert to ganger). Flyttall-WAV (FLAC kan
 * ikke lagre det) kopieres som master.wav i stedet. /media serverer aldri masteren eller share/.
 *
 * Delte filer caches i <versjon>/share/ og fornyes når master, cover eller metadata endres.
 */
export const MASTER_NAMES = ['master.flac', 'master.wav'] as const;

export function findMaster(versionDir: string): string | null {
  for (const n of MASTER_NAMES) if (existsSync(path.join(versionDir, n))) return path.join(versionDir, n);
  return null;
}

async function sampleFormat(file: string): Promise<{ fmt: string; bits: number }> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_fmt,bits_per_raw_sample,bits_per_sample', '-of', 'json', file]);
  const s = (JSON.parse(stdout) as { streams?: Array<{ sample_fmt?: string; bits_per_raw_sample?: string; bits_per_sample?: number }> }).streams?.[0] ?? {};
  const bits = Number(s.bits_per_raw_sample) || Number(s.bits_per_sample) || (s.sample_fmt?.startsWith('s16') ? 16 : 24);
  return { fmt: s.sample_fmt ?? 's16', bits };
}

/** Lager Vaults kopi av masteren i `outDir`. Kilden (REASONDONE) leses bare. */
export async function makeMasterCopy(src: string, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const { fmt, bits } = await sampleFormat(src);
  if (/^(flt|dbl)/.test(fmt)) {
    // Flyttall: FLAC kan ikke lagre det tapsfritt → behold originalen som den er.
    const out = path.join(outDir, 'master.wav');
    await copyFile(src, `${out}.tmp`);
    await rename(`${out}.tmp`, out);
    return out;
  }
  const out = path.join(outDir, 'master.flac');
  const tmp = path.join(outDir, 'master.tmp.flac');
  await run(FFMPEG, ['-y', '-v', 'error', '-i', src, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '8', ...(bits > 16 ? ['-sample_fmt', 's32', '-bits_per_raw_sample', String(Math.min(bits, 24))] : []), tmp]);
  await rename(tmp, out);
  return out;
}

export interface ShareFile {
  file: string;
  fileName: string;
  contentType: string;
  size: number;
}

const yearOf = (m: AssetManifest) => Number((m.copyright ?? '').match(/\b(19|20)\d{2}\b/)?.[0] ?? new Date(m.createdAt).getFullYear());

/** Reservecover for låter uten cover: mørk bunn, gullring, merket og tittelen. Bare for delte filer. */
async function fallbackCover(dir: string, m: AssetManifest, logo: string | null): Promise<string> {
  const out = path.join(dir, `cover-fallback-${createHash('sha1').update(m.title).digest('hex').slice(0, 10)}.jpg`);
  if (existsSync(out)) return out;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const title = m.title.length > 28 ? `${m.title.slice(0, 27)}…` : m.title;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="#07080B"/>` +
      `<circle cx="600" cy="520" r="360" fill="none" stroke="#F0C030" stroke-width="10" opacity="0.85"/>` +
      `<text x="600" y="1030" font-family="Oswald, Arial Narrow, Arial, sans-serif" font-size="72" font-weight="600" fill="#F4EEDD" text-anchor="middle" letter-spacing="4">${esc(title.toUpperCase())}</text>` +
      `<text x="600" y="1110" font-family="Inter, Arial, sans-serif" font-size="34" fill="#C9B98E" text-anchor="middle" letter-spacing="8">ECHO GROOVE · GROOVEHOUSE RECORDS</text></svg>`
  );
  const layers: sharp.OverlayOptions[] = [];
  if (logo && existsSync(logo)) layers.push({ input: await sharp(logo).resize(520, 520, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer(), left: 340, top: 260 });
  await sharp(svg).composite(layers).jpeg({ quality: 88, mozjpeg: true }).toFile(`${out}.tmp`);
  await rename(`${out}.tmp`, out);
  return out;
}

const inflight = new Map<string, Promise<ShareFile>>();

/**
 * Lager (eller gjenbruker) fila som deles. `full` = AAC 256 kbps fra masteren uten loudness-endring,
 * `preview` = eksisterende 30 s preview.m4a, `wav` = masteren som WAV. Rene tags, cover innebygd.
 */
export async function ensureShareFile(o: { versionDir: string; manifest: AssetManifest; kind: ShareKind; logo?: string | null }): Promise<ShareFile> {
  const m = o.manifest;
  const dir = path.join(o.versionDir, 'share');
  const title = m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title;
  const artist = m.artist ?? 'Echo Groove';
  const album = m.album ?? m.title;
  const year = yearOf(m);
  const meta = { v: 1, kind: o.kind, master: m.masterSha256, cover: m.coverSha256 ?? null, title, artist, album, copyright: m.copyright ?? null, year };
  const key = createHash('sha256').update(JSON.stringify(meta)).digest('hex').slice(0, 12);
  const ext = o.kind === 'wav' ? 'wav' : 'm4a';
  const out = path.join(dir, `${o.kind}-${key}.${ext}`);
  const fileName = shareFileName({ artist, title: m.title, variantLabel: m.variantLabel, kind: o.kind });
  const contentType = o.kind === 'wav' ? 'audio/wav' : 'audio/mp4';
  if (existsSync(out)) return { file: out, fileName, contentType, size: (await stat(out)).size };
  const running = inflight.get(out);
  if (running) return running;

  const job = (async (): Promise<ShareFile> => {
    await mkdir(dir, { recursive: true });
    // Gamle filer av samme type (annen master/metadata) ryddes bort
    for (const f of await readdir(dir)) if (f.startsWith(`${o.kind}-`) && f !== path.basename(out)) await rm(path.join(dir, f), { force: true });
    const tags = ['-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album_artist=${artist}`, '-metadata', `album=${album}`, '-metadata', `date=${year}`, '-metadata', 'encoder=Groovehouse Vault', ...(m.copyright ? ['-metadata', `copyright=${m.copyright}`] : [])];
    const tmp = path.join(dir, `.${path.basename(out)}.tmp.${ext}`);

    if (o.kind === 'wav') {
      const master = findMaster(o.versionDir);
      if (!master) throw new ShareError(409, 'Vault har ikke en kopi av masteren for denne versjonen ennå (kjør «pnpm gh-ingest --backfill-masters»).');
      if (master.endsWith('.wav')) await copyFile(master, tmp);
      else {
        const { bits } = await sampleFormat(master);
        await run(FFMPEG, ['-y', '-v', 'error', '-i', master, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', bits > 16 ? 'pcm_s24le' : 'pcm_s16le', ...tags, '-write_bext', '0', tmp]);
      }
    } else {
      const cover = m.files.cover ? path.join(o.versionDir, m.files.cover) : await fallbackCover(dir, m, o.logo ?? null);
      const audioIn = o.kind === 'full' ? findMaster(o.versionDir) : m.files.preview ? path.join(o.versionDir, m.files.preview) : null;
      if (!audioIn) throw new ShareError(409, o.kind === 'full' ? 'Vault har ikke en kopi av masteren for denne versjonen ennå (kjør «pnpm gh-ingest --backfill-masters»).' : 'Fant ikke smakebiten (preview.m4a).');
      const audioCodec = o.kind === 'full' ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'copy'];
      await run(FFMPEG, [
        '-y', '-v', 'error',
        '-i', audioIn,
        '-i', cover,
        '-map', '0:a:0', '-map', '1:v:0',
        ...audioCodec,
        '-c:v', 'mjpeg', '-q:v', '3', '-disposition:v:0', 'attached_pic',
        '-map_metadata', '-1', '-map_chapters', '-1',
        ...tags,
        '-movflags', '+faststart',
        '-f', 'ipod',
        tmp
      ]);
    }
    await rename(tmp, out);
    return { file: out, fileName, contentType, size: (await stat(out)).size };
  })();
  inflight.set(out, job);
  try {
    return await job;
  } finally {
    inflight.delete(out);
  }
}

export class ShareError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** Fyll inn manglende master-kopier fra eksportmappa (kun lesing), via data/sources.json + hash. */
export async function backfillMasters(o: {
  mediaDir: string;
  exportDir: string;
  sources: Record<string, { relPath: string | null; sha256: string }>;
  sha256: (file: string) => Promise<string>;
  onItem?: (key: string, status: 'made' | 'exists' | 'nosource' | 'changed', detail?: string) => void;
}): Promise<{ made: number; missing: number }> {
  const idx = JSON.parse(await readFile(path.join(o.mediaDir, 'index.json'), 'utf8')) as { assets: Array<{ slug: string; variant: string | null; version: number; manifest: string }> };
  let made = 0;
  let missing = 0;
  for (const a of idx.assets) {
    const key = `${a.slug}::${a.variant ?? 'main'}::v${a.version}`;
    const vdir = path.join(o.mediaDir, path.dirname(a.manifest));
    if (findMaster(vdir)) {
      o.onItem?.(key, 'exists');
      continue;
    }
    const m = JSON.parse(await readFile(path.join(o.mediaDir, a.manifest), 'utf8')) as AssetManifest;
    const src = o.sources[key];
    const file = src?.relPath ? path.join(o.exportDir, src.relPath) : null;
    if (!file || !existsSync(file)) {
      missing++;
      o.onItem?.(key, 'nosource');
      continue;
    }
    // Bare hvis fila fortsatt er nøyaktig den som ble ingestet (samme hash som manifestet)
    if ((await o.sha256(file)) !== m.masterSha256) {
      missing++;
      o.onItem?.(key, 'changed', path.basename(file));
      continue;
    }
    await makeMasterCopy(file, vdir);
    made++;
    o.onItem?.(key, 'made', path.basename(file));
  }
  return { made, missing };
}
