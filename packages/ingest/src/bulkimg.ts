import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetManifest, CatalogIndex } from '@gv/shared';
import { findRoot, type VaultConfig } from './config';
import { coverInputOf, overlayCoverText, vaultCoverLogo } from './vault-cover';
import { setAssetCover } from './ingest';
import { overridePath, readOverrides, type MetaFile } from './sources';

/**
 * Del 23 nivå 2: AI-cover via bulkIMG / AURORA Asset Studio (Knuts lokale bildeverktøy). Løs kobling:
 *  1. Vault skriver en CSV i bulkIMGs batchformat (`section,category,filename,prompt`, UTF-8 med BOM)
 *     til innboksen. Filnavn: `<slug>__<variant|main>.png`.
 *  2. Knut kjører batchen i bulkIMG, sammenligner generatorene, velger vinneren og eksporterer.
 *  3. Vault leser nye eksporter (undermapper med manifest.json) i eksportmappa, kobler bildene til låta
 *     via filnavnet og legger dem inn som ekte cover (paletten regnes ut på nytt).
 *  4. Prompt, leverandør og modell hentes fra bulkIMGs run-data (generated/runs/<runId>/assets.json),
 *     fordi eksportmanifestet ikke har dem, og lagres i media/<slug>/meta.json. bulkIMG lagrer ikke frø.
 *
 * Vault endrer aldri noe i bulkIMG: den skriver bare CSV-er i innboksen og leser eksporter og run-data.
 * Bare filnavn Vault selv har sendt, og som ikke er mottatt ennå, tas imot (gamle eksporter ignoreres).
 */

export const FILE_RE = /^([a-z0-9][a-z0-9-]{0,120})__([a-z0-9][a-z0-9-]{0,40})(?:_\d+)?\.png$/i;
export const coverFileName = (slug: string, variant: string | null) => `${slug}__${variant ?? 'main'}.png`;
/** Varsel når noe er sendt og ingenting er kommet tilbake. */
export const OVERDUE_MS = 24 * 60 * 60 * 1000;

export interface SentCover {
  slug: string;
  variant: string | null;
  title: string;
  filename: string;
  prompt: string;
  csv: string;
  sentAt: string;
}
export interface ReceivedCover {
  slug: string;
  variant: string | null;
  filename: string;
  file: string;
  exportId: string | null;
  providerId: string | null;
  model: string | null;
  prompt: string | null;
  receivedAt: string;
}
export interface AiCoverLedger {
  schema: 1;
  sent: SentCover[];
  received: ReceivedCover[];
  /** Eksportmanifester som er lest (sti → mtime), så de ikke leses på nytt. */
  seen: Record<string, number>;
  /** Når varselet om 24 timer sist ble sendt (ett varsel per forsendelse). */
  warnedFor?: string[];
}

const ledgerFile = (dataDir: string) => path.join(dataDir, 'ai-covers.json');
async function readLedger(dataDir: string): Promise<AiCoverLedger> {
  try {
    const j = JSON.parse(await readFile(ledgerFile(dataDir), 'utf8')) as AiCoverLedger;
    return { schema: 1, sent: j.sent ?? [], received: j.received ?? [], seen: j.seen ?? {}, warnedFor: j.warnedFor ?? [] };
  } catch {
    return { schema: 1, sent: [], received: [], seen: {}, warnedFor: [] };
  }
}
async function writeLedger(dataDir: string, l: AiCoverLedger) {
  await mkdir(dataDir, { recursive: true });
  const f = ledgerFile(dataDir);
  await writeFile(`${f}.tmp`, JSON.stringify(l, null, 2) + '\n', 'utf8');
  await rename(`${f}.tmp`, f);
}
let chain: Promise<unknown> = Promise.resolve();
/** Én endring i loggen om gangen (sending og mottak kan skje samtidig). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------- prompt

/** Stilmaler (punkt 5). Ingen tekst, personer, logoer eller andre artister i bildet. */
export const COVER_STYLES: Record<string, { name: string; prompt: string }> = {
  'echo-groove-nights': {
    name: 'Echo Groove Nights',
    prompt: 'deep night-purple atmosphere, hot magenta and electric violet neon glow, a large soft moon reflected on still water, chrome and glass details, cinematic haze, premium house-music aesthetic'
  },
  minimal: {
    name: 'Minimal studio',
    prompt: 'minimal abstract composition, dark matte background, one bold geometric light form, subtle grain, premium deep-house aesthetic'
  }
};
export const DEFAULT_STYLE = 'echo-groove-nights';

