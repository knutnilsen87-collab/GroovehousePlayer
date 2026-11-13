import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, setLanEnabled } from '@gv/ingest/config';
import { credDelete, credRead, credWrite } from './credstore';
import { hashPin, newSecret, PIN_RE } from './lan-auth';
import { lanAddresses, networkCategories } from './lan';
import { portFile } from './paths';
import { probeHealth } from './server';

/**
 * pnpm vault:lan on      – slår på LAN-modus (ber om PIN første gang), spør om brannmurregel (kun private nettverk)
 * pnpm vault:lan off     – slår av, logger ut alle mobiler, spør om brannmurregelen skal fjernes
 * pnpm vault:lan pin     – ny PIN (logger ut alle mobiler)
 * pnpm vault:lan status
 */
export const FIREWALL_RULE = 'Groovehouse Vault (LAN)';

export async function lanCommand(root: string, serverDir: string, args: string[]) {
  const [sub] = args;
  const cfg = loadConfig(root);
  if (sub === 'on') {
    if (!credRead('lan-pin') || args.includes('--new-pin')) await setPin();
    if (!credRead('lan-secret')) credWrite('lan-secret', newSecret());
    setLanEnabled(root, true);
    console.log('✓ LAN-modus er PÅ (lagret i groovehouse.config.json – overlever omstart)');
    await offerFirewallRule(cfg.ports.server);
    warnIfPublicNetwork();
    await restartIfRunning(serverDir, cfg.ports.server);
    printUrls(cfg.ports.server);
  } else if (sub === 'off') {
    setLanEnabled(root, false);
    credWrite('lan-secret', newSecret()); // ugyldiggjør alle mobil-informasjonskapsler
    console.log('✓ LAN-modus er AV – serveren lytter bare på 127.0.0.1, og alle mobiler er logget ut');
    await restartIfRunning(serverDir, cfg.ports.server);
    if (firewallRuleExists() && (await ask(`Fjerne brannmurregelen «${FIREWALL_RULE}»? Windows ber om administratortilgang. (j/N) `))) {
      elevated(`Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}'`);
      console.log(firewallRuleExists() ? '! Regelen finnes fortsatt (avbrutt?)' : '✓ Brannmurregelen er fjernet');
    }
  } else if (sub === 'pin') {
    await setPin();
    credWrite('lan-secret', newSecret());
    console.log('✓ Ny PIN lagret – alle mobiler må taste den på nytt');
    await restartIfRunning(serverDir, cfg.ports.server);
  } else if (sub === 'status') {
    console.log(`LAN-modus: ${cfg.lan.enabled ? 'PÅ' : 'av'}`);
    console.log(`PIN satt: ${credRead('lan-pin') ? 'ja (hashet i Credential Manager)' : 'nei'}`);
    console.log(`Brannmurregel «${FIREWALL_RULE}»: ${firewallRuleExists() ? 'finnes (kun private nettverk)' : 'mangler'}`);
    for (const n of networkCategories()) console.log(`Nettverk: ${n.replace('|', ' – ')}`);
    printUrls(cfg.ports.server);
  } else if (sub === 'forget') {
    // Brukes av vault:uninstall
    credDelete('lan-pin');
    credDelete('lan-secret');
  } else {
    throw new Error('Bruk: pnpm vault:lan on | off | pin | status');
  }
}

async function setPin() {
  if (!process.stdin.isTTY) throw new Error('PIN må tastes i et vanlig terminalvindu: pnpm vault:lan on');
  for (;;) {
    const a = await readHidden('Velg PIN for mobilen (6–12 sifre): ');
    if (!PIN_RE.test(a)) {
      console.log('  PIN må være 6–12 sifre.');
      continue;
    }
    const b = await readHidden('Gjenta PIN: ');
    if (a !== b) {
      console.log('  PIN-ene var ikke like. Prøv igjen.');
      continue;
    }
    credWrite('lan-pin', JSON.stringify(hashPin(a)));
    console.log('✓ PIN lagret hashet (scrypt) i Windows Credential Manager');
    return;
  }
}

