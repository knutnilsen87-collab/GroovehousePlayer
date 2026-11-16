import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FALLBACK_PALETTE, parseFlatName, type AssetManifest } from '@gv/shared';
import { CONFIG_FILE, formatCopyright, LOCAL_CONFIG_FILE, loadConfig, matchRule, type IngestRule, type VaultConfig } from './config';
import { AUDIO_RE } from './sources';
import { paletteFrom } from './cover';

/**
 * Del 8: innstillinger fra Studio. Bare seksjonene under kan endres herfra; porter, LAN, allowedHosts og
 * standardverdier for metadata har egne veier. Alt valideres før noe skrives, skrivingen er atomisk
 * (tmp + rename) og forrige versjon ligger i groovehouse.config.backup.json.
 */
export interface SettingsPatch {
  audio?: Partial<VaultConfig['audio']>;
  ingest?: Partial<VaultConfig['ingest']>;
  lyrics?: Partial<VaultConfig['lyrics']>;
  covers?: Partial<VaultConfig['covers']>;
  colors?: Partial<VaultConfig['colors']>;
  drops?: Partial<VaultConfig['drops']>;
  /** Metadata: standard artist/label/copyright-mal ({år}, {label}). */
  defaults?: Partial<VaultConfig['defaults']>;
  /** Ord/mønstre som fjernes fra titler. */
  titleCleanup?: VaultConfig['titleCleanup'];
  /** Lagres i groovehouse.local.json (maskinspesifikk sti). null = fjern, bruk .env. */
  exportDir?: string | null;
  /** Del 16: utkastmappa (lokal, kun lesing). */
  draftDir?: string | null;
  /** Alle mappene for umastrede låter (erstatter draftDir). */
  draftDirs?: string[];
}

export type Editable = Pick<VaultConfig, 'audio' | 'ingest' | 'lyrics' | 'covers' | 'colors' | 'drops' | 'defaults' | 'titleCleanup' | 'exportDir' | 'draftDir' | 'draftDirs'>;

export const BACKUP_FILE = 'groovehouse.config.backup.json';
const TIERS = ['partner', 'inner_circle', 'supporter', 'teaser'] as const;

