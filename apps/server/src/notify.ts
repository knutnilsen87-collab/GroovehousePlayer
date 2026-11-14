import { spawn, spawnSync } from 'node:child_process';
import type { AssetManifest } from '@gv/shared';

/**
 * Del 1 pkt. 8: Windows-varsel når watcheren har ingestet en ny bounce:
 * «Would You Run (Extended) er klar – 125 BPM · 8A».
 *
 * Avsenderen er «Groovehouse Vault» med ikonet fordi Startmeny-snarveien har AppUserModelID
 * AUMID (settes av vault:install). Uten den faller varselet tilbake til PowerShell som avsender.
 * Ingen ekstra npm-pakke: WinRT-varsler via Windows PowerShell. Tekst sendes via stdin (base64).
 */
export const AUMID = 'GroovehouseRecords.Vault';
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

export function readyMessage(m: Pick<AssetManifest, 'title' | 'variantLabel' | 'bpm' | 'key'>): { title: string; body: string } {
  const name = m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title;
  const facts = [m.bpm ? `${Math.round(m.bpm)} BPM` : null, m.key?.camelot ?? null].filter(Boolean).join(' · ');
  return { title: 'Groovehouse Vault', body: facts ? `${name} er klar – ${facts}` : `${name} er klar` };
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function toastScript(title: string, body: string, aumid: string): string {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    `$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid.replace(/'/g, "''")}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`
  ].join('\n');
}

let aumidRegistered: boolean | null = null;
/** Har en Startmeny-snarvei vår AUMID? (Ellers vises ikke varselet med vår avsender.) */
function hasAumidShortcut(): boolean {
  if (aumidRegistered !== null) return aumidRegistered;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-StartApps | Where-Object { $_.AppID -eq '${AUMID}' } | Measure-Object).Count`], { encoding: 'utf8', windowsHide: true });
  aumidRegistered = r.status === 0 && Number(r.stdout.trim()) > 0;
  return aumidRegistered;
}

export function notify(title: string, body: string, log?: (l: string) => void): void {
  if (process.platform !== 'win32') return;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => code !== 0 && log?.(`! Windows-varsel feilet: ${err.trim().split('\n')[0]}`));
  p.stdin.end(toastScript(title, body, hasAumidShortcut() ? AUMID : POWERSHELL_AUMID));
}
