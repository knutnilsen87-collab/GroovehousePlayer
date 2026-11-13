import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRoot, loadConfig, loadDotEnv } from '@gv/ingest/config';
import { startWatcher } from '@gv/ingest/watcher';
import { credRead } from './credstore';
import type { PinRecord } from './lan-auth';
import { lanAddresses } from './lan';
import { createLogger } from './logger';
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
const exportDir = process.env.GH_EXPORT_DIR ? path.resolve(root, process.env.GH_EXPORT_DIR) : null;

mkdirSync(appDataDir(), { recursive: true });
const log = createLogger(logsDir(), { echo: process.stdout.isTTY === true });
console.log = (...a: unknown[]) => log(a.map(String).join(' '));
console.error = (...a: unknown[]) => log(a.map(String).join(' '));
process.on('uncaughtException', (err) => log(`✗ uventet feil: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => log(`✗ uventet feil: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));

async function main() {
  log(`Groovehouse Vault ${version} starter (pid ${process.pid})`);
  const lan = loadLan();
  const handler = createHandler({ distDir, mediaDir, version, log, lan });
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
  writeFileSync(portFile(), String(result.port));
  log(`Lytter på http://127.0.0.1:${result.port}/ · media ${mediaDir} · web ${existsSync(path.join(distDir, 'index.html')) ? distDir : 'IKKE BYGGET'}`);
  if (lan) log(`LAN-modus PÅ (PIN kreves): ${lanAddresses().map((ip) => `http://${ip}:${result.port}/`).join(' ') || 'fant ingen privat IP-adresse'}`);

  let watcher: ReturnType<typeof startWatcher> | null = null;
  if (exportDir && existsSync(exportDir)) {
    log(`Watcher: ${exportDir} (leser bare)`);
    watcher = startWatcher({ exportDir, mediaDir, config, log });
  } else {
    log(`! Watcher er av: GH_EXPORT_DIR ${exportDir ? `finnes ikke (${exportDir})` : 'er ikke satt i .env'}`);
  }

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
