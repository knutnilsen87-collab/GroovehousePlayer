import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Enkel logg med rotering: server.log → server.1.log → … → server.<keep>.log.
 * Synkron skriving, så ingenting går tapt hvis prosessen dør (og volumet er lite).
 */
export interface Logger {
  (line: string): void;
  file: string;
}

export function createLogger(dir: string, opts: { name?: string; maxBytes?: number; keep?: number; echo?: boolean } = {}): Logger {
  const name = opts.name ?? 'server';
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const keep = opts.keep ?? 5;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  const at = (i: number) => path.join(dir, `${name}.${i}.log`);

  const rotate = () => {
    rmSync(at(keep), { force: true });
    for (let i = keep - 1; i >= 1; i--) if (existsSync(at(i))) renameSync(at(i), at(i + 1));
    renameSync(file, at(1));
  };

  const log = ((line: string) => {
    const stamp = new Date().toISOString();
    const text = line
      .split('\n')
      .map((l) => `${stamp} ${l}`)
      .join('\n');
    try {
      if (existsSync(file) && statSync(file).size > maxBytes) rotate();
      appendFileSync(file, text + '\n', 'utf8');
    } catch {
      /* logging skal aldri stoppe serveren */
    }
    if (opts.echo) process.stdout.write(text + '\n');
  }) as Logger;
  log.file = file;
  return log;
}
