#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { findSuno, formatTime, type AssetManifest } from '@gv/shared';
import { findRoot, loadConfig, loadDotEnv } from './config';
import { ingestFolder, ingestRelease, sha256File, type IngestResult, type StepStatus } from './ingest';
import { backfillMasters } from './share';
import { indexSources, readSources, sourcesFile } from './source-index';
import { readOverrides, scanFlat, type ReleaseSource } from './sources';

const HELP = `
gh-ingest <mappe|fil> [--media <dir>] [--force] [--offset <ms>]
gh-ingest --backlog [<eksportmappe>] [--skip <slug,slug>] [--yes] [--force]

  <mappe>        En release-mappe: <slug>/<slug>_v<N>.wav + valgfri cover.png/jpg,
                 live_log.json og meta.json
  <fil>          Én lydfil i en flat eksportmappe (cover = samme navn .png/.jpg)
  --backlog      Ingest alt som ligger i den flate eksportmappa (standard: GH_EXPORT_DIR).
  --index-sources Koble allerede ingestede låter til kildefila (hash, kun lesing) → data/sources.json
  --backfill-masters Lag Vaults egen master-kopi (FLAC) for låter ingestet før del 10 (kun lesing i eksportmappa)
                 Viser lista først. Eksportmappa leses bare – ingenting flyttes eller endres.
  --skip <slugs> Hopp over disse (kommaseparert), f.eks. --skip midnight-rendezvous
  --yes          Start uten å spørre (backlog)
  --media <dir>  Hvor ferdige filer havner (standard: GH_MEDIA_DIR eller ./media)
  --force        Kjør på nytt selv om samme master allerede er prosessert
  --offset <ms>  Ekstra forskyvning av live-logg-markører
  --upload       (fase 2) Last opp til R2 og registrer i Supabase
`;

const ICON: Record<StepStatus, string> = { start: '…', ok: '✓', skip: '↷', warn: '!' };
const report = (step: string, status: StepStatus, detail?: string) => {
  if (status === 'start') return;
  const line = `  ${ICON[status]} ${step.padEnd(10)} ${detail ?? ''}`;
  if (step === 'SUNO') console.log(`\x1b[33;1m${line}\x1b[0m`);
  else console.log(line);
};

