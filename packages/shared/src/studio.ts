/**
 * Del 14 «High-End Studio»: rene hjelpere for spilleren (web og app), testet i packages/shared/test.
 */

// ---------------------------------------------------------------- Sangtekst (LRC + WhisperX ord-synkronisering)

export interface LyricLine {
  /** null = usynkronisert linje (ren tekst). */
  ms: number | null;
  text: string;
}
export interface ParsedLyrics {
  lines: LyricLine[];
  synced: boolean;
}

export interface LyricWord {
  /** Globalt ord-indeks i sangen (0..N-1). */
  index: number;
  /** Hvilken linje ordet tilhører. */
  lineIndex: number;
  word: string;
  startMs: number;
  endMs: number;
}

export interface LyricWordLine {
  ms: number | null;
  text: string;
  words: LyricWord[];
}

export interface ParsedWordLyrics {
  synced: boolean;
  /** true når hvert ord har egne tidsstempler (WhisperX JSON eller Enhanced LRC). */
  wordSynced: boolean;
  lines: LyricWordLine[];
  words: LyricWord[];
}

const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const INLINE_WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>\s*([^\s<]+)/g;
const STRIP_INLINE_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const META_RE = /^\[(ar|ti|al|by|length|re|ve|au):.*\]$/i;
const OFFSET_RE = /^\[offset:\s*([+-]?\d+)\]$/i;

function parseStampMs(minStr: string, secStr: string, fracStr?: string): number {
  const frac = fracStr ? Number(fracStr.padEnd(3, '0').slice(0, 3)) : 0;
  return Number(minStr) * 60_000 + Number(secStr) * 1000 + frac;
}