/** Leser inn uten å vise tegnene. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u0008' || c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${q}→ ikke interaktivt, hopper over`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return /^(j|ja|y|yes)$/i.test(a.trim());
}

function psOut(cmd: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  return r.stdout.trim();
}

export function firewallRuleExists(): boolean {
  return Number(psOut(`@(Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue).Count`)) > 0;
}

/** Kjører en kommando med administratortilgang (Windows viser UAC-dialogen; brukeren godkjenner selv). */
export function elevated(command: string) {
  const enc = Buffer.from(command, 'utf16le').toString('base64');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${enc}'`], { stdio: 'inherit', windowsHide: true });
}

async function offerFirewallRule(serverPort: number) {
  if (firewallRuleExists()) {
    console.log(`✓ Brannmurregelen «${FIREWALL_RULE}» finnes allerede`);
    return;
  }
  const ports = `${serverPort}-${serverPort + 11}`;
  console.log(
    `\nMobilen når ikke PC-en før Windows-brannmuren slipper den inn. Forslag til regel:\n` +
      `  «${FIREWALL_RULE}»: innkommende TCP ${ports}, kun for ${process.execPath},\n` +
      `  kun profil «Privat» og kun fra lokalt subnett. Offentlige nettverk (kafé, hotell) er fortsatt stengt.`
  );
  if (!(await ask('Lage regelen nå? Windows ber om administratortilgang. (j/N) '))) {
    console.log('↷ Ingen brannmurregel laget. Uten den når ikke mobilen PC-en.');
    return;
  }
  elevated(
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Group 'Groovehouse Vault' -Description 'Groovehouse Vault: mobil på hjemmenettet (PIN kreves)' ` +
      `-Direction Inbound -Action Allow -Protocol TCP -LocalPort ${ports} -Profile Private -RemoteAddress LocalSubnet -Program '${process.execPath.replace(/'/g, "''")}'`
  );
  console.log(firewallRuleExists() ? '✓ Brannmurregel laget (kun private nettverk)' : '! Regelen ble ikke laget (avbrutt i UAC-dialogen?)');
}

function warnIfPublicNetwork() {
  const nets = networkCategories();
  const pub = nets.filter((n) => /\|Public$/i.test(n));
  if (pub.length) {
    console.log(
      `! Windows har satt disse nettverkene som «Offentlig»: ${pub.map((n) => n.split('|')[0]).join(', ')}.\n` +
        '  Regelen gjelder bare «Privat». Er dette hjemmenettet ditt, endre det i Innstillinger → Nettverk og Internett → (nettverket) → Nettverksprofil: Privat.'
    );
  }
}

async function restartIfRunning(serverDir: string, defaultPort: number) {
  const ports = new Set([defaultPort]);
  try {
    ports.add(Number(readFileSync(portFile(), 'utf8').trim()));
  } catch {
    /* ingen port-fil */
  }
  for (const p of ports) {
    const h = await probeHealth(p, 800);
    if (h.state !== 'ours') continue;
    process.kill(h.pid);
    await new Promise((r) => setTimeout(r, 800));
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'main.ts')], { cwd: serverDir, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const again = await probeHealth(Number(readFileSync(portFile(), 'utf8').trim()) || defaultPort, 800);
      if (again.state === 'ours' && again.pid !== h.pid) {
        console.log(`✓ Serveren er startet på nytt (pid ${again.pid})`);
        return;
      }
    }
    console.log('! Serveren startet ikke igjen av seg selv – dobbeltklikk «Groovehouse Vault».');
    return;
  }
}

function printUrls(port: number) {
  let p = port;
  try {
    p = Number(readFileSync(portFile(), 'utf8').trim()) || port;
  } catch {
    /* standardport */
  }
  const ips = lanAddresses();
  if (ips.length === 0) return console.log('! Fant ingen privat IP-adresse (er PC-en på Wi-Fi/kabel hjemme?)');
  console.log(`\nÅpne på mobilen (samme Wi-Fi): ${ips.map((ip) => `http://${ip}:${p}/`).join('  ')}`);
  console.log('QR-koden står i Studio → Mobil.');
}
