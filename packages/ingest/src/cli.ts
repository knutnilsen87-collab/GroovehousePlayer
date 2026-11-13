#!/usr/bin/env node
import path from 'node:path';
import { formatTime } from '@gv/shared';
import { ingestFolder, type StepStatus } from './ingest';

const HELP = `
gh-ingest <mappe> [--media <dir>] [--force] [--offset <ms>]

  <mappe>        En release-mappe: <slug>/<slug>_v<N>.wav + valgfri cover.png/jpg,
                 live_log.json og meta.json
  --media <dir>  Hvor ferdige filer havner (standard: GH_MEDIA_DIR eller ./media)
  --force        Kjør på nytt selv om samme master allerede er prosessert
  --offset <ms>  Ekstra forskyvning av live-logg-markører
  --upload       (fase 2) Last opp til R2 og registrer i Supabase
`;

const ICON: Record<StepStatus, string> = { start: '…', ok: '✓', skip: '↷', warn: '!' };

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const folder = args.find((a, i) => !a.startsWith('--') && !['--media', '--offset'].includes(args[i - 1] ?? ''));
  if (!folder) throw new Error('Mangler mappe');
  if (args.includes('--upload')) {
    console.log('! --upload er fase 2 (R2 + Supabase). Kjører kun lokal prosessering nå.');
  }
  // Kjøres via pnpm --filter, så cwd er pakkemappa: løs relative stier mot der kommandoen ble startet.
  const base = process.env.INIT_CWD ?? process.cwd();
  const mediaDir = path.resolve(base, flag('--media') ?? process.env.GH_MEDIA_DIR ?? 'media');
  const t0 = Date.now();

  const results = await ingestFolder(path.resolve(base, folder), {
    mediaDir,
    force: args.includes('--force'),
    offsetMs: flag('--offset') ? Number(flag('--offset')) : 0,
    report: (step, status, detail) => {
      if (status === 'start') return;
      console.log(`  ${ICON[status]} ${step.padEnd(10)} ${detail ?? ''}`);
    }
  });

  console.log('');
  for (const res of results) {
    const m = res.manifest;
    const extra = [m.variantLabel, `v${m.version}`, formatTime(m.durationMs), m.bpm ? `${m.bpm} BPM` : null, m.key?.camelot].filter(Boolean).join(' · ');
    console.log(`${res.status === 'ingested' ? '✓ Ferdig' : '↷ Uendret'}: ${m.title} (${m.kind}) ${extra}`);
    console.log(`  → ${res.outDir}`);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s totalt`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
