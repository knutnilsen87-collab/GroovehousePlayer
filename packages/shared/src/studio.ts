/**
 * Del 14 «High-End Studio»: rene hjelpere for spilleren (web og app), testet i packages/shared/test.
 */

// ---------------------------------------------------------------- Sangtekst (LRC)

export interface LyricLine {
  /** null = usynkronisert linje (ren tekst). */
  ms: number | null;
  text: string;
}
export interface ParsedLyrics {
  lines: LyricLine[];
  synced: boolean;
}

const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[(ar|ti|al|by|length|re|ve|au):.*\]$/i;
const OFFSET_RE = /^\[offset:\s*([+-]?\d+)\]$/i;

/**
 * LRC (`[01:23.45]tekst`, flere tidsstempler per linje, `[offset:+120]`) eller ren tekst.
 * Synkroniserte linjer sorteres på tid; metadata-tagger (ar, ti …) fjernes.
 */
export function parseLyrics(text: string): ParsedLyrics {
  let offset = 0;
  const timed: Array<{ ms: number; text: string }> = [];
  const plain: string[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const off = OFFSET_RE.exec(line);
    if (off) {
      offset = Number(off[1]);
      continue;
    }
    if (META_RE.test(line)) continue;
    const stamps: number[] = [];
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = TAG_RE.exec(line)) && m.index === last) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
      stamps.push(Number(m[1]) * 60_000 + Number(m[2]) * 1000 + frac);
      last = TAG_RE.lastIndex;
    }
    const body = line.slice(last).trim();
    if (stamps.length) for (const ms of stamps) timed.push({ ms, text: body });
    else plain.push(raw.trimEnd());
  }
  if (timed.length) {
    // LRC: positiv offset = teksten kommer tidligere
    return { synced: true, lines: timed.map((l) => ({ ms: Math.max(0, l.ms - offset), text: l.text })).sort((a, b) => a.ms - b.ms) };
  }
  while (plain.length && !plain[plain.length - 1]) plain.pop();
  while (plain.length && !plain[0]) plain.shift();
  return { synced: false, lines: plain.map((t) => ({ ms: null, text: t })) };
}

/** Linja som synges nå (siste med ms ≤ posisjon), -1 før første. */
export function lyricIndexAt(lines: LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ms = lines[mid]!.ms ?? Infinity;
    if (ms <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// ---------------------------------------------------------------- Toneart og Camelot

const SHARP_TO_FLAT: Record<string, string> = { 'A#': 'Bb', 'D#': 'Eb', 'G#': 'Ab' };
/** «A minor» → «Am», «F# major» → «F#», «A# minor» → «Bbm». Ukjent → som den er. */
export function keyShort(name: string | null | undefined): string {
  if (!name) return '–';
  const m = /^([A-G])([#b♯♭]?)\s*(major|minor|maj|min|m|dur|moll)?$/i.exec(name.trim());
  if (!m) return name;
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' || m[2] === 'B' ? 'b' : m[2]!;
  const root = m[1]!.toUpperCase() + acc;
  const r = SHARP_TO_FLAT[root] ?? root;
  return /^(min|m$|moll)/i.test(m[3] ?? '') ? `${r}m` : r;
}

/** «8A» → { n: 8, minor: true }. */
export function parseCamelot(code: string | null | undefined): { n: number; minor: boolean } | null {
  const m = /^(1[0-2]|[1-9])([AB])$/i.exec(code?.trim() ?? '');
  return m ? { n: Number(m[1]), minor: m[2]!.toUpperCase() === 'A' } : null;
}

/** Harmonisk naboer: samme kode, ±1 på hjulet (samme bokstav) og relativ dur/moll (samme tall). */
export function camelotNeighbors(code: string): string[] {
  const c = parseCamelot(code);
  if (!c) return [];
  const L = c.minor ? 'A' : 'B';
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1;
  return [`${c.n}${L}`, `${wrap(c.n - 1)}${L}`, `${wrap(c.n + 1)}${L}`, `${c.n}${c.minor ? 'B' : 'A'}`];
}

/** «Passer etter denne»: Camelot ±1 eller relativ dur/moll, og BPM innenfor ±pct (standard 3 %). */
export function mixesWith(a: { bpm: number | null; camelot: string | null }, b: { bpm: number | null; camelot: string | null }, pct = 0.03): boolean {
  if (!a.camelot || !b.camelot || !a.bpm || !b.bpm) return false;
  if (!camelotNeighbors(a.camelot).includes(b.camelot.toUpperCase())) return false;
  return Math.abs(b.bpm - a.bpm) <= a.bpm * pct + 1e-9;
}

// ---------------------------------------------------------------- A·B-løkke og hastighet

export const RATE_MIN = 0.9;
export const RATE_MAX = 1.1;
/** 0,90–1,10 i steg på 0,01. */
export function clampRate(r: number): number {
  if (!Number.isFinite(r)) return 1;
  return Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, r)) * 100) / 100;
}

export const beatMs = (bpm: number) => 60_000 / bpm;

/** Nærmeste taktslag (anker = første slag, standard 0). Uten BPM: uendret. */
export function snapToBeat(ms: number, bpm: number | null | undefined, anchorMs = 0): number {
  if (!bpm || bpm <= 0) return ms;
  const b = beatMs(bpm);
  return Math.max(0, anchorMs + Math.round((ms - anchorMs) / b) * b);
}

export interface Loop {
  a: number;
  b: number;
}
/**
 * Lager en gyldig løkke: sortert, innenfor låta, festet til takter (med mindre `snap` er false)
 * og minst ett slag (eller 250 ms uten BPM). null hvis den ikke kan bli gyldig.
 */
export function makeLoop(x: number, y: number, durationMs: number, bpm: number | null | undefined, snap = true): Loop | null {
  let a = Math.max(0, Math.min(x, y));
  let b = Math.min(durationMs, Math.max(x, y));
  if (snap && bpm) {
    a = snapToBeat(a, bpm);
    b = snapToBeat(b, bpm);
  }
  const min = bpm ? beatMs(bpm) : 250;
  if (b - a < min - 1e-6) b = a + min;
  if (b > durationMs) {
    b = durationMs;
    a = Math.max(0, b - min);
  }
  return b - a >= Math.min(min, durationMs) - 1e-6 && b > a ? { a: Math.round(a), b: Math.round(b) } : null;
}

/** Tid med millisekunder i mono: 02:41.320 (timer ved behov: 1:02:41.320). */
export function formatTimeMs(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const r = t % 1000;
  const mm = String(m).padStart(2, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}
