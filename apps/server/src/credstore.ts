import { spawnSync } from 'node:child_process';

/**
 * Windows Credential Manager (generisk legitimasjon, kun for denne brukeren).
 * Verdien sendes via stdin – aldri som argument eller miljøvariabel – så den ikke synes i prosesslister.
 * Brukes til PIN-hash og signeringsnøkkelen for LAN-informasjonskapsler. Selve PIN-en lagres aldri.
 */
const PREFIX = 'GroovehouseVault';

const NATIVE = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class GvCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string value) {
    byte[] b = Encoding.UTF8.GetBytes(value);
    var c = new CREDENTIAL { Type = 1, TargetName = target, Persist = 2, UserName = "groovehouse-vault", CredentialBlobSize = b.Length, CredentialBlob = Marshal.AllocHGlobal(b.Length) };
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite " + Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null;
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Encoding.UTF8.GetString(b); } finally { CredFree(p); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, 1, 0); }
}
'@
`;

/** Hele skriptet (inkludert verdien, som base64) går til PowerShell via stdin (`-Command -`). */
function run(script: string, value: string | null = null): string {
  const valueLine = value === null ? '$in = $null' : `$in = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    input: `[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${NATIVE}\n${valueLine}\n${script}\n`,
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.status !== 0) throw new Error(`Credential Manager: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  return r.stdout.trim();
}

const target = (name: string) => `${process.env.GV_CRED_PREFIX ?? PREFIX}/${name}`;

export function credWrite(name: string, value: string): void {
  run(`[GvCred]::Write('${target(name)}', $in)`, value);
}

export function credRead(name: string): string | null {
  const out = run(`$v = [GvCred]::Read('${target(name)}'); if ($v -ne $null) { 'OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)) } else { 'NONE' }`);
  const line = out.split(/\r?\n/).pop() ?? '';
  return line.startsWith('OK:') ? Buffer.from(line.slice(3), 'base64').toString('utf8') : null;
}

export function credDelete(name: string): boolean {
  return run(`[GvCred]::Delete('${target(name)}')`).trim().toLowerCase().endsWith('true');
}
