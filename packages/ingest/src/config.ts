import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TitleCleanupConfig } from '@gv/shared';

export interface VaultConfig {
  defaults: { artist: string | null; label: string | null; copyright: string | null };
  titleCleanup: TitleCleanupConfig;
}

const FALLBACK: VaultConfig = {
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
    defaults: { ...FALLBACK.defaults, ...(j.defaults ?? {}) },
    titleCleanup: { remove: j.titleCleanup?.remove ?? FALLBACK.titleCleanup.remove }
  };
}

/** "℗ {year} Groovehouse Records" → "℗ 2026 Groovehouse Records" */
export function formatCopyright(template: string | null, year: number): string | null {
  return template ? template.replace('{year}', String(year)) : null;
}