/** Sjekker om teksten er en WhisperX JSON-liste med `{ word, start, end }`. */
function tryParseWhisperJson(text: string): Array<{ word: string; startMs: number; endMs: number }> | null {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  try {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr)) return null;
    const out: Array<{ word: string; startMs: number; endMs: number }> = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const w = typeof rec.word === 'string' ? rec.word.trim() : '';
      if (!w) continue;
      const startMs =
        typeof rec.startMs === 'number'
          ? Math.round(rec.startMs)
          : typeof rec.start === 'number'
            ? Math.round(rec.start * 1000)
            : null;
      const endMs =
        typeof rec.endMs === 'number'
          ? Math.round(rec.endMs)
          : typeof rec.end === 'number'
            ? Math.round(rec.end * 1000)
            : startMs !== null
              ? startMs + 300
              : null;
      if (startMs === null || endMs === null || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      out.push({ word: w, startMs: Math.max(0, startMs), endMs: Math.max(startMs + 20, endMs) });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Grupperer WhisperX-ord til naturlige verselinjer (ved pauser > 650 ms, tegnsetting eller maks 8 ord). */
function groupWhisperWords(rawWords: Array<{ word: string; startMs: number; endMs: number }>): { lines: LyricWordLine[]; words: LyricWord[] } {
  const lines: LyricWordLine[] = [];
  const words: LyricWord[] = [];
  let bucket: Array<{ word: string; startMs: number; endMs: number }> = [];

  const flush = () => {
    if (!bucket.length) return;
    const lineIndex = lines.length;
    const lineWords: LyricWord[] = bucket.map((b) => {
      const lw: LyricWord = {
        index: words.length,
        lineIndex,
        word: b.word,
        startMs: b.startMs,
        endMs: b.endMs
      };
      words.push(lw);
      return lw;
    });
    lines.push({
      ms: lineWords[0]!.startMs,
      text: lineWords.map((w) => w.word).join(' '),
      words: lineWords
    });
    bucket = [];
  };

  for (const w of rawWords) {
    const prev = bucket[bucket.length - 1];
    if (prev) {
      const gap = w.startMs - prev.endMs;
      const endsSentence = /[.!?]$/.test(prev.word);
      if (gap >= 650 || (endsSentence && bucket.length >= 3) || bucket.length >= 8) {
        flush();
      }
    }
    bucket.push(w);
  }
  flush();
  return { lines, words };
}

/**
 * LRC (`[01:23.45]tekst`, flere tidsstempler per linje, `[offset:+120]`), WhisperX JSON eller ren tekst.
 * Synkroniserte linjer sorteres på tid; metadata-tagger (ar, ti …) fjernes.
 */
export function parseLyrics(text: string): ParsedLyrics {
  const whisper = tryParseWhisperJson(text);
  if (whisper) {
    const { lines } = groupWhisperWords(whisper);
    return { synced: true, lines: lines.map((l) => ({ ms: l.ms, text: l.text })) };
  }
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
      stamps.push(parseStampMs(m[1]!, m[2]!, m[3]));
      last = TAG_RE.lastIndex;
    }
    const body = line.slice(last).replace(STRIP_INLINE_RE, ' ').replace(/\s+/g, ' ').trim();
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

/**
 * Parser sangtekst til ord-nivå (WhisperX JSON, Enhanced LRC `<mm:ss.xx>ord` eller vanlig LRC med interpolerte ord-tider).
 */
export function parseLyricWords(text: string, durationMs = 180_000): ParsedWordLyrics {
  const whisper = tryParseWhisperJson(text);
  if (whisper) {
    const { lines, words } = groupWhisperWords(whisper);
    return { synced: true, wordSynced: true, lines, words };
  }

  let offset = 0;
  const rawTimed: Array<{ ms: number; rawBody: string }> = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
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
      stamps.push(parseStampMs(m[1]!, m[2]!, m[3]));
      last = TAG_RE.lastIndex;
    }
    const rawBody = line.slice(last).trim();
    if (stamps.length) {
      for (const ms of stamps) rawTimed.push({ ms: Math.max(0, ms - offset), rawBody });
    }
  }

  if (rawTimed.length) {
    rawTimed.sort((a, b) => a.ms - b.ms);
    const words: LyricWord[] = [];
    const lines: LyricWordLine[] = [];
    let hasExplicitWordTags = false;

    for (let li = 0; li < rawTimed.length; li++) {
      const cur = rawTimed[li]!;
      const nextMs = rawTimed[li + 1]?.ms ?? Math.max(cur.ms + 3000, durationMs);
      const inlineMatches: Array<{ startMs: number; word: string }> = [];
      INLINE_WORD_RE.lastIndex = 0;
      let im: RegExpExecArray | null;
      while ((im = INLINE_WORD_RE.exec(cur.rawBody)) !== null) {
        const wMs = Math.max(0, parseStampMs(im[1]!, im[2]!, im[3]) - offset);
        inlineMatches.push({ startMs: wMs, word: im[4]! });
      }

      if (inlineMatches.length > 0) {
        hasExplicitWordTags = true;
        const lineWords: LyricWord[] = inlineMatches.map((iw, wi) => {
          const endMs = inlineMatches[wi + 1]?.startMs ?? Math.min(nextMs, iw.startMs + 600);
          const lw: LyricWord = {
            index: words.length,
            lineIndex: li,
            word: iw.word,
            startMs: iw.startMs,
            endMs: Math.max(iw.startMs + 40, endMs)
          };
          words.push(lw);
          return lw;
        });
        lines.push({
          ms: cur.ms,
          text: lineWords.map((w) => w.word).join(' '),
          words: lineWords
        });
      } else {
        const cleanText = cur.rawBody.replace(STRIP_INLINE_RE, ' ').replace(/\s+/g, ' ').trim();
        const tokens = cleanText ? cleanText.split(/\s+/) : [];
        const spanMs = Math.max(300, Math.min(nextMs - cur.ms - 60, Math.max(1200, tokens.length * 360)));
        const step = tokens.length > 0 ? spanMs / tokens.length : spanMs;
        const lineWords: LyricWord[] = tokens.map((tok, wi) => {
          const wStart = Math.round(cur.ms + wi * step);
          const wEnd = Math.round(cur.ms + (wi + 1) * step);
          const lw: LyricWord = {
            index: words.length,
            lineIndex: li,
            word: tok,
            startMs: wStart,
            endMs: Math.max(wStart + 40, wEnd)
          };
          words.push(lw);
          return lw;
        });
        lines.push({
          ms: cur.ms,
          text: cleanText,
          words: lineWords
        });
      }
    }

    return { synced: true, wordSynced: hasExplicitWordTags, lines, words };
  }

  const base = parseLyrics(text);
  return {
    synced: false,
    wordSynced: false,
    words: [],
    lines: base.lines.map((l) => ({ ms: null, text: l.text, words: [] }))
  };
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

/**
 * Ordet som synges nå (binærsøk i sorterte LyricWord[]).
 * Returnerer siste ord med startMs ≤ positionMs (slik at aktivt ord ikke blinker til -1 i korte pustepauser).
 */
export function wordIndexAt(words: LyricWord[], positionMs: number): number {
  if (!words.length) return -1;
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
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
