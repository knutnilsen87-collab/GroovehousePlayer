import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * LAN-tilgang: PIN (lagres bare som scrypt-hash) og en signert, httpOnly informasjonskapsel
 * som varer i 30 dager. Signeringsnøkkelen ligger i Credential Manager; byttes den, er alle
 * mobiler logget ut (skjer ved ny PIN og ved «vault:lan off»).
 */
export const COOKIE_NAME = 'gv_lan';
export const PIN_RE = /^\d{6,12}$/;

export interface PinRecord {
  v: 1;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPin(pin: string): PinRecord {
  if (!PIN_RE.test(pin)) throw new Error('PIN må være 6–12 sifre');
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32, SCRYPT);
  return { v: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
}

export function verifyPin(pin: string, rec: PinRecord): boolean {
  if (typeof pin !== 'string' || pin.length > 32) return false;
  const expected = Buffer.from(rec.hash, 'base64');
  const got = scryptSync(pin, Buffer.from(rec.salt, 'base64'), expected.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function newSecret(): string {
  return randomBytes(32).toString('base64');
}

const sign = (secret: string, payload: string) => createHmac('sha256', Buffer.from(secret, 'base64')).update(payload).digest('base64url');

/** v1.<enhet>.<utløp i sek>.<hmac> */
export function issueToken(secret: string, ttlDays: number, now = Date.now()): { value: string; maxAgeSec: number } {
  const device = randomBytes(9).toString('base64url');
  const maxAgeSec = Math.round(ttlDays * 86400);
  const payload = `v1.${device}.${Math.floor(now / 1000) + maxAgeSec}`;
  return { value: `${payload}.${sign(secret, payload)}`, maxAgeSec };
}

export function verifyToken(secret: string, value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const payload = parts.slice(0, 3).join('.');
  const mac = Buffer.from(parts[3]!);
  const expected = Buffer.from(sign(secret, payload));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return false;
  return Number(parts[2]) * 1000 > now;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Begrenser PIN-forsøk: 5 feil per adresse per 15 min, og 20 feil totalt per time
 * (stopper gjetting fra mange enheter). Vellykket innlogging nullstiller adressen.
 */
export class LoginLimiter {
  private perIp = new Map<string, number[]>();
  private all: number[] = [];
  constructor(
    private readonly ipMax = 5,
    private readonly ipWindowMs = 15 * 60_000,
    private readonly globalMax = 20,
    private readonly globalWindowMs = 60 * 60_000
  ) {}

  /** null = lov å prøve; ellers sekunder til neste forsøk. */
  blockedFor(ip: string, now = Date.now()): number | null {
    const ipHits = (this.perIp.get(ip) ?? []).filter((t) => now - t < this.ipWindowMs);
    this.perIp.set(ip, ipHits);
    this.all = this.all.filter((t) => now - t < this.globalWindowMs);
    if (ipHits.length >= this.ipMax) return Math.ceil((ipHits[0]! + this.ipWindowMs - now) / 1000);
    if (this.all.length >= this.globalMax) return Math.ceil((this.all[0]! + this.globalWindowMs - now) / 1000);
    return null;
  }

  fail(ip: string, now = Date.now()) {
    this.perIp.set(ip, [...(this.perIp.get(ip) ?? []), now]);
    this.all.push(now);
  }

  success(ip: string) {
    this.perIp.delete(ip);
  }
}