export function editableOf(cfg: VaultConfig): Editable {
  return { audio: cfg.audio, ingest: cfg.ingest, lyrics: cfg.lyrics, covers: cfg.covers, colors: cfg.colors, drops: cfg.drops, defaults: cfg.defaults, titleCleanup: cfg.titleCleanup, exportDir: cfg.exportDir, draftDir: cfg.draftDir, draftDirs: cfg.draftDirs };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** WhisperX-modeller som kan velges i Innstillinger (større = bedre og tregere). */
export const LYRICS_MODELS = ['small', 'medium', 'large-v2', 'large-v3'];

/** Returnerer feilmeldinger (tom liste = gyldig). Sjekker hele resultatet, ikke bare endringen. */
export function validateSettings(patch: SettingsPatch, base: VaultConfig): string[] {
  const e: string[] = [];
  const next = applyPatch(base, patch);
  const lufs = num(next.audio.targetLufs);
  if (!(lufs >= -16 && lufs <= -11)) e.push('Målnivå må være mellom −16 og −11 LUFS');
  const min = num(next.ingest.setThresholdMinutes);
  if (!(min >= 5 && min <= 180) || !Number.isInteger(min)) e.push('Sett-grensen må være hele minutter mellom 5 og 180');
  if (!Array.isArray(next.ingest.rules) || next.ingest.rules.length > 50) e.push('Høyst 50 filnavnregler');
  else
    next.ingest.rules.forEach((r: IngestRule, i) => {
      const n = i + 1;
      if (typeof r?.pattern !== 'string' || !r.pattern.trim() || r.pattern.length > 100) e.push(`Regel ${n}: mønster mangler eller er for langt`);
      else if (!r.pattern.includes('*') && !/\S/.test(r.pattern)) e.push(`Regel ${n}: ugyldig mønster`);
      if (r.kind !== undefined && r.kind !== 'set' && r.kind !== 'track') e.push(`Regel ${n}: type må være «set» eller «track»`);
      if (r.variant !== undefined && r.variant !== '' && !/^[a-z0-9-]{1,40}$/.test(r.variant)) e.push(`Regel ${n}: variant kan bare ha a–z, 0–9 og bindestrek`);
      if (r.kind === undefined && !r.variant) e.push(`Regel ${n}: sett type eller variant`);
    });
  for (const [k, label] of [['bulkimgInbox', 'Innboks for bulkIMG'], ['bulkimgExports', 'Eksportmappe for bulkIMG']] as const) {
    const v = next.covers[k];
    if (typeof v !== 'string' || !v.trim() || !path.isAbsolute(v.trim()) || v.includes('\0') || v.split(/[\\/]+/).includes('..')) e.push(`${label} må være en full sti (f.eks. F:\\...)`);
  }
  if (typeof next.lyrics.auto !== 'boolean') e.push('Automatisk tekst må være av eller på');
  if (!LYRICS_MODELS.includes(next.lyrics.model)) e.push(`Tekstmodell må være en av ${LYRICS_MODELS.join(', ')}`);
  if (next.lyrics.language !== null && !/^[a-z]{2}$/.test(String(next.lyrics.language))) e.push('Språk for tekst må være en tobokstavskode (f.eks. en, no) eller automatisk');
  const c = num(next.colors.minContrast);
  if (!(c >= 3 && c <= 7)) e.push('Minste kontrast må være mellom 3 og 7');
  if (typeof next.colors.colorFallback !== 'boolean') e.push('Standardfarge for fargeløse cover må være av eller på');
  if (!TIERS.includes(next.drops.tier)) e.push('Ukjent tilgangsnivå for drops');
  const ttl = num(next.drops.ttlDays);
  if (!(ttl >= 1 && ttl <= 365) || !Number.isInteger(ttl)) e.push('Drop-varighet må være 1–365 dager');
  const dev = num(next.drops.maxDevices);
  if (!(dev >= 1 && dev <= 10) || !Number.isInteger(dev)) e.push('Maks enheter må være 1–10');
  if (typeof next.drops.watermark !== 'boolean') e.push('Vannmerke må være av eller på');
  for (const [k, label, max] of [['artist', 'Standard artist', 100], ['label', 'Label', 100], ['copyright', 'Copyright-malen', 120]] as const) {
    const v = next.defaults[k];
    if (v !== null && (typeof v !== 'string' || v.length > max)) e.push(`${label} må være tekst på høyst ${max} tegn`);
  }
  const rm = next.titleCleanup.remove;
  if (!Array.isArray(rm) || rm.length > 50 || rm.some((w) => typeof w !== 'string' || !w.trim() || w.length > 60)) e.push('Rensingslisten: høyst 50 ord, hvert 1–60 tegn');
  if (patch.exportDir !== undefined && patch.exportDir !== null) {
    const d = patch.exportDir.trim();
    if (!path.isAbsolute(d)) e.push('Eksportmappa må være en full sti (f.eks. D:\\Musikk\\REASONDONE)');
    else if (!existsSync(d) || !statSync(d).isDirectory()) e.push('Eksportmappa finnes ikke');
  }
  if (patch.draftDir !== undefined && patch.draftDir !== null && patch.draftDir.trim()) {
    const d = patch.draftDir.trim();
    const ex = (patch.exportDir ?? base.exportDir ?? '').trim();
    if (!path.isAbsolute(d)) e.push('Mappa for umastrede låter må være en full sti (f.eks. D:\\Musikk\\Umastret)');
    else if (!existsSync(d) || !statSync(d).isDirectory()) e.push('Mappa for umastrede låter finnes ikke');
    else if (ex && path.resolve(d).toLowerCase() === path.resolve(ex).toLowerCase()) e.push('Mappa for umastrede låter kan ikke være den samme som eksportmappa (release-klare)');
  }
  if (patch.draftDirs !== undefined) {
    const ex = (patch.exportDir ?? base.exportDir ?? '').trim();
    for (const raw of patch.draftDirs) {
      const d = raw.trim();
      if (!d) continue;
      if (!path.isAbsolute(d)) e.push(`Mappa for umastrede låter må være en full sti: ${d}`);
      else if (!existsSync(d) || !statSync(d).isDirectory()) e.push(`Mappa for umastrede låter finnes ikke: ${d}`);
      else if (ex && path.resolve(d).toLowerCase() === path.resolve(ex).toLowerCase()) e.push('En mappe for umastrede låter kan ikke være den samme som eksportmappa (release-klare)');
    }
  }
  return e;
}

function applyPatch(base: VaultConfig, p: SettingsPatch): VaultConfig {
  return {
    ...base,
    audio: { ...base.audio, ...(p.audio ?? {}) },
    ingest: { ...base.ingest, ...(p.ingest ?? {}) },
    lyrics: { ...base.lyrics, ...(p.lyrics ?? {}) },
    covers: { ...base.covers, ...(p.covers ?? {}) },
    colors: { ...base.colors, ...(p.colors ?? {}) },
    drops: { ...base.drops, ...(p.drops ?? {}) },
    defaults: { ...base.defaults, ...(p.defaults ?? {}) },
    titleCleanup: p.titleCleanup ? { remove: p.titleCleanup.remove.map((w) => (typeof w === 'string' ? w.trim() : w)) } : base.titleCleanup,
    exportDir: p.exportDir === undefined ? base.exportDir : p.exportDir?.trim() || null,
    draftDir: p.draftDirs ? (p.draftDirs.map((d) => d.trim()).filter(Boolean)[0] ?? null) : p.draftDir === undefined ? base.draftDir : p.draftDir?.trim() || null,
    draftDirs: p.draftDirs ? p.draftDirs.map((d) => d.trim()).filter(Boolean) : p.draftDir === undefined ? base.draftDirs : p.draftDir?.trim() ? [p.draftDir.trim(), ...base.draftDirs.slice(1)] : base.draftDirs.slice(1)
  };
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** Lagrer (etter validering). Kaster Error med alle feilene samlet hvis noe er ugyldig. */
export function saveSettings(root: string, patch: SettingsPatch): VaultConfig {
  const base = loadConfig(root);
  const errors = validateSettings(patch, base);
  if (errors.length) throw Object.assign(new Error(errors.join('\n')), { errors });
  const next = applyPatch(base, patch);

  const shared = path.join(root, CONFIG_FILE);
  const j = existsSync(shared) ? (JSON.parse(readFileSync(shared, 'utf8')) as Record<string, unknown>) : {};
  if (existsSync(shared)) copyFileSync(shared, path.join(root, BACKUP_FILE));
  for (const k of ['audio', 'ingest', 'lyrics', 'colors', 'drops', 'defaults', 'titleCleanup'] as const) if (patch[k]) j[k] = next[k];
  writeAtomic(shared, j);

  if (patch.exportDir !== undefined || patch.draftDir !== undefined || patch.draftDirs !== undefined || patch.covers !== undefined) {
    const local = path.join(root, LOCAL_CONFIG_FILE);
    const l = existsSync(local) ? (JSON.parse(readFileSync(local, 'utf8')) as Record<string, unknown>) : {};
    if (patch.exportDir !== undefined) {
      if (next.exportDir) l.exportDir = next.exportDir;
      else delete l.exportDir;
    }
    if (patch.draftDir !== undefined || patch.draftDirs !== undefined) {
      // Lagres som liste; den gamle enkeltnøkkelen fjernes
      delete l.draftDir;
      if (next.draftDirs.length) l.draftDirs = next.draftDirs;
      else delete l.draftDirs;
    }
    if (patch.covers !== undefined) l.covers = { bulkimgInbox: next.covers.bulkimgInbox.trim(), bulkimgExports: next.covers.bulkimgExports.trim() };
    writeAtomic(local, l);
  }
  return loadConfig(root);
}

export interface PreviewRow {
  file: string;
  title: string;
  slug: string;
  variant: string | null;
  /** Fra en regel, ellers avgjøres det av lengden ved ingest. */
  kind: 'set' | 'track' | 'etter lengde';
  removed: string[];
  rule: string | null;
}

/**
 * Forhåndsvisning: hvordan lydfilene i eksportmappa ville blitt tolket med disse innstillingene
 * (tittel etter rensing, variant, type fra regler). Leser bare filnavn.
 */
export function previewExport(dir: string, patch: SettingsPatch, base: VaultConfig, limit = 200): { rows: PreviewRow[]; total: number; copyright: string | null } {
  const cfg = applyPatch(base, patch);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => AUDIO_RE.test(f)).sort((a, b) => a.localeCompare(b, 'nb'));
  } catch {
    files = [];
  }
  const rows = files.slice(0, limit).map((f): PreviewRow => {
    const p = parseFlatName(f, cfg.titleCleanup);
    const rule = matchRule(cfg, f);
    return { file: f, title: p.clean.title, slug: p.slug, variant: rule?.variant || p.variant, kind: rule?.kind ?? 'etter lengde', removed: p.clean.removed, rule: rule?.pattern ?? null };
  });
  return { rows, total: files.length, copyright: formatCopyright(cfg.defaults.copyright, new Date().getFullYear(), cfg.defaults.label) };
}

