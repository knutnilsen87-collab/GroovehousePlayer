import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TitleCleanupConfig } from '@gv/shared';

export interface VaultConfig {
  ports: { server: number; dev: number };
  lan: { enabled: boolean; rememberDays: number };
  defaults: { artist: string | null; label: string | null; copyright: string | null };
  titleCleanup: TitleCleanupConfig;
}

const FALLBACK: VaultConfig = {
  ports: { server: 41733, dev: 41734 },
  lan: { enabled: false, rememberDays: 30 },
  defaults: { artist: null, label: null, copyright: null },
  titleCleanup: { remove: ['suno ai', 'suno'] }
};

/** Prosjektroten = nærmeste mappe oppover som har groovehouse.config.json eller pnpm-workspace.yaml. */
export function findRoot(start = process.env.INIT_CWD ?? process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'groovehouse.config.json')) || existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

/** Leser .env i prosjektroten (uten å overskrive variabler som allerede er satt). */
export function loadDotEnv(root = findRoot()): void {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]!] === undefined && value !== '') process.env[m[1]!] = value;
  }
}

export function loadConfig(root = findRoot()): VaultConfig {
  const file = path.join(root, 'groovehouse.config.json');
  if (!existsSync(file)) return FALLBACK;
  const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<VaultConfig>;
  return {
    ports: { ...FALLBACK.ports, ...(j.ports ?? {}) },
    lan: { ...FALLBACK.lan, ...(j.lan ?? {}) },
    defaults: { ...FALLBACK.defaults, ...(j.defaults ?? {}) },
    titleCleanup: { remove: j.titleCleanup?.remove ?? FALLBACK.titleCleanup.remove }
  };
}

/** Slår LAN-modus av/på i groovehouse.config.json (resten av fila beholdes). Overlever omstart. */
export function setLanEnabled(root: string, enabled: boolean): void {
  const file = path.join(root, 'groovehouse.config.json');
  const j = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const lan = (j.lan ?? {}) as Record<string, unknown>;
  j.lan = { ...lan, enabled };
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
}

/** "℗ {year} Groovehouse Records" → "℗ 2026 Groovehouse Records" */
export function formatCopyright(template: string | null, year: number): string | null {
  return template ? template.replace('{year}', String(year)) : null;
}
