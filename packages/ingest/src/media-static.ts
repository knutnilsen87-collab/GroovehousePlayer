import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

/**
 * Serverer media/ under URL-prefikset /media/ (Vite-dev og apps/server bruker samme kode).
 * Riktige MIME-typer for HLS (ellers tolker Vite .ts som TypeScript, og Safari avviser segmentene),
 * Range-forespørsler for spoling, og ingen mappelister. Stier utenfor media/ avvises.
 */
export const MEDIA_PREFIX = '/media/';

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4a': 'audio/mp4',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

export function createMediaHandler(mediaDir: string) {
  const root = path.resolve(mediaDir);
  return async function handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(MEDIA_PREFIX)) return next ? next() : notFound(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return void res.end();
    }
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice(MEDIA_PREFIX.length));
    } catch {
      return notFound(res);
    }
    const file = path.resolve(root, rel);
    const type = TYPES[path.extname(file).toLowerCase()];
    // Ingen traversering ut av media/, ingen skjulte filer eller arbeidsmapper, bare kjente filtyper.
    // share/ (delte filer, del 10) serveres bare via /api/share – aldri som vanlig media.
    if (!type || (file !== root && !file.startsWith(root + path.sep)) || /[\\/](\.|[^\\/]*\.(partial|old)[\\/])/.test(file.slice(root.length)) || /[\\/]share[\\/]/.test(file.slice(root.length)) || !existsSync(file)) {
      return notFound(res);
    }
    const st = await stat(file);
    if (!st.isFile()) return notFound(res);

    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Katalog, manifest og spillelister endres ved ny ingest; segmenter og bilder for en versjon gjør ikke det.
    res.setHeader('Cache-Control', /\.(json|m3u8)$/i.test(file) ? 'no-cache' : 'private, max-age=3600');
    res.setHeader('Last-Modified', st.mtime.toUTCString());

    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = st.size - 1;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      } else {
        start = Math.max(0, st.size - Number(range[2]));
      }
      if (start > end || start >= st.size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${st.size}`);
        return void res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  };
}

function notFound(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}