/** Antall lydfiler i mappa (for advarselen før bytte av eksportmappe). Leser bare. */
export function countAudioFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => /\.(wav|aiff?|flac)$/i.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * «Bruk på alle låter nå»: regner paletten på nytt fra lagret cover med gjeldende fargeinnstillinger.
 * Låter med manuell farge (valgt i Studio) røres ikke. Lyden kodes ikke på nytt.
 */
export async function recolorAll(mediaDir: string, cfg: VaultConfig): Promise<{ changed: number; skipped: number }> {
  let changed = 0;
  let skipped = 0;
  const updates = new Map<string, AssetManifest>();
  for (const slug of await readdir(mediaDir, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    for (const variant of await readdir(path.join(mediaDir, slug.name), { withFileTypes: true }).catch(() => [])) {
      if (!variant.isDirectory()) continue;
      for (const v of await readdir(path.join(mediaDir, slug.name, variant.name), { withFileTypes: true }).catch(() => [])) {
        const dir = path.join(mediaDir, slug.name, variant.name, v.name);
        const mp = path.join(dir, 'manifest.json');
        if (!v.isDirectory() || v.name.endsWith('.partial') || !existsSync(mp)) continue;
        const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
        if (m.palette.source === 'manual') {
          skipped++;
          continue;
        }
        const palette = m.files.cover ? await paletteFrom(path.join(dir, m.files.cover), cfg.colors) : { ...FALLBACK_PALETTE };
        if (JSON.stringify(palette) === JSON.stringify(m.palette)) continue;
        const updated = { ...m, palette };
        await writeFile(mp, JSON.stringify(updated, null, 2));
        updates.set(m.id, updated);
        changed++;
      }
    }
  }
  // Indeksen har ikke fargene, men ny updatedAt får klientene til å hente manifestene på nytt
  const indexFile = path.join(mediaDir, 'index.json');
  if (updates.size && existsSync(indexFile)) {
    const idx = JSON.parse(await readFile(indexFile, 'utf8')) as { updatedAt?: string };
    idx.updatedAt = new Date().toISOString();
    await writeFile(indexFile, JSON.stringify(idx, null, 2));
  }
  return { changed, skipped };
}
