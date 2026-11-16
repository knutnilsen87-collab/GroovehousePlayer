import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { keyShort, sectionsOf, type AssetManifest, type CatalogIndex, type LearnEvent } from '@gv/shared';
import { writeJsonAtomic } from './markers-file';
import { findMaster } from './share';
import { readSources, sourceKey, sourcesFile } from './source-index';

/**
 * Del 17: eksport av planlagte sett (rekordbox XML og M3U) og enkel læring.
 * Eksporten peker på originalfila i eksportmappa (REASONDONE, via data/sources.json) når den finnes,
 * ellers på Vaults egen master i media/. Ingen filer kopieres eller endres.
 */

export interface ExportItem {
  slug: string;
  variant: string | null;
  version: number;
  /** Mikspunkter fra settbyggeren (ms i låta). */
  mixInMs?: number | null;
  mixOutMs?: number | null;
  bars?: number | null;
  /** Del 18: overgangs-preset ut av denne låta (hot cue på mikspunktet i presetets farge). */
  fxOut?: { name: string; color: string } | null;
  /** Del 18: preset på overgangen inn i denne låta (kommentar i M3U). */
  fxIn?: string | null;
  /** Del 18: presetstegene som skjer i denne låta, som navngitte memory cues. */
  fxCues?: Array<{ atMs: number; name: string }> | null;
}
export interface ResolvedItem {
  manifest: AssetManifest;
  file: string;
  mixInMs: number | null;
  mixOutMs: number | null;
  bars: number | null;
  fxOut?: { name: string; color: string } | null;
  fxIn?: string | null;
  fxCues?: Array<{ atMs: number; name: string }>;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** Rydder klientdata for del 18: navn maks 32 tegn, gyldige farger og tider, maks 16 cues. */
function cleanFx(it: ExportItem): Pick<ResolvedItem, 'fxOut' | 'fxIn' | 'fxCues'> {
  const fxOut = it.fxOut && typeof it.fxOut.name === 'string' ? { name: it.fxOut.name.slice(0, 32), color: HEX.test(String(it.fxOut.color)) ? it.fxOut.color : '#3CB4FF' } : null;
  const fxCues = (Array.isArray(it.fxCues) ? it.fxCues : [])
    .filter((c) => c && Number.isFinite(c.atMs) && c.atMs >= 0 && typeof c.name === 'string')
    .slice(0, 16)
    .map((c) => ({ atMs: Math.round(c.atMs), name: c.name.slice(0, 32) }));
  return { fxOut, fxIn: typeof it.fxIn === 'string' ? it.fxIn.slice(0, 40) : null, fxCues };
}

/** Finn manifest og lydfil for hver låt i settet. */
export async function resolveItems(mediaDir: string, exportDir: string | null, items: ExportItem[]): Promise<ResolvedItem[]> {
  const sources = (await readSources(sourcesFile(mediaDir))).entries;
  const out: ResolvedItem[] = [];
  for (const it of items) {
    const dir = path.join(mediaDir, it.slug, it.variant ?? 'main', `v${it.version}`);
    const mf = path.join(dir, 'manifest.json');
    if (!existsSync(mf)) throw new Error(`ukjent låt: ${it.slug} v${it.version}`);
    const manifest = JSON.parse(await readFile(mf, 'utf8')) as AssetManifest;
    const src = sources[sourceKey(it.slug, it.variant, it.version)];
    const original = src?.relPath && exportDir ? path.join(exportDir, src.relPath) : null;
    const file = original && existsSync(original) ? original : findMaster(dir);
    if (!file) throw new Error(`fant ingen lydfil for ${manifest.title}`);
    out.push({ manifest, file: path.resolve(file), mixInMs: it.mixInMs ?? null, mixOutMs: it.mixOutMs ?? null, bars: it.bars ?? null, ...cleanFx(it) });
  }
  return out;
}

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** file://localhost/F:/Musikk/Låt%20A.wav – rekordbox sitt format (prosentkodet sti, skråstreker). */
export function rekordboxLocation(file: string): string {
  const p = path.resolve(file).replace(/\\/g, '/');
  const enc = p
    .split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return `file://localhost/${enc.replace(/^\//, '')}`;
}
const kindOf = (file: string) => ({ '.wav': 'WAV File', '.flac': 'FLAC File', '.aif': 'AIFF File', '.aiff': 'AIFF File', '.mp3': 'MP3 File', '.m4a': 'M4A File' })[path.extname(file).toLowerCase()] ?? 'WAV File';
const sec = (ms: number) => (ms / 1000).toFixed(3);

/**
 * rekordbox XML (DJ_PLAYLISTS 1.0.0): én TRACK per låt i COLLECTION med tempo, toneart og mikspunktene
 * som hot cues (A = Mix inn, B = Mix ut) og memory cues, pluss en spilleliste med settets rekkefølge.
 */
export function rekordboxXml(name: string, items: ResolvedItem[]): string {
  const tracks = items
    .map((it, i) => {
      const m = it.manifest;
      const cues: string[] = [];
      const firstDownbeat = sectionsOf(m.markers)[0]?.startMs ?? 0;
      if (m.bpm) cues.push(`      <TEMPO Inizio="${sec(firstDownbeat)}" Bpm="${m.bpm.toFixed(2)}" Metro="4/4" Battito="1"/>`);
      if (it.mixInMs != null) {
        cues.push(`      <POSITION_MARK Name="Mix inn" Type="0" Start="${sec(it.mixInMs)}" Num="-1"/>`);
        cues.push(`      <POSITION_MARK Name="Mix inn" Type="0" Start="${sec(it.mixInMs)}" Num="0" Red="40" Green="226" Blue="20"/>`);
      }
      if (it.mixOutMs != null) {
        cues.push(`      <POSITION_MARK Name="Mix ut${it.bars ? ` (${it.bars} takter)` : ''}" Type="0" Start="${sec(it.mixOutMs)}" Num="-1"/>`);
        // Del 18: hot cue på mikspunktet i presetets farge og med presetets navn
        const [r, g, b] = it.fxOut ? rgb(it.fxOut.color) : [230, 40, 40];
        cues.push(`      <POSITION_MARK Name="${esc(it.fxOut ? it.fxOut.name : 'Mix ut')}" Type="0" Start="${sec(it.mixOutMs)}" Num="1" Red="${r}" Green="${g}" Blue="${b}"/>`);
      }
      // Del 18: hvert presetsteg som navngitt memory cue på riktig takt («Echo out · A ut»)
      for (const c of it.fxCues ?? []) cues.push(`      <POSITION_MARK Name="${esc(c.name)}" Type="0" Start="${sec(c.atMs)}" Num="-1"/>`);
      const attrs = [
        `TrackID="${i + 1}"`,
        `Name="${esc(m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title)}"`,
        `Artist="${esc(m.artist ?? 'Echo Groove')}"`,
        `Album="${esc(m.album ?? '')}"`,
        `Label="${esc(m.label ?? '')}"`,
        `Kind="${kindOf(it.file)}"`,
        `TotalTime="${Math.round(m.durationMs / 1000)}"`,
        `SampleRate="${m.sampleRate}"`,
        `AverageBpm="${(m.bpm ?? 0).toFixed(2)}"`,
        `Tonality="${esc(m.key ? keyShort(m.key.name) : '')}"`,
        `Comments="${esc(m.key ? `${m.key.camelot} · Groovehouse Vault` : 'Groovehouse Vault')}"`,
        `Location="${esc(rekordboxLocation(it.file))}"`
      ].join(' ');
      return cues.length ? `    <TRACK ${attrs}>\n${cues.join('\n')}\n    </TRACK>` : `    <TRACK ${attrs}/>`;
    })
    .join('\n');
  const keys = items.map((_, i) => `        <TRACK Key="${i + 1}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="Groovehouse Vault" Version="1.0.0" Company="Groovehouse Records"/>
  <COLLECTION Entries="${items.length}">
${tracks}
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Name="${esc(name)}" Type="1" KeyType="0" Entries="${items.length}">
${keys}
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
}

/** Utvidet M3U med varighet og «Artist - Tittel», og absolutte stier. */
export function m3u(name: string, items: ResolvedItem[]): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${name}`];
  for (const it of items) {
    const m = it.manifest;
    // Del 18: presetnavnet på overgangen inn som kommentarlinje
    if (it.fxIn) lines.push(`# Overgang inn: ${it.fxIn}`);
    lines.push(`#EXTINF:${Math.round(m.durationMs / 1000)},${m.artist ?? 'Echo Groove'} - ${m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title}`);
    lines.push(path.resolve(it.file));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Læring

export interface LearnFile {
  schema: 1;
  events: Array<LearnEvent & { at: string }>;
}
export async function readLearn(file: string): Promise<LearnFile> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as Partial<LearnFile>;
    return { schema: 1, events: Array.isArray(j.events) ? j.events : [] };
  } catch {
    return { schema: 1, events: [] };
  }
}
export async function addLearn(file: string, e: unknown): Promise<LearnFile> {
  const ev = e as LearnEvent;
  if (!ev || !['replace', 'move', 'remove'].includes(ev.type)) throw new Error('ugyldig hendelse');
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(5, x)) : 0);
  const parts = (p: unknown) => (p && typeof p === 'object' ? { harmonic: num((p as never)['harmonic']), tempo: num((p as never)['tempo']), mix: num((p as never)['mix']), lufs: num((p as never)['lufs']) } : undefined);
  const f = await readLearn(file);
  f.events = [...f.events, { type: ev.type, before: parts(ev.before), after: parts(ev.after), at: new Date().toISOString() }].slice(-500);
  await writeJsonAtomic(file, f);
  return f;
}

/** Overganger Knut faktisk har spilt i innspilte sett (kapitler med refSlug etter hverandre): «a→b». */
export async function recordedPairs(mediaDir: string): Promise<string[]> {
  const idxFile = path.join(mediaDir, 'index.json');
  if (!existsSync(idxFile)) return [];
  const idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
  const pairs = new Set<string>();
  for (const a of idx.assets.filter((x) => x.kind === 'set')) {
    try {
      const m = JSON.parse(await readFile(path.join(mediaDir, a.manifest), 'utf8')) as AssetManifest;
      const refs = sectionsOf(m.markers)
        .map((s) => s.refSlug)
        .filter((s): s is string => !!s);
      for (let i = 1; i < refs.length; i++) if (refs[i] !== refs[i - 1]) pairs.add(`${refs[i - 1]}→${refs[i]}`);
    } catch {
      /* hopp over */
    }
  }
  return [...pairs];
}
