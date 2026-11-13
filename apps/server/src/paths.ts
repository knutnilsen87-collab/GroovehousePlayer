import os from 'node:os';
import path from 'node:path';

/**
 * %LOCALAPPDATA%\GroovehouseVault\ – port-fil, logger, launcher og ikon.
 * GV_APPDATA overstyrer (brukes i tester, så de aldri rører den ekte mappa).
 */
export function appDataDir(): string {
  if (process.env.GV_APPDATA) return path.resolve(process.env.GV_APPDATA);
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'GroovehouseVault');
}

export const portFile = () => path.join(appDataDir(), 'port');
export const logsDir = () => path.join(appDataDir(), 'logs');
