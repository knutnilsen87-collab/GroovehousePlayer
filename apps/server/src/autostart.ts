import { spawnSync } from 'node:child_process';

/**
 * Del 1 pkt. 7: autostart ved pålogging via Oppgaveplanlegging – bare for denne brukeren, uten
 * administrator. Oppgaven kjører launcher.vbs /bakgrunn (wscript, ingen konsollvindu): serveren og
 * watcheren starter, men det åpnes ikke noe vindu. Fjernes med «pnpm vault:autostart off» eller
 * «pnpm vault:uninstall».
 */
export const TASK_NAME = 'Groovehouse Vault';

function ps(script: string, env: Record<string, string> = {}): { ok: boolean; out: string } {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

export function autostartStatus(): { installed: boolean; state: string | null; action: string | null } {
  const r = ps(`$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { $t.State; ($t.Actions | Select-Object -First 1).Arguments } else { 'NONE' }`);
  const lines = r.out.split(/\r?\n/);
  if (!r.ok || lines[0] === 'NONE') return { installed: false, state: null, action: null };
  return { installed: true, state: lines[0] ?? null, action: lines[1] ?? null };
}

export function enableAutostart(launcherVbs: string): void {
  const r = ps(
    [
      `$a = New-ScheduledTaskAction -Execute "$env:WINDIR\\System32\\wscript.exe" -Argument ('"' + $env:GV_LAUNCHER + '" /bakgrunn')`,
      `$u = "$env:USERDOMAIN\\$env:USERNAME"`,
      `$t = New-ScheduledTaskTrigger -AtLogOn -User $u`,
      `$p = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew`,
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Description 'Starter Groovehouse Vault (server og watcher) ved pålogging, uten vindu.' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`
    ].join('; '),
    { GV_LAUNCHER: launcherVbs }
  );
  if (!r.ok) throw new Error(`Klarte ikke å lage den planlagte oppgaven: ${r.out.split('\n')[0]}`);
}

export function disableAutostart(): boolean {
  if (!autostartStatus().installed) return false;
  const r = ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`);
  if (!r.ok) throw new Error(`Klarte ikke å fjerne oppgaven: ${r.out.split('\n')[0]}`);
  return true;
}
