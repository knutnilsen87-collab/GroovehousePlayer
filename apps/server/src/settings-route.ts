import { readAppManifest } from './app-update';
import { cloudSyncWarning, detectCloudSync } from './cloudsync';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { DEFAULTS, loadConfig, setLanEnabled } from '@gv/ingest/config';
import { checkFolder } from '@gv/ingest/folder-check';
import { countAudioFiles, editableOf, previewExport, recolorAll, saveSettings, type SettingsPatch } from '@gv/ingest/settings';
import type { WatcherStatus } from '@gv/ingest/watcher';
import { credRead, credWrite } from './credstore';
import { hashPin, newSecret, PIN_RE } from './lan-auth';
import { qrSvg } from './lan';
import { remoteStatus } from './remote-cli';

/**
 * Del 8: /api/settings for Studio → Innstillinger.
 * - Lytterlenker (/drop/…) har aldri tilgang (sjekkes av kalleren og her).
 * - Lesing og vanlige innstillinger: PC-en og Knuts egne enheter (Tailscale, Wi-Fi med PIN, app med enhetstoken).
 * - Wi-Fi-modus og PIN: bare fra PC-en selv, så en mobil ikke kan låse seg selv (eller andre) ute.
 * - Ingen PIN, hasher eller tokens sendes ut herfra.
 */
export interface SettingsHooks {
  root: string;
  mediaDir: string;
  port: () => number;
  watcherStatus: () => WatcherStatus | null;
  /** Del 27: watcherne for umastrede låter (mappe + status). */
  draftWatcherStatus?: () => WatcherStatus[];
  /** catchUp: ta også med filer som ikke er importert ennå (som ved oppstart). */
  restartWatcher: (o?: { catchUp?: boolean }) => Promise<WatcherStatus | null>;
  /** Stopper og starter serverprosessen på nytt (samme port hvis ledig). */
  restartServer: () => void;
  /** Testkrok for brannmurregel-sjekken (PowerShell). */
  firewallRule?: () => boolean;
}

const MANY_FILES = 20;

