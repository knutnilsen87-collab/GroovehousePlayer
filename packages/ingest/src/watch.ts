#!/usr/bin/env node
import path from 'node:path';
import { findRoot, loadConfig, loadDotEnv } from './config';
import { startWatcher } from './watcher';

/** gh-watch: watcheren i forgrunnen (apps/server kjører den samme modulen i bakgrunnen). */
const root = findRoot();
loadDotEnv(root);
const config = loadConfig(root);
const base = process.env.INIT_CWD ?? process.cwd();
const exportDir = path.resolve(base, process.argv[2] ?? process.env.GH_EXPORT_DIR ?? 'fixtures');
const mediaDir = path.resolve(base, process.env.GH_MEDIA_DIR ?? path.join(root, 'media'));

console.log(`Watcher aktiv (leser bare – flytter eller endrer aldri noe i eksportmappa)\n  eksport: ${exportDir}\n  media:   ${mediaDir}\n  Filer som lå der fra før: kjør «pnpm gh-ingest --backlog»\n  (Ctrl+C for å stoppe)`);
startWatcher({
  exportDir,
  mediaDir,
  config,
  log: (line) => console.log(line.includes('SUNO') ? `\x1b[33;1m${line}\x1b[0m` : line)
});
