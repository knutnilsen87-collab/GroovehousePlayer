#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { findRoot, loadConfig } from '@gv/ingest/config';
import { appDataDir, logsDir, portFile } from './paths';
import { credDelete } from './credstore';
import { elevated, FIREWALL_RULE, firewallRuleExists, lanCommand } from './lan-cli';
import { probeHealth } from './server';

/**
 * pnpm vault:install   – bygger web-appen, lager launcher, ikon og snarveier (skrivebord + Startmeny)
 * pnpm vault:uninstall – stopper serveren og fjerner alt igjen (spør om loggene skal beholdes)
 *
 * Utenfor prosjektmappa røres bare (godkjent av Knut):
 *   - skrivebordet:  Groovehouse Vault.lnk
 *   - Startmenyen:   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Groovehouse Vault.lnk
 *   - %LOCALAPPDATA%\GroovehouseVault\  (launcher.vbs, groovehouse.ico, port, logs\, install.json)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = findRoot(here);
const serverDir = path.resolve(here, '..');
const distIndex = path.join(root, 'apps', 'web', 'dist', 'index.html');
const iconSource = path.join(root, 'assets', 'brand', 'Windows', 'Groovehouse_Vault_IconPack.ico');
const SHORTCUT_NAME = 'Groovehouse Vault.lnk';

interface InstallRecord {
  version: 1;
  installedAt: string;
  root: string;
  files: string[];
  shortcuts: string[];
}

const recordPath = () => path.join(appDataDir(), 'install.json');

function ps(script: string, env: Record<string, string> = {}): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.status !== 0) throw new Error(`PowerShell feilet: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function shortcutDirs(): { desktop: string; programs: string } {
  // GetFolderPath følger OneDrive-omdirigering av skrivebordet.
  const out = ps(`[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')`).split(/\r?\n/);
  if (out.length < 2 || !out[0] || !out[1]) throw new Error('Fant ikke skrivebordet eller Startmenyen');
  return { desktop: out[0].trim(), programs: out[1].trim() };
}

function readShortcut(lnk: string): { target: string; args: string } | null {
  if (!existsSync(lnk)) return null;
  const out = ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:GV_LNK); $s.TargetPath; $s.Arguments`, { GV_LNK: lnk }).split(/\r?\n/);
  return { target: out[0] ?? '', args: out[1] ?? '' };
}

function runPnpm(args: string[]) {
  // Kjøres via pnpm, så npm_execpath peker på pnpm sin JS-fil. Ellers: pnpm på PATH.
  const execPath = process.env.npm_execpath;
  const r = execPath && /\.c?js$/.test(execPath)
    ? spawnSync(process.execPath, [execPath, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} feilet (kode ${r.status})`);
}

async function install() {
  const cfg = loadConfig(root);
  console.log('Groovehouse Vault – installasjon\n');

  console.log('1/4 Bygger web-appen (pnpm build)…');
  runPnpm(['--filter', '@gv/web', 'build']);
  if (!existsSync(distIndex)) throw new Error(`Bygget mangler: ${distIndex}`);
  console.log(`    ✓ ${path.dirname(distIndex)}`);

  console.log('2/4 Launcher og ikon i %LOCALAPPDATA%\\GroovehouseVault\\');
  if (!existsSync(iconSource)) throw new Error(`Fant ikke ikonet: ${iconSource}`);
  const dir = appDataDir();
  mkdirSync(logsDir(), { recursive: true });
  const icon = path.join(dir, 'groovehouse.ico');
  copyFileSync(iconSource, icon);
  const launcher = path.join(dir, 'launcher.vbs');
  const vbs = readFileSync(path.join(serverDir, 'launcher', 'launcher.vbs.tmpl'), 'utf8')
    .replace('{{NODE}}', process.execPath)
    .replace('{{SERVER_DIR}}', serverDir)
    .replace('{{DIST_INDEX}}', distIndex)
    .replace('{{PORT_FILE}}', portFile())
    .replace('{{LOG_FILE}}', path.join(logsDir(), 'server.log'))
    .replace('{{PORT}}', String(cfg.ports.server))
    .replace('{{APP_ARGS}}', '')
    .replace(/\r?\n/g, '\r\n');
  if (/\{\{[A-Z_]+\}\}/.test(vbs)) throw new Error('launcher-malen har plassholdere som ikke ble fylt ut');
  // UTF-16 LE med BOM: Windows Script Host leser da æøå i stier og meldinger riktig.
  writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
  console.log(`    ✓ ${launcher}\n    ✓ ${icon}`);

  console.log('3/4 Snarveier');
  const { desktop, programs } = shortcutDirs();
  const shortcuts = [path.join(desktop, SHORTCUT_NAME), path.join(programs, SHORTCUT_NAME)];
  for (const lnk of shortcuts) {
    const existing = readShortcut(lnk);
    if (existing && !existing.args.toLowerCase().includes(launcher.toLowerCase())) {
      throw new Error(`Det finnes allerede en annen snarvei med samme navn: ${lnk} – lar den være. Gi den nytt navn og prøv igjen.`);
    }
    ps(
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:GV_LNK); ` +
        `$s.TargetPath=Join-Path $env:SystemRoot 'System32\\wscript.exe'; ` +
        `$s.Arguments='//nologo "' + $env:GV_VBS + '"'; ` +
        `$s.WorkingDirectory=$env:GV_DIR; $s.IconLocation=$env:GV_ICO + ',0'; ` +
        `$s.Description='Groovehouse Vault – din spiller og ditt arkiv'; $s.WindowStyle=1; $s.Save()`,
      { GV_LNK: lnk, GV_VBS: launcher, GV_DIR: dir, GV_ICO: icon }
    );
    console.log(`    ✓ ${lnk}`);
  }

  console.log('4/4 Registrerer installasjonen');
  const record: InstallRecord = { version: 1, installedAt: new Date().toISOString(), root, files: [launcher, icon], shortcuts };
  writeFileSync(recordPath(), JSON.stringify(record, null, 2));
  console.log(`    ✓ ${recordPath()}`);
  console.log('\nFerdig. Dobbeltklikk «Groovehouse Vault» på skrivebordet, eller fest den fra Startmenyen til oppgavelinja.');
  console.log('Fjern alt igjen med: pnpm vault:uninstall');
}

async function uninstall(args: string[]) {
  console.log('Groovehouse Vault – avinstallasjon\n');
  const dir = appDataDir();
  const record: InstallRecord | null = existsSync(recordPath()) ? JSON.parse(readFileSync(recordPath(), 'utf8')) : null;
  const cfg = loadConfig(root);

  // 1. Stopp serveren hvis den kjører (bare hvis /api/health sier at det er vår).
  const ports = new Set<number>([cfg.ports.server]);
  try {
    ports.add(Number(readFileSync(portFile(), 'utf8').trim()));
  } catch {
    /* ingen port-fil */
  }
  for (const p of ports) {
    if (!Number.isFinite(p) || p <= 0) continue;
    const h = await probeHealth(p, 800);
    if (h.state === 'ours' && h.pid > 0) {
      try {
        process.kill(h.pid);
        console.log(`✓ Stoppet serveren på port ${p} (pid ${h.pid})`);
      } catch (err) {
        console.log(`! Klarte ikke å stoppe pid ${h.pid}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // 2. Snarveier – bare de som peker på vår launcher.
  const launcher = path.join(dir, 'launcher.vbs');
  let candidates = record?.shortcuts ?? [];
  if (candidates.length === 0) {
    const { desktop, programs } = shortcutDirs();
    candidates = [path.join(desktop, SHORTCUT_NAME), path.join(programs, SHORTCUT_NAME)];
  }
  for (const lnk of candidates) {
    const s = readShortcut(lnk);
    if (!s) continue;
    if (!s.args.toLowerCase().includes(launcher.toLowerCase())) {
      console.log(`! ${lnk} peker ikke på Groovehouse Vault-launcheren – lar den være`);
      continue;
    }
    rmSync(lnk, { force: true });
    console.log(`✓ Fjernet ${lnk}`);
  }

  // 3. Loggene: spør først.
  const logs = logsDir();
  const hasLogs = existsSync(logs) && readdirSync(logs).length > 0;
  let keepLogs = true;
  if (args.includes('--delete-logs')) keepLogs = false;
  else if (args.includes('--keep-logs')) keepLogs = true;
  else if (hasLogs && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(`Beholde loggene i ${logs}? (J/n) `);
    rl.close();
    keepLogs = !/^(n|nei|no)$/i.test(a.trim());
  } else if (hasLogs) {
    console.log('! Ikke interaktivt: beholder loggene (bruk --delete-logs for å slette dem)');
  }

  // 4. %LOCALAPPDATA%\GroovehouseVault\
  if (existsSync(dir)) {
    if (keepLogs && hasLogs) {
      for (const f of readdirSync(dir)) if (f !== 'logs') rmSync(path.join(dir, f), { recursive: true, force: true });
      console.log(`✓ Fjernet ${dir} (loggene er beholdt i ${logs})`);
    } else {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      console.log(`✓ Fjernet ${dir}`);
    }
  }
  // 5. LAN: PIN-hash og nøkkel i Credential Manager, og ev. brannmurregel.
  const hadPin = credDelete('lan-pin');
  const hadSecret = credDelete('lan-secret');
  if (hadPin || hadSecret) console.log('✓ Fjernet LAN-PIN fra Credential Manager');
  if (firewallRuleExists()) {
    let remove = args.includes('--remove-firewall');
    if (!remove && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      remove = /^(j|ja|y|yes)$/i.test((await rl.question(`Fjerne brannmurregelen «${FIREWALL_RULE}»? Windows ber om administratortilgang. (j/N) `)).trim());
      rl.close();
    }
    if (remove) elevated(`Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}'`);
    console.log(firewallRuleExists() ? `! Brannmurregelen «${FIREWALL_RULE}» finnes fortsatt (fjern med «pnpm vault:lan off» eller i Windows-brannmuren)` : '✓ Brannmurregelen er fjernet');
  }
  console.log('\nFerdig. Prosjektmappa, media/ og eksportmappa er ikke rørt.');
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === 'install'
  ? install()
  : cmd === 'uninstall'
    ? uninstall(rest)
    : cmd === 'lan'
      ? lanCommand(root, serverDir, rest)
      : Promise.reject(new Error('Bruk: vault install | vault uninstall [--keep-logs|--delete-logs] | vault lan on|off|pin|status'))
).catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
