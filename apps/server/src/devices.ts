import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Tilkoblede enheter (del 12, Android-appen). Paring med PIN gir et langlivet enhetstoken. Bare
 * SHA-256 av tokenet lagres (data/devices.json, gitignored), så fila alene gir ingen tilgang.
 * Et token kan trekkes tilbake; da får appen 401 og må pares på nytt.
 */
export interface Device {
  id: string;
  name: string;
  tokenSha256: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Del 15: versjonen appen sist meldte (X-GV-App / X-GV-Bundle). */
  client?: ClientVersion;
}

export interface ClientVersion {
  versionCode: number;
  bundle: number | null;
  seenAt: string;
}

export interface PublicDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  client?: ClientVersion;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pub = ({ tokenSha256: _t, ...d }: Device): PublicDevice => d;

export function createDeviceStore(file: string) {
  let cache: Device[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Device[]> => {
    if (cache) return cache;
    try {
      const j = JSON.parse(await readFile(file, 'utf8')) as { devices?: Device[] };
      cache = Array.isArray(j.devices) ? j.devices : [];
    } catch {
      cache = [];
    }
    return cache;
  };
  const write = async (devices: Device[]) => {
    cache = devices;
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ schema: 1, devices }, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  };
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  let lastSeenWrite = 0;

  return {
    list: async (): Promise<PublicDevice[]> => (await read()).map(pub),

    /** Ny enhet. Tokenet returneres én gang og lagres aldri i klartekst. */
    pair: (name: string) =>
      serial(async () => {
        const token = randomBytes(32).toString('base64url');
        const d: Device = {
          id: randomUUID(),
          name: (name || 'Ukjent enhet').trim().slice(0, 60),
          tokenSha256: sha(token),
          createdAt: new Date().toISOString(),
          lastSeenAt: null,
          revokedAt: null
        };
        await write([...(await read()), d]);
        return { device: pub(d), token };
      }),

    /** Gyldig og ikke trukket tilbake? Oppdaterer «sist sett» høyst hvert 5. minutt. */
    verify: async (token: string | undefined | null): Promise<PublicDevice | null> => {
      if (!token || token.length < 20 || token.length > 200) return null;
      const h = Buffer.from(sha(token), 'hex');
      const d = (await read()).find((x) => !x.revokedAt && timingSafeEqual(Buffer.from(x.tokenSha256, 'hex'), h));
      if (!d) return null;
      const now = Date.now();
      if (now - lastSeenWrite > 5 * 60_000) {
        lastSeenWrite = now;
        d.lastSeenAt = new Date(now).toISOString();
        void serial(() => write(cache!)).catch(() => {});
      }
      return pub(d);
    },

    /** Lagres bare når versjonen endres (ikke ved hver forespørsel). */
    noteClient: (id: string, app: string, bundle: string) =>
      serial(async () => {
        const versionCode = Number(app);
        const b = bundle && /^\d{1,20}$/.test(bundle) ? Number(bundle) : null;
        if (!Number.isInteger(versionCode) || versionCode < 1) return;
        const all = await read();
        const d = all.find((x) => x.id === id);
        if (!d || (d.client?.versionCode === versionCode && d.client?.bundle === b)) return;
        d.client = { versionCode, bundle: b, seenAt: new Date().toISOString() };
        await write(all);
      }),

    revoke: (id: string) =>
      serial(async () => {
        const all = await read();
        const d = all.find((x) => x.id === id);
        if (!d) return false;
        d.revokedAt ??= new Date().toISOString();
        await write(all);
        return true;
      })
  };
}

export type DeviceStore = ReturnType<typeof createDeviceStore>;

/** «Authorization: Bearer <token>» → token, ellers null. */
export function bearerOf(header: string | string[] | undefined): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  const m = v?.match(/^Bearer\s+([\w-]{20,200})$/);
  return m ? m[1]! : null;
}

/** Appens opprinnelse i Capacitor (androidScheme «https»). CORS gis bare til denne. */
export const APP_ORIGIN = 'https://localhost';
