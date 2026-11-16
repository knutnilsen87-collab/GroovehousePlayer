#!/usr/bin/env node
/**
 * pnpm vault:backup [--dry] [--to <mappe>]
 *
 * Speiler prosjektet (kode, .git, data/ og media/) fra arbeidsmappa på F: til backup på H:.
 * Det jobbes BARE i F:\prosjekter_MAIN\GroovehousePlayer. H:\GroovehousePlayer er kun backup.
 *
 *  - robocopy /MIR: backupen blir en eksakt kopi. Filer som er slettet på F:, slettes også på H:.
 *  - Hopper over node_modules, .gradle og build-mapper (kan lages på nytt med pnpm install / bygg).
 *  - --dry viser hva som ville blitt kopiert og slettet, uten å endre noe.
 *  - Nekter å kjøre hvis kilden ikke er arbeidsmappa på F:, eller hvis mål og kilde er like.
 *  - Leser bare fra F:. Skriver bare under målmappa.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const toArg = args.indexOf('--to');
const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.resolve(toArg >= 0 ? args[toArg + 1] ?? '' : 'H:\\GroovehousePlayer');
const EXCLUDE_DIRS = ['node_modules', '.gradle', 'build', '.turbo', '.vite'];

const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
if (process.platform !== 'win32') fail('vault:backup bruker robocopy og kjører bare på Windows.');
if (!/^f:\\/i.test(SOURCE)) fail(`Kilden må være arbeidsmappa på F: (er ${SOURCE}). Kjør fra F:\\prosjekter_MAIN\\GroovehousePlayer, ikke fra backupen.`);
if (SOURCE.toLowerCase() === TARGET.toLowerCase()) fail('Kilde og mål er samme mappe.');
if (TARGET.toLowerCase().startsWith(SOURCE.toLowerCase() + path.sep)) fail('Målet kan ikke ligge inni prosjektet.');
const drive = TARGET.slice(0, 3);
if (!existsSync(drive)) fail(`${drive} finnes ikke (er backup-disken koblet til?).`);
if (!existsSync(path.join(SOURCE, 'package.json')) || !existsSync(path.join(SOURCE, '.git'))) fail('Fant ikke prosjektet (package.json og .git) i kilden.');
if (!dry) mkdirSync(TARGET, { recursive: true });

const rc = [
  SOURCE,
  TARGET,
  '/MIR', // speil (inkl. sletting av filer som ikke finnes i kilden)
  '/XD',
  ...EXCLUDE_DIRS,
  '/XJ', // ikke følg koblinger (pnpm bruker dem i node_modules)
  '/FFT', // tidsstempel-toleranse (FAT/exFAT/nettverksdisker)
  '/DCOPY:T',
  '/R:1',
  '/W:2',
  '/MT:8',
  '/NP',
  '/NDL',
  ...(dry ? ['/L', '/NJH'] : ['/NFL', '/NJH'])
];
console.log(`${dry ? 'Prøvekjøring (ingenting endres)' : 'Backup'}: ${SOURCE} → ${TARGET}`);
console.log(`Hopper over: ${EXCLUDE_DIRS.join(', ')}\n`);
const t0 = Date.now();
const r = spawnSync('robocopy', rc, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
if (dry) {
  // Vis det viktigste: filer som ville blitt slettet på backupen, og oppsummeringen
  const lines = out.split(/\r?\n/);
  const extras = lines.filter((l) => /\*EXTRA (File|Dir)/i.test(l)).map((l) => l.trim());
  const news = lines.filter((l) => /^\s*(New File|Newer|Older|Changed)\b/i.test(l)).length;
  console.log(`Ville kopiert/oppdatert: ${news} filer`);
  console.log(`Ville slettet på backupen: ${extras.length} (finnes ikke lenger på F:)`);
  for (const l of extras.slice(0, 40)) console.log(`  ${l}`);
  if (extras.length > 40) console.log(`  … og ${extras.length - 40} til`);
}
const summary = out.split(/\r?\n/).filter((l) => /^\s*(Dirs|Files|Bytes|Times|Kataloger|Filer|Byte|Tider)\s*:/i.test(l));
if (summary.length) console.log(`\n${summary.join('\n')}`);
// robocopy: 0–7 = OK (1 = kopiert, 2 = ekstra filer, 4 = avvik), 8+ = feil
const code = r.status ?? 16;
if (code >= 8) fail(`robocopy feilet (kode ${code}). Se utskriften over.`);
console.log(`\n\x1b[32m✓ ${dry ? 'Prøvekjøring ferdig' : 'Backup ferdig'} på ${((Date.now() - t0) / 1000).toFixed(1)} s (robocopy-kode ${code})\x1b[0m`);
