import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Setter System.AppUserModel.ID på en .lnk (Startmeny-snarveien), så Windows-varsler (del 1 pkt. 8)
 * vises med «Groovehouse Vault» og ikonet som avsender. Windows har ikke noe kommandolinjeverktøy for
 * dette: snarveien lastes som ShellLink-objekt, verdien settes via IPropertyStore og fila lagres med
 * IPersistFile (en liten C#-hjelper i PowerShell). Påvirker bare snarveien.
 */
const CS = `
using System; using System.Runtime.InteropServices;
public static class GvAumid {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c); [PreserveSig] int GetAt(uint i, out PropertyKey k); [PreserveSig] int GetValue(ref PropertyKey k, out PropVariant v);
    [PreserveSig] int SetValue(ref PropertyKey k, ref PropVariant v); [PreserveSig] int Commit();
  }
  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile {
    void GetClassID(out Guid c); [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string file, [MarshalAs(UnmanagedType.Bool)] bool remember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string file);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string file);
  }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant v);

  public static string Set(string lnk, string id) {
    var link = new CShellLink();
    var pf = (IPersistFile)link;
    pf.Load(lnk, 2 /* STGM_READWRITE */);
    var store = (IPropertyStore)link;
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var v = new PropVariant { vt = 31 /* VT_LPWSTR */, p = Marshal.StringToCoTaskMemUni(id) };
    try {
      Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref v));
      Marshal.ThrowExceptionForHR(store.Commit());
    } finally { Marshal.FreeCoTaskMem(v.p); }
    pf.Save(lnk, true);
    // Les tilbake for å bekrefte
    PropVariant r;
    Marshal.ThrowExceptionForHR(store.GetValue(ref key, out r));
    string back = r.vt == 31 ? Marshal.PtrToStringUni(r.p) : "";
    PropVariantClear(ref r);
    Marshal.ReleaseComObject(link);
    return back;
  }
}`;

export function setShortcutAumid(lnk: string, aumid: string): void {
  // Som .ps1-fil (ikke «-Command -»): Add-Type med flerlinjers here-string kjører ikke pålitelig via stdin.
  const script = `Add-Type -TypeDefinition @'\n${CS}\n'@\n[GvAumid]::Set($env:GV_LNK, $env:GV_AUMID)\n`;
  const file = path.join(tmpdir(), `gv-aumid-${process.pid}.ps1`);
  writeFileSync(file, '﻿' + script, 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GV_LNK: lnk, GV_AUMID: aumid }
  });
  rmSync(file, { force: true });
  const back = r.stdout.trim().split(/\r?\n/).pop();
  if (r.status !== 0 || back !== aumid) throw new Error(`Klarte ikke å sette AppUserModelID på snarveien: ${(r.stderr || r.stdout).trim().split('\n')[0] || `leste tilbake «${back}»`}`);
}
