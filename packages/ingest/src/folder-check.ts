import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Del 27: hvorfor er en mappe utilgjengelig, og hva gjør Knut med det? Leser bare (readdir), endrer aldri noe.
 * Svaret vises i importstatusen i stedet for «Mappe utilgjengelig».
 */
export type FolderState = 'ok' | 'unset' | 'missing-drive' | 'missing' | 'not-dir' | 'locked' | 'denied' | 'error';
export interface FolderCheck {
  dir: string | null;
  state: FolderState;
  /** Kort årsak på norsk. */
  reason: string | null;
  /** Konkret løsning. */
  fix: string | null;
}

export function checkFolder(dir: string | null | undefined, fs: { exists: (p: string) => boolean; isDir: (p: string) => boolean; list: (p: string) => void } = realFs): FolderCheck {
  if (!dir) return { dir: null, state: 'unset', reason: 'Ingen eksportmappe er valgt ennå.', fix: 'Velg mappa Reason bouncer til (Velg eksportmappe).' };
  const abs = path.resolve(dir);
  const root = path.parse(abs).root;
  // Windows: «F:\» finnes ikke = disken er ikke koblet til (ekstern disk, nettverksdisk)
  if (/^[a-z]:\\$/i.test(root) && !fs.exists(root)) {
    const drive = root.slice(0, 2).toUpperCase();
    return { dir: abs, state: 'missing-drive', reason: `Disken ${drive} er ikke tilkoblet.`, fix: `Koble til disken ${drive} (eller vent til nettverksdisken er oppe), og trykk «Prøv igjen».` };
  }
  if (!fs.exists(abs)) {
    const parent = nearestExisting(abs, fs.exists);
    return { dir: abs, state: 'missing', reason: `Mappa finnes ikke: ${abs}`, fix: parent ? `Sjekk stavingen, eller om mappa er flyttet eller gitt nytt navn. ${parent} finnes.` : 'Sjekk stavingen, eller velg mappa på nytt.' };
  }
  if (!fs.isDir(abs)) return { dir: abs, state: 'not-dir', reason: `Stien er en fil, ikke en mappe: ${abs}`, fix: 'Velg mappa som fila ligger i.' };
  try {
    fs.list(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY') return { dir: abs, state: 'locked', reason: 'En annen prosess låser mappa.', fix: 'Lukk programmet som bruker mappa (f.eks. en synkronisering eller et virusprogram som skanner), og prøv igjen.' };
    if (code === 'EACCES' || code === 'EPERM') return { dir: abs, state: 'denied', reason: 'Windows nekter Vault å lese mappa.', fix: 'Sjekk tilgangen under Egenskaper → Sikkerhet, eller om en annen prosess låser mappa (synkronisering, virusprogram).' };
    return { dir: abs, state: 'error', reason: `Mappa kan ikke leses (${code ?? 'ukjent feil'}).`, fix: 'Prøv igjen. Står det fortsatt, start Vault på nytt.' };
  }
  return { dir: abs, state: 'ok', reason: null, fix: null };
}

function nearestExisting(p: string, exists: (p: string) => boolean): string | null {
  let cur = path.dirname(p);
  for (let i = 0; i < 20; i++) {
    if (exists(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

const realFs = {
  exists: (p: string) => existsSync(p),
  isDir: (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  list: (p: string) => void readdirSync(p)
};
