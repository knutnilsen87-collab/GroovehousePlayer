import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeHost, setAllowedHost } from '@gv/ingest/config';
import { restartIfRunning } from './lan-cli';
import { portFile } from './paths';

/**
 * pnpm vault:remote on     – Tailscale Serve (HTTPS, kun tailnettet) → 127.0.0.1:<serverport>,
 *                            og PC-ens ts.net-navn i allowedHosts i groovehouse.local.json (usporet). Ingen PIN: bare egne enheter når den.
 * pnpm vault:remote off    – fjerner Serve-oppsettet på 443 og navnet fra allowedHosts
 * pnpm vault:remote status – Serve-oppsett, allowedHosts, Funnel-advarsel og helse-sjekk via ts.net
 *
 * Funnel (åpent mot internett) slås aldri på herfra. Serveren slipper uansett ikke inn
 * forespørsler uten Tailscale-User-Login, som Funnel-trafikk mangler.
 */
export async function remoteCommand(root: string, serverDir: string, args: string[]) {
  const [sub] = args;
  const cfg = loadConfig(root);
  if (sub === 'on') {
    const host = selfHost();
    const port = currentPort(cfg.ports.server);
    const target = `http://127.0.0.1:${port}`;
    const existing = serveTarget(host);
    if (existing === target) console.log(`✓ Tailscale Serve peker allerede på ${target}`);
    else {
      if (existing) console.log(`! Serve pekte på ${existing}, endres til ${target}`);
      ts(['serve', '--bg', '--yes', '--https=443', target]);
      if (serveTarget(host) !== target) throw new Error('Tailscale Serve ble ikke satt opp (se meldingen over).');
      console.log(`✓ Tailscale Serve: https://${host}/ → ${target} (kun tailnettet)`);
    }
    warnIfFunnel(host);
    setAllowedHost(root, host, true);
    console.log(`✓ ${host} lagt i allowedHosts i groovehouse.local.json (usporet, ikke i git)`);
    await restartIfRunning(serverDir, cfg.ports.server);
    await printHealth(host);
  } else if (sub === 'off') {
    const host = selfHostOrNull();
    if (host && serveTarget(host)) {
      ts(['serve', '--https=443', 'off']);
      console.log(serveTarget(host) ? '! Serve-oppsettet finnes fortsatt' : '✓ Tailscale Serve på 443 er fjernet');
    } else console.log('✓ Tailscale Serve var ikke satt opp');
    // Fjern navnet selv om Tailscale ikke svarer, så serveren slutter å godta det.
    const hosts = host ? [host] : cfg.allowedHosts.filter((h) => h.endsWith('.ts.net'));
    for (const h of hosts) setAllowedHost(root, h, false);
    console.log(`✓ allowedHosts: ${loadConfig(root).allowedHosts.join(', ') || '(tom)'}`);
    await restartIfRunning(serverDir, cfg.ports.server);
  } else if (sub === 'status') {
    const host = selfHostOrNull();
    const port = currentPort(cfg.ports.server);
    console.log(`allowedHosts: ${cfg.allowedHosts.join(', ') || '(tom)'}`);
    if (!host) return console.log('Tailscale: kjører ikke eller er ikke logget inn');
    const target = serveTarget(host);
    console.log(`Tailscale Serve: ${target ? `https://${host}/ → ${target}` : 'av'}`);
    if (target && target !== `http://127.0.0.1:${port}`) console.log(`! Serveren kjører på port ${port}, men Serve peker på ${target}. Kjør «pnpm vault:remote on».`);
    if (target && !cfg.allowedHosts.includes(host)) console.log(`! ${host} mangler i allowedHosts – serveren svarer 421. Kjør «pnpm vault:remote on».`);
    warnIfFunnel(host);
    if (target) await printHealth(host);
  } else {
    throw new Error('Bruk: pnpm vault:remote on | off | status');
  }
}

function tsExe(): string {
  const std = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  return existsSync(std) ? std : 'tailscale';
}

function ts(args: string[], quiet = false): string {
  const r = spawnSync(tsExe(), args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`Fant ikke Tailscale (${r.error.message}). Er Tailscale installert?`);
  if (r.status !== 0) {
    if (quiet) return '';
    throw new Error(`tailscale ${args.join(' ')} feilet: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

/** PC-ens MagicDNS-navn, f.eks. «pc.tailXXXX.ts.net». */
function selfHost(): string {
  const j = JSON.parse(ts(['status', '--json'])) as { BackendState?: string; Self?: { DNSName?: string } };
  if (j.BackendState !== 'Running') throw new Error(`Tailscale kjører ikke (status: ${j.BackendState ?? 'ukjent'}). Logg inn i Tailscale først.`);
  const h = normalizeHost(j.Self?.DNSName);
  if (!h) throw new Error('Fant ikke PC-ens ts.net-navn. Er MagicDNS slått på i tailnettet?');
  return h;
}

function selfHostOrNull(): string | null {
  try {
    return selfHost();
  } catch {
    return null;
  }
}

interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

function serveStatus(): ServeStatus {
  const out = ts(['serve', 'status', '--json'], true).trim();
  return out ? (JSON.parse(out) as ServeStatus) : {};
}

/** Hvor Serve sender https://<host>/ (rot-handleren på 443), eller null. */
function serveTarget(host: string): string | null {
  return serveStatus().Web?.[`${host}:443`]?.Handlers?.['/']?.Proxy ?? null;
}

function warnIfFunnel(host: string) {
  const funnel = Object.entries(serveStatus().AllowFunnel ?? {}).filter(([, on]) => on);
  if (funnel.length === 0) return console.log('✓ Funnel er av (ikke åpent mot internett)');
  console.log(
    `! Funnel er PÅ for ${funnel.map(([k]) => k).join(', ')} – det er åpent mot internett.\n` +
      `  Serveren slipper ikke inn Funnel-trafikk uten PIN, men slå det av: tailscale funnel --https=443 off` +
      (funnel.some(([k]) => k.startsWith(host)) ? '' : ' (gjelder andre porter/navn enn Groovehouse)')
  );
}

function currentPort(fallback: number): number {
  try {
    return Number(readFileSync(portFile(), 'utf8').trim()) || fallback;
  } catch {
    return fallback;
  }
}

async function printHealth(host: string) {
  const url = `https://${host}/api/health`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const body = await r.text();
    if (r.status === 200 && body.includes('groovehouse-vault')) console.log(`✓ ${url} svarer (200)`);
    else console.log(`! ${url} svarte ${r.status}: ${body.slice(0, 80)}`);
  } catch (err) {
    console.log(`! Fikk ikke kontakt med ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`\nÅpne på mobilen (Tailscale på): https://${host}/`);
}