const STOP = new Set('the a an and or but to of in on at for with my your our you me we i it is are was be so all just like this that from up down out no not oh yeah na la da do get got let can will its im dont'.split(' '));

/** Tema fra sangteksten: de vanligste innholdsordene (ingen hele linjer). */
export function lyricThemes(text: string | null | undefined, n = 5): string[] {
  if (!text) return [];
  const words = text
    .replace(/\[[^\]]*\]|<[^>]*>/g, ' ')
    .toLowerCase()
    .match(/[a-zæøå']{4,}/g) ?? [];
  const count = new Map<string, number>();
  for (const w of words) if (!STOP.has(w.replace(/'/g, ''))) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([w]) => w);
}

/** Bygger prompten automatisk av tittel, stemning (energi, dur/moll, BPM), sangtekst og stilmal. */
export function buildCoverPrompt(m: AssetManifest, o: { energy?: number | null; lyrics?: string | null; style?: string } = {}): string {
  const style = COVER_STYLES[o.style ?? DEFAULT_STYLE] ?? COVER_STYLES[DEFAULT_STYLE]!;
  const minor = /A$/i.test(m.key?.camelot ?? '');
  const e = o.energy ?? m.energy ?? null;
  const energy = e == null ? 'steady, hypnotic energy' : e >= 7 ? 'high, euphoric peak-time energy' : e >= 4 ? 'driving, warm groove energy' : 'calm, late-night low energy';
  const bpm = m.bpm ? `${Math.round(m.bpm)} BPM` : 'house tempo';
  const mood = m.key ? (minor ? 'moody, introspective, minor-key feeling' : 'uplifting, bright, major-key feeling') : 'atmospheric feeling';
  const themes = lyricThemes(o.lyrics);
  return [
    `Square 1:1 album cover artwork for an electronic house track titled "${m.title}".`,
    `Mood: ${mood}, ${energy}, ${bpm}.`,
    themes.length ? `Visual themes inspired by: ${themes.join(', ')}.` : null,
    `Style: ${style.prompt}.`,
    'Absolutely no text, letters, numbers, typography or watermarks in the image.',
    'No recognizable real people, no celebrity likenesses, no brand logos, no references to other artists or existing album covers.',
    'High detail, centered composition with calm space in the lower third for a title overlay.'
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------- CSV ut

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

/**
 * Skriver CSV i bulkIMGs format til innboksen og noterer forsendelsen. `items` = låtene som skal ha AI-cover.
 * Returnerer stien til CSV-en.
 */
export async function sendToBulkImg(opts: {
  cfg: VaultConfig;
  dataDir: string;
  items: Array<{ manifest: AssetManifest; prompt: string }>;
  now?: Date;
}): Promise<{ csv: string; count: number }> {
  if (!opts.items.length) throw new Error('ingen låter å sende');
  const inbox = opts.cfg.covers.bulkimgInbox;
  await mkdir(inbox, { recursive: true });
  const now = opts.now ?? new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  // Én rad per låt+variant (siste prompt vinner)
  const rows = new Map<string, { manifest: AssetManifest; prompt: string }>();
  for (const it of opts.items) rows.set(coverFileName(it.manifest.slug, it.manifest.variant), it);
  let csvPath = path.join(inbox, `groovehouse-${stamp}-${rows.size}-laater.csv`);
  for (let n = 2; existsSync(csvPath); n++) csvPath = path.join(inbox, `groovehouse-${stamp}-${rows.size}-laater-${n}.csv`);
  const lines = ['section,category,filename,prompt', ...[...rows.entries()].map(([file, it]) => [csvCell('GROOVEHOUSE'), csvCell('Album Cover'), csvCell(file), csvCell(it.prompt)].join(','))];
  await writeFile(csvPath, '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  await serial(async () => {
    const l = await readLedger(opts.dataDir);
    for (const [file, it] of rows) {
      l.sent = l.sent.filter((s) => s.filename !== file || l.received.some((r) => r.filename === file && r.receivedAt > s.sentAt));
      l.sent.push({ slug: it.manifest.slug, variant: it.manifest.variant, title: it.manifest.title, filename: file, prompt: it.prompt, csv: csvPath, sentAt: now.toISOString() });
    }
    await writeLedger(opts.dataDir, l);
  });
  return { csv: csvPath, count: rows.size };
}

// ---------------------------------------------------------------- eksporter inn

interface ExportManifest {
  exportId?: string;
  runId?: string;
  files?: Array<{ filename?: string; exportedFilename?: string; path?: string; candidateId?: string }>;
}
interface RunAsset {
  candidateId?: string;
  filename?: string;
  prompt?: string;
  providerId?: string;
  model?: string;
}

/** Prompt, leverandør og modell fra bulkIMGs run-data (<arbeidsmappe>/generated/runs/<runId>/assets.json). */
async function runInfo(exportsRoot: string, runId: string | undefined, candidateId: string | undefined): Promise<Pick<ReceivedCover, 'providerId' | 'model' | 'prompt'>> {
  const none = { providerId: null, model: null, prompt: null };
  if (!runId || !/^[\w-]{1,120}$/.test(runId)) return none;
  const f = path.join(path.dirname(path.resolve(exportsRoot)), 'generated', 'runs', runId, 'assets.json');
  try {
    const assets = JSON.parse(await readFile(f, 'utf8')) as RunAsset[];
    const a = assets.find((x) => x.candidateId === candidateId);
    return a ? { providerId: a.providerId ?? null, model: a.model ?? null, prompt: a.prompt ?? null } : none;
  } catch {
    return none;
  }
}

/**
 * Leser nye eksporter i bulkIMGs eksportmappe og legger inn cover for filnavn Vault har sendt.
 * Kalles ved oppstart og jevnlig av serveren (og fra CLI). Returnerer det som ble tatt imot.
 */
export async function receiveFromBulkImg(opts: { cfg: VaultConfig; mediaDir: string; dataDir: string; log?: (l: string) => void }): Promise<ReceivedCover[]> {
  const root = opts.cfg.covers.bulkimgExports;
  if (!existsSync(root)) return [];
  const got: ReceivedCover[] = [];
  return serial(async () => {
    const l = await readLedger(opts.dataDir);
    const pending = new Map(l.sent.filter((s) => !l.received.some((r) => r.filename === s.filename && r.receivedAt >= s.sentAt)).map((s) => [s.filename.toLowerCase(), s]));
    if (!pending.size) return got;
    for (const d of await readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const mp = path.join(root, d.name, 'manifest.json');
      if (!existsSync(mp)) continue;
      const mtime = (await stat(mp)).mtimeMs;
      if (l.seen[mp] === mtime) continue;
      let man: ExportManifest;
      try {
        man = JSON.parse(await readFile(mp, 'utf8')) as ExportManifest;
      } catch {
        continue; // halvskrevet manifest: prøv igjen neste gang
      }
      for (const f of man.files ?? []) {
        const exported = f.exportedFilename ?? f.filename ?? (f.path ? path.basename(f.path) : '');
        const mm = FILE_RE.exec(exported);
        if (!mm) continue;
        const base = `${mm[1]}__${mm[2]}.png`.toLowerCase();
        const sent = pending.get(base);
        // Bare eksporter laget etter forsendelsen (en eldre eksport med samme navn tas ikke imot)
        if (!sent || mtime < Date.parse(sent.sentAt)) continue;
        const file = path.join(root, d.name, exported);
        // Bildet må ligge i eksportmappa (aldri følg stier ut av den)
        if (!existsSync(file) || path.relative(root, file).startsWith('..')) continue;
        try {
          // Vault legger tittel og artist oppå (AI-bildet er uten tekst) og skalerer til 3000×3000 RGB
          const m = await latestManifest(opts.mediaDir, sent.slug, sent.variant);
          const img = await readFile(file);
          const withText = m ? await overlayCoverText(img, coverInputOf(m, null), { logo: vaultCoverLogo(findRoot(opts.mediaDir)) }) : img;
          await setAssetCover(opts.mediaDir, sent.slug, withText, opts.cfg);
          // 3000×3000 RGB til release-bruk (punkt 10); spilleren bruker cover.jpg (1200 px)
          await writeFile(path.join(path.resolve(opts.mediaDir), sent.slug, 'cover_ai.png'), withText);
          const info = await runInfo(root, man.runId, f.candidateId);
          const rec: ReceivedCover = { slug: sent.slug, variant: sent.variant, filename: sent.filename, file, exportId: man.exportId ?? null, ...info, prompt: info.prompt ?? sent.prompt, receivedAt: new Date().toISOString() };
          await markAi(opts.mediaDir, rec);
          l.received.push(rec);
          pending.delete(base);
          got.push(rec);
          opts.log?.(`🎨 AI-cover fra bulkIMG: ${sent.title} (${info.providerId ?? 'ukjent leverandør'}${info.model ? ` · ${info.model}` : ''})`);
        } catch (err) {
          opts.log?.(`  ✗ AI-cover for ${sent.title}: ${err instanceof Error ? err.message : err}`);
        }
      }
      l.seen[mp] = mtime;
    }
    await writeLedger(opts.dataDir, l);
    return got;
  });
}

async function latestManifest(mediaDir: string, slug: string, variant: string | null): Promise<AssetManifest | null> {
  try {
    const idx = JSON.parse(await readFile(path.join(path.resolve(mediaDir), 'index.json'), 'utf8')) as CatalogIndex;
    const a = idx.assets.filter((x) => x.slug === slug && (x.variant ?? null) === variant).sort((x, y) => y.version - x.version)[0] ?? idx.assets.find((x) => x.slug === slug);
    return a ? (JSON.parse(await readFile(path.join(path.resolve(mediaDir), a.manifest), 'utf8')) as AssetManifest) : null;
  } catch {
    return null;
  }
}

/** Lagrer prompt/leverandør/modell i meta.json (punkt 9) og merker manifestene som AI-generert cover. */
async function markAi(mediaDir: string, rec: ReceivedCover) {
  const meta: MetaFile = { ...(await readOverrides(mediaDir, rec.slug)), aiCover: { source: 'bulkimg', provider: rec.providerId, model: rec.model, prompt: rec.prompt, seed: null, exportId: rec.exportId, receivedAt: rec.receivedAt } };
  await writeFile(overridePath(mediaDir, rec.slug), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  const root = path.join(path.resolve(mediaDir), rec.slug);
  const idxFile = path.join(path.resolve(mediaDir), 'index.json');
  const idx = JSON.parse(await readFile(idxFile, 'utf8')) as CatalogIndex;
  for (const a of idx.assets.filter((x) => x.slug === rec.slug)) {
    const mp = path.join(path.resolve(mediaDir), a.manifest);
    if (!existsSync(mp) || !mp.startsWith(root)) continue;
    const m = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
    await writeFile(mp, JSON.stringify({ ...m, coverSource: 'ai', coverAi: { provider: rec.providerId, model: rec.model } } satisfies AssetManifest, null, 2));
  }
}

// ---------------------------------------------------------------- status

export interface AiCoverStatus {
  inbox: string;
  exports: string;
  exportsFound: boolean;
  sent: number;
  received: number;
  /** Sendt, ikke mottatt. */
  waiting: Array<{ slug: string; title: string; sentAt: string; overdue: boolean }>;
  /** Noe sendt for mer enn 24 timer siden, og ingenting kommet tilbake siden. */
  overdue: boolean;
}
export async function bulkImgStatus(cfg: VaultConfig, dataDir: string, now = Date.now()): Promise<AiCoverStatus> {
  const l = await readLedger(dataDir);
  const waiting = l.sent
    .filter((s) => !l.received.some((r) => r.filename === s.filename && r.receivedAt >= s.sentAt))
    .map((s) => ({ slug: s.slug, title: s.title, sentAt: s.sentAt, overdue: now - Date.parse(s.sentAt) > OVERDUE_MS }));
  const lastReceived = Math.max(0, ...l.received.map((r) => Date.parse(r.receivedAt)));
  return {
    inbox: cfg.covers.bulkimgInbox,
    exports: cfg.covers.bulkimgExports,
    exportsFound: existsSync(cfg.covers.bulkimgExports),
    sent: l.sent.length,
    received: l.received.length,
    waiting,
    overdue: waiting.some((w) => w.overdue && Date.parse(w.sentAt) > lastReceived)
  };
}

/** Forsendelser som har passert 24 timer uten svar og ikke er varslet før (serveren viser Windows-varsel). */
export async function takeOverdueWarnings(cfg: VaultConfig, dataDir: string, now = Date.now()): Promise<string[]> {
  return serial(async () => {
    const st = await bulkImgStatus(cfg, dataDir, now);
    if (!st.overdue) return [];
    const l = await readLedger(dataDir);
    const fresh = st.waiting.filter((w) => w.overdue && !l.warnedFor!.includes(`${w.slug}@${w.sentAt}`));
    if (!fresh.length) return [];
    l.warnedFor = [...l.warnedFor!, ...fresh.map((w) => `${w.slug}@${w.sentAt}`)].slice(-500);
    await writeLedger(dataDir, l);
    return fresh.map((w) => w.title);
  });
}