async function main() {
  const root = findRoot();
  loadDotEnv(root);
  const cfg = loadConfig(root);
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const valueFlags = ['--media', '--offset', '--skip'];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const target = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1] ?? ''));
  if (args.includes('--upload')) console.log('! --upload er fase 2 (R2 + Supabase). Kjører kun lokal prosessering nå.');
  // Kjøres via pnpm --filter, så cwd er pakkemappa: løs relative stier mot der kommandoen ble startet.
  const base = process.env.INIT_CWD ?? process.cwd();
  const mediaDir = path.resolve(base, flag('--media') ?? process.env.GH_MEDIA_DIR ?? path.join(root, 'media'));
  const force = args.includes('--force');
  const t0 = Date.now();
  let results: IngestResult[] = [];

  if (args.includes('--index-sources')) {
    // Engangskjøring: koble ingestede versjoner til kildefila i eksportmappa via hash (kun lesing der).
    const dir = path.resolve(base, target ?? loadConfig().exportDir ?? '');
    if (!target && !loadConfig().exportDir) throw new Error('Mangler eksportmappe: velg eksportmappe i Studio → Innstillinger, sett GH_EXPORT_DIR i .env eller oppgi mappa');
    console.log(`Leser ${dir} (kun lesing) og matcher på hash …`);
    const r = await indexSources({ exportDir: dir, mediaDir, force, onFile: (n) => process.stdout.write(`  · ${n}\n`) });
    for (const m of r.matched) console.log(`  ✓ ${m.key}  ←  ${m.fileName}`);
    for (const k of r.missing) console.log(`  ! ${k}: fant ingen fil med samme hash (endret eller flyttet etter ingest?)`);
    for (const s of r.skipped) console.log(`  ↷ ${s.fileName}: kunne ikke leses (${s.reason}) – hoppet over`);
    console.log(`\n${r.matched.length} koblet, ${r.missing.length} uten treff, ${r.scanned} filer lest. Lagret i data/sources.json (gitignored).`);
    return;
  }

  if (args.includes('--backfill-masters')) {
    // Del 10: Vaults egen tapsfrie kopi (master.flac) for låter ingestet før dette fantes.
    // Leser eksportmappa (kun lesing) via data/sources.json, og bare hvis hashen fortsatt stemmer.
    const dir = path.resolve(base, target ?? loadConfig().exportDir ?? '');
    if (!target && !loadConfig().exportDir) throw new Error('Mangler eksportmappe: velg eksportmappe i Studio → Innstillinger, sett GH_EXPORT_DIR i .env eller oppgi mappa');
    const sources = (await readSources(sourcesFile(mediaDir))).entries;
    const r = await backfillMasters({
      mediaDir,
      exportDir: dir,
      sources,
      sha256: sha256File,
      onItem: (key, status, detail) => {
        if (status === 'made') console.log(`  ✓ ${key}  ←  ${detail}`);
        else if (status === 'nosource') console.log(`  ! ${key}: ingen kjent kildefil (kjør «--index-sources» først, eller ingest på nytt)`);
        else if (status === 'changed') console.log(`  ! ${key}: «${detail}» er endret siden ingest – ingest den på nytt for å få riktig master`);
      }
    });
    console.log(`\n${r.made} master-kopier laget, ${r.missing} mangler kilde. Eksportmappa er ikke endret.`);
    return;
  }

  if (args.includes('--backlog')) {
    const dir = path.resolve(base, target ?? loadConfig().exportDir ?? '');
    if (!target && !loadConfig().exportDir) throw new Error('Mangler eksportmappe: velg eksportmappe i Studio → Innstillinger, sett GH_EXPORT_DIR i .env eller oppgi mappa');
    const skip = new Set((flag('--skip') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const scan = await scanFlat(dir, cfg);
    const plan = await planBacklog(scan.releases, mediaDir, skip, force);
    printPlan(dir, plan, scan.ignored, scan.orphanImages);
    const todo = plan.filter((p) => p.action === 'ingest').map((p) => p.release);
    const unique = [...new Map(todo.map((r) => [r.slug, r])).values()];
    if (unique.length === 0) {
      console.log('\nIngenting nytt å ingeste.');
      return;
    }
    if (!args.includes('--yes')) {
      if (!process.stdin.isTTY) {
        console.log('\nKjør igjen med --yes for å starte.');
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`\nIngeste ${unique.length} låt(er)? (j/N) `);
      rl.close();
      if (!/^(j|ja|y|yes)$/i.test(answer.trim())) return;
    }
    for (const r of unique) {
      console.log(`\n── ${r.masters[0]!.fileName}`);
      try {
        results.push(...(await ingestRelease(r, { mediaDir, force, config: cfg, report })));
      } catch (err) {
        console.error(`  ✗ ${err instanceof Error ? err.message.split('\n')[0] : err}`);
      }
    }
  } else {
    if (!target) throw new Error('Mangler mappe eller fil');
    const abs = path.resolve(base, target);
    if (!existsSync(abs)) throw new Error(`Finnes ikke: ${abs}`);
    if (statSync(abs).isFile()) {
      const scan = await scanFlat(path.dirname(abs), cfg);
      const release = scan.releases.find((r) => r.masters.some((m) => m.path === abs));
      if (!release) throw new Error(`Ikke en lydfil, eller en eldre versjon: ${abs}`);
      results = await ingestRelease(release, { mediaDir, force, config: cfg, report });
    } else {
      results = await ingestFolder(abs, { mediaDir, force, config: cfg, offsetMs: flag('--offset') ? Number(flag('--offset')) : 0, report });
    }
  }

  console.log('');
  for (const res of results) {
    const m = res.manifest;
    const extra = [m.variantLabel, `v${m.version}`, formatTime(m.durationMs), m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot].filter(Boolean).join(' · ');
    const word = res.status === 'ingested' ? '✓ Ferdig' : res.status === 'retagged' ? '✓ Tags oppdatert' : '↷ Uendret';
    console.log(`${word}: ${m.title} (${m.kind}) ${extra}`);
    console.log(`  → ${res.outDir}`);
    if (res.suno.length) console.log(`\x1b[33;1m  ! «suno» funnet og fjernet (${res.suno.length})\x1b[0m`);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s totalt`);
}

interface PlanRow {
  release: ReleaseSource;
  file: string;
  slug: string;
  title: string;
  variant: string | null;
  version: number;
  action: 'ingest' | 'done' | 'skip';
  notes: string[];
}

async function planBacklog(releases: ReleaseSource[], mediaDir: string, skip: Set<string>, force: boolean): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  for (const r of releases) {
    const overrides = await readOverrides(mediaDir, r.slug);
    for (const m of r.masters) {
      const notes: string[] = [];
      if (overrides.title) notes.push(`tittel overstyrt i Studio (filnavnet gir «${m.titleFromFile}»)`);
      else if (m.wasAllCaps) notes.push('versaler i filnavnet – sjekk tittelen i Studio');
      if (m.bpmHint) notes.push(`BPM-hint ${m.bpmHint}`);
      if (m.removed.length) notes.push(`fjernet: ${m.removed.join(', ')}`);
      if (findSuno(m.fileName).length) notes.push('SUNO i filnavnet');
      if (!r.coverPath) notes.push('ingen cover → gull');
      else notes.push(`cover: ${path.basename(r.coverPath)}`);
      let action: PlanRow['action'] = 'ingest';
      if (skip.has(r.slug)) action = 'skip';
      else if (!force) {
        const mp = path.join(mediaDir, m.slug, m.variant ?? 'main', `v${m.version}`, 'manifest.json');
        if (existsSync(mp)) {
          const existing = JSON.parse(await readFile(mp, 'utf8')) as AssetManifest;
          if (existing.masterSha256 === (await sha256File(m.path))) action = 'done';
        }
      }
      rows.push({ release: r, file: m.fileName, slug: m.slug, title: overrides.title ?? m.titleFromFile, variant: m.variant, version: m.version, action, notes });
    }
    for (const old of r.olderVersions) rows.push({ release: r, file: old, slug: r.slug, title: '', variant: null, version: 0, action: 'skip', notes: ['eldre versjon'] });
  }
  return rows;
}

function printPlan(dir: string, rows: PlanRow[], ignored: string[], orphans: string[]) {
  const label = { ingest: 'TAS MED', done: 'finnes ', skip: 'hoppes ' } as const;
  console.log(`\nBacklog i ${dir} (leses bare – ingenting flyttes eller endres)\n`);
  const w = Math.min(48, Math.max(...rows.map((r) => r.file.length), 4));
  for (const r of rows) {
    const what = r.title ? `${r.slug}${r.variant ? ` [${r.variant}]` : ''}${r.version > 1 ? ` v${r.version}` : ''} → «${r.title}»` : '';
    console.log(`  ${label[r.action]}  ${r.file.padEnd(w)}  ${what}`);
    for (const n of r.notes) console.log(`  ${' '.repeat(9)}${' '.repeat(w)}    · ${n}`);
  }
  if (ignored.length) console.log(`\n  Ignoreres (ikke lyd): ${ignored.join(', ')}`);
  if (orphans.length) console.log(`  Bilder uten lydfil: ${orphans.join(', ')}`);
  const n = rows.filter((r) => r.action === 'ingest').length;
  console.log(`\n  ${n} tas med · ${rows.filter((r) => r.action === 'done').length} finnes fra før · ${rows.filter((r) => r.action === 'skip').length} hoppes over`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
