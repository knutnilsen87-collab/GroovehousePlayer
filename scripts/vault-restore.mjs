#!/usr/bin/env node
/**
 * pnpm vault:restore [--from <backup>] [--to <prosjekt>] [--dry] [--yes]
 *
 * Henter data/ og media/ (og groovehouse.local.json) tilbake fra en backup laget med `pnpm vault:backup`.
 * Kode og .git hentes fra GitHub, ikke herfra.
 *
 *  - Standard: fra H:\GroovehousePlayer til dette prosjektet.
 *  - --dry viser hva som ville blitt endret, uten å røre noe.
 *  - Mot det levende prosjektet kreves --yes, Vault-serveren må være stoppet, og nåværende data/ og
 *    media/index.json kopieres først til %LOCALAPPDATA%\GroovehouseVault\restore-safety\<tid>\ (kan legges tilbake).
 *  - Etterpå sammenlignes backup og resultat (robocopy /L skal ikke finne forskjeller), og JSON-filene i data/
 *    og media/index.json sjekkes med SHA-256.
 *  - Leser bare fra backupen. Skriver bare i data/, media/ og groovehouse.local.json i målet.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dry = args.includes('--dry');
const yes = args.includes('--yes');
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.resolve(arg('--from') ?? 'H:\\GroovehousePlayer');
const TO = path.resolve(arg('--to') ?? PROJECT);
const DIRS = ['data', 'media'];
const FILES = ['groovehouse.local.json'];

const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);

if (process.platform !== 'win32') fail('vault:restore bruker robocopy og kjører bare på Windows.');
if (!existsSync(FROM)) fail(`Fant ikke backupen: ${FROM} (er backup-disken koblet til?)`);
if (!existsSync(path.join(FROM, 'media')) && !existsSync(path.join(FROM, 'data'))) fail(`${FROM} ser ikke ut som en Vault-backup (mangler data/ og media/).`);
if (FROM.toLowerCase() === TO.toLowerCase()) fail('Backup og mål er samme mappe.');
if (TO.toLowerCase().startsWith(FROM.toLowerCase() + path.sep) || FROM.toLowerCase().startsWith(TO.toLowerCase() + path.sep + 'data')) fail('Målet kan ikke ligge inni backupen (eller omvendt).');

const live = TO.toLowerCase() === PROJECT.toLowerCase();
if (live && !dry) {
  if (!yes) fail('Dette skriver over data/ og media/ i prosjektet. Kjør med --dry først, og så med --yes.');
  if (await serverRunning()) fail('Vault-serveren kjører. Stopp den først (lukk Vault, eller stopp oppgaven «Groovehouse Vault»), så ingenting skrives mens gjenopprettingen pågår.');
}

console.log(`${dry ? 'Prøvekjøring (ingenting endres)' : 'Gjenoppretter'}: ${FROM} → ${TO}`);
if (live && !dry) {
  const safety = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'GroovehouseVault', 'restore-safety', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(path.join(safety, 'media'), { recursive: true });
  if (existsSync(path.join(TO, 'data'))) cpSync(path.join(TO, 'data'), path.join(safety, 'data'), { recursive: true });
  if (existsSync(path.join(TO, 'media', 'index.json'))) copyFileSync(path.join(TO, 'media', 'index.json'), path.join(safety, 'media', 'index.json'));
  ok(`sikkerhetskopi av nåværende data/ og media/index.json: ${safety}`);
}

const t0 = Date.now();
for (const d of DIRS) {
  const src = path.join(FROM, d);
  if (!existsSync(src)) {
    console.log(`  (backupen har ikke ${d}/ – hoppet over)`);
    continue;
  }
  const r = robocopy(src, path.join(TO, d), dry ? ['/L'] : []);
  if (r.code >= 8) fail(`robocopy feilet for ${d}/ (kode ${r.code}).\n${r.errors.slice(0, 10).join('\n')}`);
  console.log(`  ${d}/: ${dry ? 'ville endret' : 'kopiert'} ${r.changed} filer${r.extras ? `, ${dry ? 'ville fjernet' : 'fjernet'} ${r.extras} som ikke finnes i backupen` : ''}`);
}
for (const f of FILES) {
  if (!existsSync(path.join(FROM, f))) continue;
  if (!dry) copyFileSync(path.join(FROM, f), path.join(TO, f));
  console.log(`  ${f}: ${dry ? 'ville blitt' : 'er'} hentet`);
}
if (dry) {
  ok('Prøvekjøring ferdig. Kjør uten --dry (og med --yes mot prosjektet) for å gjenopprette.');
  process.exit(0);
}

// Kontroll: ingen forskjeller igjen, og JSON-filene er byte-like
let diffs = 0;
for (const d of DIRS) {
  if (!existsSync(path.join(FROM, d))) continue;
  const r = robocopy(path.join(FROM, d), path.join(TO, d), ['/L']);
  diffs += r.changed + r.extras;
}
const checked = [];
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const rel of [path.join('media', 'index.json'), ...jsonFiles(path.join(FROM, 'data')).map((p) => path.relative(FROM, p))]) {
  const a = path.join(FROM, rel);
  const b = path.join(TO, rel);
  if (!existsSync(a)) continue;
  if (!existsSync(b) || sha(a) !== sha(b)) fail(`Kontrollen feilet: ${rel} er ikke lik backupen.`);
  checked.push(rel);
}
if (diffs) fail(`Kontrollen feilet: ${diffs} filer skiller seg fortsatt fra backupen.`);
ok(`Gjenopprettet og kontrollert på ${((Date.now() - t0) / 1000).toFixed(1)} s: 0 forskjeller, ${checked.length} JSON-filer like (SHA-256).`);

function robocopy(src, dst, extra) {
  const r = spawnSync('robocopy', [src, dst, '/MIR', '/XJ', '/FFT', '/DCOPY:T', '/R:1', '/W:2', '/MT:8', '/NP', '/NDL', '/NJH', '/NJS', ...extra], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
  const lines = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/);
  return {
    code: r.status ?? 16,
    changed: lines.filter((l) => /^\s*(New File|Newer|Older|Changed)\b/i.test(l)).length,
    extras: lines.filter((l) => /\*EXTRA (File|Dir)/i.test(l)).length,
    errors: lines.filter((l) => /ERROR \d+ \(0x/i.test(l)).map((l) => l.trim())
  };
}

function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonFiles(p));
    else if (e.name.endsWith('.json') && statSync(p).size < 50 * 1024 * 1024) out.push(p);
  }
  return out;
}

/** Svarer Vault på porten? (Samme sjekk som launcheren: /api/health med app-id.) */
function serverRunning() {
  let port = 41733;
  try {
    port = Number(readFileSync(path.join(process.env.LOCALAPPDATA ?? '', 'GroovehouseVault', 'port'), 'utf8').trim()) || port;
  } catch {
    /* standardporten */
  }
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.includes('groovehouse-vault')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => (req.destroy(), resolve(false)));
  });
}
