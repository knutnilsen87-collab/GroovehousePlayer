import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Advarer hvis prosjektmappa ligger i en mappe som synkroniseres til skyen (Google Drive, OneDrive,
 * Dropbox, iCloud, Box). Da havner musikken (media/), private data (data/), hemmeligheter (.env) og
 * tusenvis av node_modules-filer i skyen – mot regelen «ingen musikk til skyen».
 * Bare lesing: ingenting endres i synk-klienten.
 */
export interface CloudSync {
  provider: 'Google Drive' | 'OneDrive' | 'Dropbox' | 'iCloud' | 'Box';
  /** Hva som avslørte det (mappe eller innstilling). */
  evidence: string;
  /** Den synkroniserte rotmappa. */
  syncRoot: string;
}

/** Det som absolutt ikke skal i skyen (med hvorfor). */
export const MUST_NOT_SYNC: Array<[string, string]> = [
  ['media', 'musikken (HLS, master.flac, preview)'],
  ['data', 'spillelister, enheter, lyttelogg, kildefiler, app-oppdateringer'],
  ['.env', 'hemmeligheter'],
  ['node_modules', 'titusenvis av filer, lages på nytt med pnpm install']
];

export interface SyncProbe {
  exists: (p: string) => boolean;
  read: (p: string) => string | null;
  env: Record<string, string | undefined>;
}
const realProbe: SyncProbe = {
  exists: existsSync,
  read: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  env: process.env
};

const norm = (p: string) => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const under = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '\\');
};
const ancestors = (p: string) => {
  const out: string[] = [];
  let cur = path.win32.resolve(p);
  for (;;) {
    out.push(cur);
    const up = path.win32.dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
};

export function detectCloudSync(projectRoot: string, probe: SyncProbe = realProbe): CloudSync | null {
  const root = path.win32.resolve(projectRoot);
  const { env } = probe;
  // Google Drive for desktop («speil»-mapper): arbeidsmapper i roten av den synkroniserte mappa
  for (const dir of ancestors(root)) {
    for (const marker of ['.tmp.driveupload', '.tmp.drivedownload']) {
      if (probe.exists(path.win32.join(dir, marker))) return { provider: 'Google Drive', evidence: path.win32.join(dir, marker), syncRoot: dir };
    }
  }
  // OneDrive (privat og jobb)
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const d = env[k];
    if (d && under(root, d)) return { provider: 'OneDrive', evidence: `miljøvariabelen ${k}`, syncRoot: d };
  }
  // Dropbox: info.json sier hvor mappa ligger
  for (const base of [env.APPDATA, env.LOCALAPPDATA]) {
    if (!base) continue;
    const info = probe.read(path.win32.join(base, 'Dropbox', 'info.json'));
    if (!info) continue;
    try {
      const j = JSON.parse(info) as Record<string, { path?: string }>;
      for (const v of Object.values(j)) if (v?.path && under(root, v.path)) return { provider: 'Dropbox', evidence: path.win32.join(base, 'Dropbox', 'info.json'), syncRoot: v.path };
    } catch {
      /* ugyldig info.json */
    }
  }
  for (const dir of ancestors(root)) if (probe.exists(path.win32.join(dir, '.dropbox'))) return { provider: 'Dropbox', evidence: path.win32.join(dir, '.dropbox'), syncRoot: dir };
  // iCloud og Box: standardmappene i brukerprofilen
  const home = env.USERPROFILE;
  if (home) {
    for (const [name, provider] of [
      ['iCloudDrive', 'iCloud'],
      ['Box', 'Box']
    ] as const) {
      const d = path.win32.join(home, name);
      if (under(root, d)) return { provider, evidence: d, syncRoot: d };
    }
  }
  return null;
}

/** Advarselen på norsk (logg, vault:install og Studio). */
export function cloudSyncWarning(s: CloudSync, projectRoot: string): string {
  const items = MUST_NOT_SYNC.map(([n, why]) => `  • ${path.win32.join(projectRoot, n)} – ${why}`).join('\n');
  return (
    `⚠ Prosjektmappa ligger i en mappe som synkroniseres av ${s.provider} (${s.syncRoot}; funnet via ${s.evidence}).\n` +
    `  Dette skal ikke til skyen:\n${items}\n` +
    `  Ta prosjektmappa (eller i det minste disse) ut av synkroniseringen i ${s.provider}.`
  );
}
