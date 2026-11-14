import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { AppReleaseManifest } from '@gv/shared';

/**
 * Del 15: oppdateringer til Android-appen, fra data/app/ (lages av `pnpm android:release` og web-bygget).
 *   GET /api/app/bundle            → { version, sha256, size, minNative } | 404
 *   GET /api/app/bundle/<v>.zip    → zip-fila
 *   GET /api/app/apk/latest        → { versionCode, versionName, sha256, size, notes } | 404
 *   GET /api/app/apk/<fil>.apk     → APK-en
 * Bare for paret app (gyldig enhetstoken), aldri fra /drop/ (sjekkes av kalleren).
 */
export function readAppManifest(dataDir: string): AppReleaseManifest {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, 'app', 'manifest.json'), 'utf8')) as AppReleaseManifest;
  } catch {
    return { schema: 1, bundle: null, apk: null };
  }
}

export function appUpdateRoute(dataDir: string) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const file = (res: ServerResponse, abs: string, type: string) => {
    if (!existsSync(abs)) return json(res, 404, { error: 'finnes ikke' });
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(statSync(abs).size));
    res.setHeader('Cache-Control', 'private, no-store');
    createReadStream(abs).pipe(res);
  };
  return function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    const m = readAppManifest(dataDir);
    if (url.pathname === '/api/app/bundle') {
      if (!m.bundle) return json(res, 404, { error: 'ingen bunt publisert' });
      const { version, sha256, size, minNative } = m.bundle;
      return json(res, 200, { version, sha256, size, minNative });
    }
    if (url.pathname === '/api/app/apk/latest') {
      if (!m.apk) return json(res, 404, { error: 'ingen APK publisert' });
      const { versionCode, versionName, sha256, size, notes } = m.apk;
      return json(res, 200, { versionCode, versionName, sha256, size, notes });
    }
    const b = url.pathname.match(/^\/api\/app\/bundle\/(\d{8,20})\.zip$/);
    if (b) return file(res, path.join(dataDir, 'app', 'bundle', `${b[1]}.zip`), 'application/zip');
    const a = url.pathname.match(/^\/api\/app\/apk\/(groovehouse-vault-\d{1,9}\.apk)$/);
    if (a) return file(res, path.join(dataDir, 'app', 'apk', a[1]!), 'application/vnd.android.package-archive');
    return json(res, 404, { error: 'not found' });
  };
}
