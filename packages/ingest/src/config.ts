import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TitleCleanupConfig } from '@gv/shared';

export interface VaultConfig {
  ports: { server: number; dev: number };
  lan: { enabled: boolean; rememberDays: number };
  /** Eksakte vertsnavn (f.eks. Tailscale Serve) som godtas i Host-headeren fra loopback. Ingen jokertegn. */
  allowedHosts: string[];
  defaults: { artist: string | null; label: string | null; copyright: string | null };
  titleCleanup: TitleCleanupConfig;
  /** Del 8: lyd. Målnivå for avspilling (spilleren demper bare, løfter aldri). */
  audio: { targetLufs: number };
  /** Del 8: kategorisering. Lengre enn grensen = live-sett; regler på filnavn kan sette type/variant. */
  ingest: { setThresholdMinutes: number; rules: IngestRule[] };
  /** Del 8: farger fra cover. */
  colors: { minContrast: number; colorFallback: boolean };
  /** Del 8: standarder for drops (lagres nå, brukes i delingsfasen). */
  drops: { tier: 'partner' | 'inner_circle' | 'supporter' | 'teaser'; ttlDays: number; maxDevices: number; watermark: boolean };
  /**
   * Del 3: tonearts-metode. «krumhansl» = som før (standard til fasiten avgjør), «edma» = HPCP med tuning,
   * bare harmoniske rammer og EDMA-profiler. Sammenlign med `pnpm eval:analysis <mappe>` mot fixtures/truth.json.
   */
  analysis: { keyMethod: 'krumhansl' | 'edma' };
  /** Eksportmappa (Reason-bounces). Lagres lokalt (groovehouse.local.json); ellers GH_EXPORT_DIR i .env. */
  exportDir: string | null;
  /** Del 16: utkastmappa (umastrede låter, undermapper tillatt). Lokal; ellers GH_DRAFT_DIR. Kun lesing. */
  draftDir: string | null;
}

/** «* (Live *)» → set. Mønster med * som jokertegn, uten hensyn til store/små bokstaver. */
export interface IngestRule {
  pattern: string;
  kind?: 'set' | 'track';
  variant?: string;
}

export function ruleMatches(pattern: string, fileName: string): boolean {
  const base = fileName.replace(/\.[^.]+$/, '');
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
  return re.test(base) || re.test(fileName);
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Første regel som passer filnavnet, eller null. */
export function matchRule(cfg: Pick<VaultConfig, 'ingest'>, fileName: string): IngestRule | null {
  return cfg.ingest.rules.find((r) => ruleMatches(r.pattern, fileName)) ?? null;
}

const FALLBACK: VaultConfig = {
  ports: { server: 41733, dev: 41734 },
  lan: { enabled: false, rememberDays: 30 },
  allowedHosts: [],
  defaults: { artist: null, label: null, copyright: null },
  titleCleanup: { remove: ['suno ai', 'suno'] },
  audio: { targetLufs: -14 },
  ingest: { setThresholdMinutes: 20, rules: [] },
  colors: { minContrast: 4.5, colorFallback: true },
  drops: { tier: 'partner', ttlDays: 30, maxDevices: 2, watermark: true },
  analysis: { keyMethod: 'krumhansl' },
  exportDir: null,
  draftDir: null
};
export const DEFAULTS: Readonly<VaultConfig> = FALLBACK;

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

/** Delt config i git. */
export const CONFIG_FILE = 'groovehouse.config.json';
/** Lokale verdier for denne PC-en (f.eks. Tailscale-navnet). Står i .gitignore og leses i tillegg. */
export const LOCAL_CONFIG_FILE = 'groovehouse.local.json';

function readJson(file: string): Partial<VaultConfig> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<VaultConfig>) : {};
}

function hostList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map(normalizeHost).filter((h): h is string => h !== null);
}

/**
 * groovehouse.config.json, med groovehouse.local.json lagt over (seksjon for seksjon).
 * allowedHosts slås sammen fra begge filene.
 */
export function loadConfig(root = findRoot()): VaultConfig {
  const j = readJson(path.join(root, CONFIG_FILE));
  const l = readJson(path.join(root, LOCAL_CONFIG_FILE));
  return {
    ports: { ...FALLBACK.ports, ...(j.ports ?? {}), ...(l.ports ?? {}) },
    lan: { ...FALLBACK.lan, ...(j.lan ?? {}), ...(l.lan ?? {}) },
    allowedHosts: [...new Set([...hostList(j.allowedHosts), ...hostList(l.allowedHosts)])],
    defaults: { ...FALLBACK.defaults, ...(j.defaults ?? {}), ...(l.defaults ?? {}) },
    titleCleanup: { remove: l.titleCleanup?.remove ?? j.titleCleanup?.remove ?? FALLBACK.titleCleanup.remove },
    audio: { ...FALLBACK.audio, ...(j.audio ?? {}), ...(l.audio ?? {}) },
    ingest: { ...FALLBACK.ingest, ...(j.ingest ?? {}), ...(l.ingest ?? {}) },
    colors: legacyColors({ ...FALLBACK.colors, ...(j.colors ?? {}), ...(l.colors ?? {}) }),
    drops: { ...FALLBACK.drops, ...(j.drops ?? {}), ...(l.drops ?? {}) },
    analysis: { keyMethod: (l.analysis?.keyMethod ?? j.analysis?.keyMethod) === 'edma' ? 'edma' : 'krumhansl' },
    // Eksportmappa er maskinspesifikk: bare fra den lokale fila (eller .env)
    exportDir: typeof l.exportDir === 'string' && l.exportDir ? l.exportDir : process.env.GH_EXPORT_DIR ?? null,
    draftDir: typeof l.draftDir === 'string' && l.draftDir ? l.draftDir : process.env.GH_DRAFT_DIR ?? null
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

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Et eksakt vertsnavn i små bokstaver, uten avsluttende punktum. Jokertegn, porter, IP-adresser
 * og ugyldige navn gir null, så ingen kan skru av Host-sjekken via config (f.eks. «*.ts.net»).
 */
export function normalizeHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const h = value.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(h) || /^[\d.]+$/.test(h)) return null;
  return h;
}

/**
 * Legger til eller fjerner et vertsnavn i allowedHosts i groovehouse.local.json (usporet, resten
 * av fila beholdes). Vertsnavn for denne PC-en skal ikke i git.
 */
export function setAllowedHost(root: string, host: string, allowed: boolean): void {
  const h = normalizeHost(host);
  if (!h) throw new Error(`Ugyldig vertsnavn: ${host}`);
  const file = path.join(root, LOCAL_CONFIG_FILE);
  const j = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const current = hostList(j.allowedHosts);
  j.allowedHosts = allowed ? [...new Set([...current, h])] : current.filter((x) => x !== h);
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
}

/** "℗ {år} {label}" / "℗ {year} Groovehouse Records" → "℗ 2026 Groovehouse Records" */
export function formatCopyright(template: string | null, year: number, label: string | null = null): string | null {
  return template ? template.replace(/\{(year|år)\}/g, String(year)).replace(/\{label\}/g, label ?? '').replace(/\s+/g, ' ').trim() : null;
}

/** «goldFallback» (før 2026-11-14) heter nå «colorFallback»: standardfargen er cyan, gull bare i logoen. */
function legacyColors(c: Record<string, unknown>): { minContrast: number; colorFallback: boolean } {
  const { goldFallback, ...rest } = c as { goldFallback?: boolean; colorFallback?: boolean; minContrast: number };
  return { ...rest, colorFallback: rest.colorFallback ?? goldFallback ?? true } as { minContrast: number; colorFallback: boolean };
}
