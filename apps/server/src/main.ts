import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, loadConfig, loadDotEnv } from '@gv/ingest/config';
import { startWatcher } from '@gv/ingest/watcher';
import { sharedLyricsQueue } from '@gv/ingest/lyrics-queue';
import { receiveFromBulkImg, takeOverdueWarnings } from '@gv/ingest/bulkimg';
import { createFingerprintStore, createHashCache, createSkippedStore } from '@gv/ingest/incoming';
import { credRead } from './credstore';
import type { PinRecord } from './lan-auth';
import { lanAddresses } from './lan';
import { createDeviceStore } from './devices';
import { createLogger } from './logger';
import { loadSeenIds, pollAccessRequests, saveSeenIds } from './listen-poll';
import { notify, readyMessage } from './notify';
import { cloudSyncWarning, detectCloudSync } from './cloudsync';
import type { SettingsHooks } from './settings-route';
import { firewallRuleExists } from './lan-cli';
import { spawn } from 'node:child_process';
import { appDataDir, logsDir, portFile } from './paths';
import { candidatePorts, createHandler, listenWithFallback, readVersion, type LanOptions } from './server';

/**
 * Groovehouse Vault-serveren: web-app + /media + /api på 127.0.0.1, og watcheren i samme prosess.
 * Startes usynlig av launcheren (snarveien) eller med `pnpm vault:server` i forgrunnen.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = findRoot(here);
loadDotEnv(root);
const config = loadConfig(root);
const version = readVersion(root);
const mediaDir = path.resolve(root, process.env.GH_MEDIA_DIR ?? 'media');
const distDir = path.join(root, 'apps', 'web', 'dist');
const exportDirOf = () => {
  const d = loadConfig(root).exportDir;
  return d ? path.resolve(root, d) : null;
};

mkdirSync(appDataDir(), { recursive: true });
const log = createLogger(logsDir(), { echo: process.stdout.isTTY === true });
console.log = (...a: unknown[]) => log(a.map(String).join(' '));
console.error = (...a: unknown[]) => log(a.map(String).join(' '));
process.on('uncaughtException', (err) => log(`✗ uventet feil: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => log(`✗ uventet feil: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));

async function main() {
  log(`Groovehouse Vault ${version} starter (pid ${process.pid})`);
  const lan = loadLan();
  const devices = createDeviceStore(path.join(root, 'data', 'devices.json'));
  const pairPin = (): PinRecord | null => {
    try {
      const p = credRead('lan-pin');
      return p ? (JSON.parse(p) as PinRecord) : null;
    } catch {
      return null;
    }
  };
  let watcher: ReturnType<typeof startWatcher> | null = null;
  // Tekst etter ingest: bakgrunnskø (Demucs + WhisperX), stopper aldri ingest. Av/på i Innstillinger → Tekst.
  const lyricsQueue = sharedLyricsQueue({ mediaDir, dataDir: path.join(root, 'data'), root, log });
  // Del 23 nivå 2: AI-cover fra bulkIMG. Eksportmappa leses hvert minutt (bare det Vault har sendt tas imot),
  // og et Windows-varsel vises hvis noe er sendt og ingenting er kommet tilbake etter 24 timer.
  const dataDir = path.join(root, 'data');
  let coverBusy = false;
  const checkCovers = async () => {
    if (coverBusy) return;
    coverBusy = true;
    try {
      const cfg = loadConfig(root);
      const got = await receiveFromBulkImg({ cfg, mediaDir, dataDir, log });
      if (got.length) notify('AI-cover mottatt', `${got.length} nytt cover fra bulkIMG`, log);
      const late = await takeOverdueWarnings(cfg, dataDir);
      if (late.length) notify('Venter på bulkIMG', `${late.length} cover sendt for over 24 timer siden er ikke kommet tilbake (${late.slice(0, 3).join(', ')}${late.length > 3 ? ' …' : ''})`, log);
    } catch (err) {
      log(`! AI-cover: ${err instanceof Error ? err.message : err}`);
    } finally {
      coverBusy = false;
    }
  };
  setTimeout(() => void checkCovers(), 5000);
  setInterval(() => void checkCovers(), 60_000).unref();
  const queueLyrics = (res: { manifest: { slug: string; title: string } }, sourceFile: string | null) =>
    lyricsQueue.enqueue(res.manifest.slug, { title: res.manifest.title, audioFile: sourceFile });
  let port = config.ports.server;
  // Sanger som finnes fra før importeres ikke på nytt (samme lyd → stille, samme låt → «Hoppet over» i Studio)
  const incoming = {
    ctx: { mediaDir, dataDir, hashes: createHashCache(dataDir), fingerprints: createFingerprintStore(dataDir) },
    skipped: createSkippedStore(dataDir),
    onListed: (it: { fileName: string; matchTitle: string }) => notify('Hoppet over – finnes allerede', `${it.fileName} ligner «${it.matchTitle}». Velg i Studio.`, log)
  };

  // Watcheren leser config ved start; startes på nytt når innstillingene endres (del 8).
  const startWatch = () => {
    const exportDir = exportDirOf();
    if (!exportDir || !existsSync(exportDir)) {
      log(`! Watcher er av: eksportmappa ${exportDir ? `finnes ikke (${exportDir})` : 'er ikke valgt (Studio → Innstillinger eller GH_EXPORT_DIR i .env)'}`);
      return null;
    }
    log(`Watcher: ${exportDir} (leser bare)`);
    return startWatcher({
      exportDir,
      mediaDir,
      config: loadConfig(root),
      log,
      incoming,
      // Del 1 pkt. 8: Windows-varsel når en ny bounce er klar
      onIngested: (res, sourceFile) => {
        const msg = readyMessage(res.manifest);
        notify(msg.title, msg.body, log);
        queueLyrics(res, sourceFile);
      }
    });
  };

  // Del 16: utkast – utkastmappa (hvis valgt) og innboksen for «Importer som utkast» i Studio
  let draftWatchers: Array<ReturnType<typeof startWatcher>> = [];
  const startDraftWatch = () => {
    const dirs: string[] = [];
    // Alle mappene for umastrede låter (draftDirs; gamle draftDir virker fortsatt)
    for (const d of loadConfig(root).draftDirs) {
      const draftDir = path.resolve(root, d);
      if (existsSync(draftDir)) dirs.push(draftDir);
      else log(`! Mappa for umastrede låter finnes ikke: ${draftDir}`);
    }
    const inbox = path.join(root, 'data', 'drafts-inbox');
    mkdirSync(inbox, { recursive: true });
    dirs.push(inbox);
    return dirs.map((dir) => {
      log(`Watcher for umastrede låter: ${dir} (leser bare)`);
      return startWatcher({ exportDir: dir, mediaDir, config: loadConfig(root), log, status: 'draft', onIngested: queueLyrics, incoming });
    });
  };

  let restarting = false;
  const settings: SettingsHooks = {
    root,
    mediaDir,
    port: () => port,
    watcherStatus: () => watcher?.status() ?? null,
    draftWatcherStatus: () => draftWatchers.map((w) => w.status()),
    restartWatcher: async (o) => {
      await watcher?.close().catch(() => {});
      for (const w of draftWatchers) await w.close().catch(() => {});
      watcher = startWatch();
      draftWatchers = startDraftWatch();
      // Del 27: «Prøv igjen» etter at disken er koblet til – ta med det som kom mens mappa var borte
      if (o?.catchUp) for (const w of [watcher, ...draftWatchers]) if (w) void w.catchUp().catch(() => 0);
      return watcher?.status() ?? null;
    },
    firewallRule: firewallRuleExists,
    restartServer: () => {
      if (restarting) return;
      restarting = true;
      log('Omstart bedt om fra Studio');
      setTimeout(async () => {
        server.close();
        server.closeAllConnections();
        await watcher?.close().catch(() => {});
        for (const w of draftWatchers) await w.close().catch(() => {});
        rmSync(portFile(), { force: true });
        spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
        process.exit(0);
      }, 300);
    }
  };

  const handler = createHandler({ distDir, mediaDir, version, log, lan, allowedHosts: config.allowedHosts, devices, pairPin, settings });
  const server = http.createServer(handler);
  // LAN av: kun 127.0.0.1. LAN på: alle adaptere, men bare private klienter med PIN slipper inn
  // (og brannmurregelen gjelder bare private nettverk).
  const result = await listenWithFallback(server, candidatePorts(config.ports.server, config.ports.dev), lan ? '0.0.0.0' : '127.0.0.1');

  if (result.kind === 'already-running') {
    log(`Kjører allerede på 127.0.0.1:${result.port} (pid ${result.pid}) – starter ikke en ny instans.`);
    writeFileSync(portFile(), String(result.port));
    process.exit(0);
  }
  if (result.kind === 'failed') {
    log(`✗ Fant ingen ledig port: ${result.skipped.map((s) => `${s.port} ${s.reason}`).join('; ')}`);
    process.exit(2);
  }
  for (const s of result.skipped) log(`! port ${s.port} ${s.reason} – prøver neste`);
  handler.setPort(result.port);
  port = result.port;
  writeFileSync(portFile(), String(result.port));
  log(`Lytter på http://127.0.0.1:${result.port}/ · media ${mediaDir} · web ${existsSync(path.join(distDir, 'index.html')) ? distDir : 'IKKE BYGGET'}`);
  if (config.allowedHosts.length) log(`Fjerntilgang (Tailscale Serve, uten PIN): ${config.allowedHosts.map((h) => `https://${h}/`).join(' ')}`);
  if (lan) log(`LAN-modus PÅ (PIN kreves): ${lanAddresses().map((ip) => `http://${ip}:${result.port}/`).join(' ') || 'fant ingen privat IP-adresse'}`);

  // Synkronisert skymappe? Da havner musikken og hemmelighetene i skyen – si fra tydelig.
  const sync = detectCloudSync(root);
  if (sync) {
    for (const line of cloudSyncWarning(sync, root).split('\n')) log(line);
    notify('Groovehouse Vault', `Prosjektmappa synkroniseres av ${sync.provider}. Ta media, data, .env og node_modules ut av synkroniseringen.`, log);
  }

  watcher = startWatch();
  draftWatchers = startDraftWatch();
  // Ved oppstart: ta med filer i REASONDONE og mappene for umastrede låter som ikke er importert ennå
  // (etter en pause eller når PC-en har vært av). Duplikatsjekken hopper over alt som finnes fra før.
  setTimeout(async () => {
    for (const w of [watcher, ...draftWatchers]) {
      if (!w) continue;
      const n = await w.catchUp().catch((err) => (log(`! Innhenting feilet: ${err instanceof Error ? err.message : err}`), 0));
      if (n) log(`Innhenting: ${n} lydfiler i ${w.status().exportDir} sjekkes mot det som finnes`);
    }
  }, 3000);
  const stopListenPoll = startListenPoll();

  const stop = async (sig: string) => {
    log(`Stopper (${sig})`);
    stopListenPoll();
    server.close();
    await watcher?.close().catch(() => {});
    try {
      if (readFileSync(portFile(), 'utf8').trim() === String(result.port)) rmSync(portFile(), { force: true });
    } catch {
      /* ingen port-fil */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGBREAK', () => void stop('SIGBREAK'));
}

