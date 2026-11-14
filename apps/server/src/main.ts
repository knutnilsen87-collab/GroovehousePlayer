import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, loadConfig, loadDotEnv } from '@gv/ingest/config';
import { startWatcher } from '@gv/ingest/watcher';
import { credRead } from './credstore';
import type { PinRecord } from './lan-auth';
import { lanAddresses } from './lan';
import { createDeviceStore } from './devices';
import { createLogger } from './logger';
import { notify, readyMessage } from './notify';
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
  let port = config.ports.server;

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
      // Del 1 pkt. 8: Windows-varsel når en ny bounce er klar
      onIngested: (res) => {
        const msg = readyMessage(res.manifest);
        notify(msg.title, msg.body, log);
      }
    });
  };

  let restarting = false;
  const settings: SettingsHooks = {
    root,
    mediaDir,
    port: () => port,
    watcherStatus: () => watcher?.status() ?? null,
    restartWatcher: async () => {
      await watcher?.close().catch(() => {});
      watcher = startWatch();
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

  watcher = startWatch();

  const stop = async (sig: string) => {
    log(`Stopper (${sig})`);
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
