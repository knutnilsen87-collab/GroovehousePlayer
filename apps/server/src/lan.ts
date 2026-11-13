import { spawnSync } from 'node:child_process';
import os from 'node:os';
import QRCode from 'qrcode';

/**
 * Private IPv4-adresser (RFC 1918) på denne PC-en. Adresser på kort med standard gateway (det
 * ekte hjemmenettet) først – virtuelle kort (VirtualBox, WSL, VPN) har ingen gateway og havner sist.
 */
export function lanAddresses(): string[] {
  const gw = gatewayIps();
  const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|loopback|bluetooth|tailscale|zerotier|nord|openvpn|wireguard/i;
  const out: Array<{ ip: string; rank: number }> = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !isPrivateIPv4(a.address)) continue;
      out.push({ ip: a.address, rank: gw.includes(a.address) ? 0 : virtual.test(name) ? 3 : /wi-?fi|wlan/i.test(name) ? 1 : 2 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.ip);
}

let cachedGw: { at: number; value: string[] } | null = null;
/** IPv4-adresser på kort som har standard gateway (bufret i 60 s). */
function gatewayIps(): string[] {
  if (process.platform !== 'win32') return [];
  if (cachedGw && Date.now() - cachedGw.at < 60_000) return cachedGw.value;
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress }'],
    { encoding: 'utf8', windowsHide: true }
  );
  const value = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  cachedGw = { at: Date.now(), value };
  return value;
}

export function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Klientadressen fra socketen (aldri fra headere). */
export function remoteIPv4(addr: string | undefined): string {
  return (addr ?? '').replace(/^::ffff:/, '');
}

export function isLoopback(addr: string | undefined): boolean {
  const a = remoteIPv4(addr);
  return a === '::1' || a.startsWith('127.');
}

/** Nettverksprofilen Windows har satt (Private/Public/DomainAuthenticated). Brannmurregelen gjelder bare Private. */
let cachedCategory: { at: number; value: string[] } | null = null;
export function networkCategories(): string[] {
  if (cachedCategory && Date.now() - cachedCategory.at < 60_000) return cachedCategory.value;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + '|' + $_.NetworkCategory }"], { encoding: 'utf8', windowsHide: true });
  const value = r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.trim()) : [];
  cachedCategory = { at: Date.now(), value };
  return value;
}

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#07080B', light: '#F0DC6A' } });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Egen, liten innloggingsside (ingen app-kode lastes før PIN er godkjent). */
export function loginPage(opts: { next: string; error?: string; blockedSec?: number | null }): string {
  const msg = opts.blockedSec
    ? `For mange forsøk. Prøv igjen om ${Math.ceil(opts.blockedSec / 60)} min.`
    : opts.error ?? '';
  return `<!doctype html><html lang="no"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#07080B">
<title>Groovehouse Vault</title><link rel="icon" href="/icons/favicon-32.png">
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080B;color:#EDEAE2;font:16px/1.4 Inter,system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:14px;background:#0E1015;border:1px solid rgba(255,255,255,.06);border-radius:20px;padding:28px 22px}
img{width:72px;height:72px;align-self:center}
h1{margin:0;text-align:center;font:600 20px Oswald,Inter,system-ui;letter-spacing:1.5px;text-transform:uppercase}
p{margin:0;color:#A39E91;font-size:14px;text-align:center}
input{font-size:28px;letter-spacing:8px;text-align:center;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:#0A0B0F;color:#EDEAE2;min-height:44px}
input:focus{outline:2px solid #F0C030;border-color:transparent}
button{min-height:48px;border:0;border-radius:999px;font-weight:600;font-size:16px;color:#120D02;background:linear-gradient(135deg,#F0DC6A 0%,#F0C030 45%,#B06000 100%)}
.err{color:#F2A08F;min-height:1.2em}
</style></head><body>
<form method="post" action="/lan/login">
<img src="/icons/icon-192.png" alt="">
<h1>Groovehouse Vault</h1>
<p>Skriv PIN-koden for å åpne spilleren på denne enheten. Den huskes i 30 dager.</p>
<input name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="12" required autofocus aria-label="PIN-kode"${opts.blockedSec ? ' disabled' : ''}>
<input type="hidden" name="next" value="${esc(opts.next)}">
<p class="err" role="alert">${esc(msg)}</p>
<button type="submit"${opts.blockedSec ? ' disabled' : ''}>Åpne</button>
</form></body></html>`;
}

/** Bare interne stier som mål etter innlogging (ingen åpen omdirigering). */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?!\/|\\)[^\s]*$/.test(next) && !next.startsWith('/lan/') ? next : '/';
}