/** Del 13: spør om åpne tilgangsforespørsler hvert minutt. Uten LISTEN_ADMIN_URL skjer ingenting. */
function startListenPoll(): () => void {
  const base = process.env.LISTEN_ADMIN_URL?.replace(/\/$/, '');
  if (!base) return () => {};
  let token = process.env.LISTEN_ADMIN_TOKEN ?? '';
  if (!token) {
    try {
      token = credRead('listen-admin') ?? '';
    } catch (err) {
      log(`! Lytter-token i Credential Manager: ${err instanceof Error ? err.message : String(err)}`);
      return () => {};
    }
  }
  if (!token) {
    log('! LISTEN_ADMIN_URL er satt, men token mangler (miljø eller Credential Manager «listen-admin»).');
    return () => {};
  }
  const file = path.join(appDataDir(), 'listen-access-seen.json');
  const seen = loadSeenIds(file);
  const tick = () => {
    void pollAccessRequests({
      baseUrl: base,
      token,
      seen,
      notify: (title, body) => notify(title, body, log)
    })
      .then((n) => {
        if (n) saveSeenIds(file, seen);
      })
      .catch((err) => log(`! lytteforespørsler: ${err instanceof Error ? err.message : String(err)}`));
  };
  const timer = setInterval(tick, 60_000);
  tick();
  return () => clearInterval(timer);
}

/** LAN-oppsettet: på i config + PIN-hash og nøkkel i Credential Manager. Mangler noe, kun lokalt. */
function loadLan(): LanOptions | null {
  if (!config.lan.enabled) return null;
  try {
    const pin = credRead('lan-pin');
    const secret = credRead('lan-secret');
    if (!pin || !secret) {
      log('! LAN-modus er på i config, men PIN mangler i Credential Manager – kjør «pnpm vault:lan on». Kjører bare lokalt.');
      return null;
    }
    return { pin: JSON.parse(pin) as PinRecord, secret, ttlDays: config.lan.rememberDays };
  } catch (err) {
    log(`! Klarte ikke å lese LAN-PIN: ${err instanceof Error ? err.message : String(err)} – kjører bare lokalt.`);
    return null;
  }
}

void main();