export function createSettingsRoute(h: SettingsHooks) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };

  return async function settingsRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: { fromPc: boolean; fromDrop: boolean }) {
    if (ctx.fromDrop) return json(res, 403, { error: 'ingen tilgang' });
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // Spilleren henter LUFS-målet ved oppstart (alle egne klienter)
    if (p === '/api/settings/playback' && method === 'GET') {
      const c = loadConfig(h.root);
      return json(res, 200, { targetLufs: c.audio.targetLufs, minContrast: c.colors.minContrast });
    }

    if (p === '/api/settings' && method === 'GET') {
      const cfg = loadConfig(h.root);
      const remote = safe(() => remoteStatus(), { running: false, host: null, serve: false, funnel: false });
      const remoteUrl = remote.serve && remote.host ? `https://${remote.host}/` : null;
      return json(res, 200, {
        settings: editableOf(cfg),
        defaults: editableOf(DEFAULTS as typeof cfg),
        exportDirFromEnv: !!process.env.GH_EXPORT_DIR,
        watcher: h.watcherStatus(),
        server: { port: h.port(), pid: process.pid, hls: 'AAC 256 kbps · 6 s segmenter' },
        lan: { enabled: cfg.lan.enabled, pinSet: !!safe(() => credRead('lan-pin'), null), firewallRule: h.firewallRule ? safe(h.firewallRule, false) : null },
        remote: { ...remote, url: remoteUrl, qr: remoteUrl ? await qrSvg(remoteUrl) : null },
        canChangeAccess: ctx.fromPc,
        cloudSync: (() => {
          const s = detectCloudSync(h.root);
          return s ? { provider: s.provider, syncRoot: s.syncRoot, warning: cloudSyncWarning(s, h.root) } : null;
        })(),
        // Del 15: nyeste app-versjoner som er publisert (pnpm android:release)
        app: (() => {
          const m = readAppManifest(path.join(h.root, 'data'));
          return {
            bundle: m.bundle ? { version: m.bundle.version, minNative: m.bundle.minNative, builtAt: m.bundle.builtAt } : null,
            apk: m.apk ? { versionCode: m.apk.versionCode, versionName: m.apk.versionName, builtAt: m.apk.builtAt } : null
          };
        })()
      });
    }

    // Del 27: importstatus for tomt bibliotek, «Ser etter låter …» og «Mappe utilgjengelig» med årsak og løsning
    if (p === '/api/settings/import' && method === 'GET') {
      const cfg = loadConfig(h.root);
      const exportDir = cfg.exportDir ? path.resolve(h.root, cfg.exportDir) : null;
      const watcher = h.watcherStatus();
      const drafts = h.draftWatcherStatus?.() ?? [];
      const inbox = path.join(h.root, 'data', 'drafts-inbox');
      return json(res, 200, {
        export: { ...checkFolder(exportDir), watcher },
        drafts: cfg.draftDirs.map((d) => {
          const abs = path.resolve(h.root, d);
          return { ...checkFolder(abs), watcher: drafts.find((w) => path.resolve(w.exportDir) === abs) ?? null };
        }),
        inbox: drafts.find((w) => path.resolve(w.exportDir) === inbox) ?? null
      });
    }

    if (method !== 'GET' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'krever application/json' });
    let body: Record<string, unknown> = {};
    if (method !== 'GET') {
      try {
        body = JSON.parse((await readBody(req, 64 * 1024)) || '{}') as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: 'ugyldig JSON' });
      }
    }

    if (p === '/api/settings' && (method === 'PUT' || method === 'POST')) {
      const before = loadConfig(h.root);
      const patch = pickPatch(body);
      try {
        const cfg = saveSettings(h.root, patch);
        let watcher = h.watcherStatus();
        const exportChanged = (patch.exportDir !== undefined && (before.exportDir ?? null) !== (cfg.exportDir ?? null)) || (patch.draftDir !== undefined && (before.draftDir ?? null) !== (cfg.draftDir ?? null));
        // Eksportmappe/regler/sett-grense: watcheren må lese config på nytt
        if (exportChanged || patch.ingest || patch.titleCleanup || patch.defaults || patch.audio || patch.colors) watcher = await h.restartWatcher();
        return json(res, 200, { settings: editableOf(cfg), watcher, restarted: exportChanged ? ['watcher'] : [] });
      } catch (err) {
        const errors = (err as { errors?: string[] }).errors ?? [err instanceof Error ? err.message : String(err)];
        return json(res, 400, { error: errors.join(' · '), errors });
      }
    }

    if (p === '/api/settings/check-dir' && method === 'POST') {
      const dir = typeof body.dir === 'string' ? body.dir.trim() : '';
      if (!dir || !path.isAbsolute(dir)) return json(res, 200, { ok: false, error: 'Skriv en full sti, f.eks. D:\\Musikk\\REASONDONE' });
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return json(res, 200, { ok: false, error: 'Mappa finnes ikke' });
      try {
        accessSync(dir, constants.R_OK);
      } catch {
        return json(res, 200, { ok: false, error: 'Mappa kan ikke leses' });
      }
      const audioFiles = countAudioFiles(dir);
      return json(res, 200, { ok: true, audioFiles, many: audioFiles >= MANY_FILES });
    }

    if (p === '/api/settings/preview' && method === 'POST') {
      const cfg = loadConfig(h.root);
      const patch = pickPatch(body);
      const dir = (typeof patch.exportDir === 'string' && patch.exportDir) || cfg.exportDir;
      if (!dir) return json(res, 200, { rows: [], total: 0, copyright: null });
      return json(res, 200, previewExport(path.resolve(h.root, dir), patch, cfg));
    }

    if (p === '/api/settings/recolor' && method === 'POST') return json(res, 200, await recolorAll(h.mediaDir, loadConfig(h.root)));

    if (p === '/api/settings/watcher/restart' && method === 'POST') return json(res, 200, { watcher: await h.restartWatcher({ catchUp: body.catchUp === true }) });

    if (p === '/api/settings/server/restart' && method === 'POST') {
      json(res, 202, { ok: true });
      h.restartServer();
      return;
    }

    // Tilgang: bare fra PC-en
    if (p === '/api/settings/lan' && method === 'POST') {
      if (!ctx.fromPc) return json(res, 403, { error: 'Wi-Fi-modus kan bare endres fra PC-en' });
      const on = body.enabled === true;
      if (on && !credRead('lan-pin')) return json(res, 409, { error: 'Velg en PIN først', needPin: true });
      if (on && !credRead('lan-secret')) credWrite('lan-secret', newSecret());
      if (!on) credWrite('lan-secret', newSecret()); // logger ut alle mobiler
      setLanEnabled(h.root, on);
      json(res, 200, { ok: true, enabled: on, restarting: true });
      h.restartServer();
      return;
    }
    if (p === '/api/settings/lan/pin' && method === 'POST') {
      if (!ctx.fromPc) return json(res, 403, { error: 'PIN kan bare byttes fra PC-en' });
      const pin = typeof body.pin === 'string' ? body.pin : '';
      if (!PIN_RE.test(pin)) return json(res, 400, { error: 'PIN må være 6–12 sifre' });
      if (body.repeat !== pin) return json(res, 400, { error: 'PIN-ene er ikke like' });
      credWrite('lan-pin', JSON.stringify(hashPin(pin)));
      credWrite('lan-secret', newSecret());
      const restarting = loadConfig(h.root).lan.enabled;
      json(res, 200, { ok: true, restarting });
      if (restarting) h.restartServer();
      return;
    }

    return json(res, 404, { error: 'not found' });
  };
}

function pickPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const k of ['audio', 'ingest', 'lyrics', 'covers', 'colors', 'drops', 'defaults', 'titleCleanup'] as const) {
    const v = body[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) (patch as Record<string, unknown>)[k] = v;
  }
  if (body.exportDir === null || typeof body.exportDir === 'string') patch.exportDir = body.exportDir as string | null;
  if (body.draftDir === null || typeof body.draftDir === 'string') patch.draftDir = body.draftDir as string | null;
  if (Array.isArray(body.draftDirs) && body.draftDirs.length <= 20 && body.draftDirs.every((d) => typeof d === 'string')) patch.draftDirs = body.draftDirs as string[];
  return patch;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('for stor'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
