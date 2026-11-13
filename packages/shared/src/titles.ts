/**
 * Titler og navn fra filnavn i en flat eksportmappe (f.eks. REASONDONE):
 *   "Eyes on you.wav"                        → slug eyes-on-you, tittel "Eyes On You"
 *   "Would You Run__extended_v2.wav"         → variant "extended", versjon 2
 *   "Midnight Rendezvous Stems (128BPM).wav" → tittel "Midnight Rendezvous", BPM-hint 128
 * Rensingen gjetter aldri apostrofer. Titler i bare versaler får vanlig tittel-format og flagges.
 */
import { slugify } from './naming';

export interface TitleCleanupConfig {
  /** Ord og mønstre som fjernes, uansett store/små bokstaver. */
  remove: string[];
}

export interface CleanTitle {
  title: string;
  /** Tekstbiter som ble fjernet, slik de sto i originalen. */
  removed: string[];
  bpmHint: number | null;
  /** Originalen var i bare versaler – tittelen bør sjekkes i Studio. */
  wasAllCaps: boolean;
}

const L = '\\p{L}\\p{N}';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex for ett ord/mønster fra config. Ordgrenser bare der mønsteret starter/slutter med bokstav/tall. */
function termRegex(term: string): RegExp {
  const pre = /^[\p{L}\p{N}]/u.test(term) ? `(?<![${L}])` : '';
  const post = /[\p{L}\p{N}]$/u.test(term) ? `(?![${L}]|\\.\\d)` : '';
  return new RegExp(`${pre}${escapeRe(term).replace(/\\? /g, '[\\s_-]+')}${post}`, 'giu');
}

const BPM_RE = /[([]?\s*(\d{2,3}(?:[.,]\d+)?)\s*bpm\s*[)\]]?/giu;
const DATE_RES = [
  /(?<![\p{N}])(?:19|20)\d{2}[-._ ](?:0?[1-9]|1[0-2])[-._ ](?:0?[1-9]|[12]\d|3[01])(?![\p{N}])/gu,
  /(?<![\p{N}])(?:0?[1-9]|[12]\d|3[01])[-._](?:0?[1-9]|1[0-2])[-._](?:\d{4}|\d{2})(?![\p{N}])/gu,
  /(?<![\p{N}])(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?![\p{N}])/gu
];
const RUN_NUMBER_RE = /[([]\s*\d{1,3}\s*[)\]]/gu;

export function cleanTitle(raw: string, cfg: TitleCleanupConfig): CleanTitle {
  const removed: string[] = [];
  let bpmHint: number | null = null;
  let s = raw.replace(/_/g, ' ');

  const strip = (re: RegExp) => {
    s = s.replace(re, (m) => {
      removed.push(m.trim());
      return ' ';
    });
  };

  s = s.replace(BPM_RE, (m, n: string) => {
    const v = Number(n.replace(',', '.'));
    if (v >= 60 && v <= 200 && bpmHint === null) bpmHint = v;
    removed.push(m.trim());
    return ' ';
  });
  DATE_RES.forEach(strip);
  strip(RUN_NUMBER_RE);
  // Lengste mønster først, så "suno ai" og "v4.5" fjernes før "suno" og "v4".
  for (const term of [...cfg.remove].sort((a, b) => b.length - a.length)) strip(termRegex(term));

  s = tidy(s);
  const fallback = tidy(raw.replace(/_/g, ' ').replace(/suno(\s*ai)?/giu, ' '));
  if (!s) s = fallback || raw;

  const wasAllCaps = /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
  return { title: titleCase(s), removed: removed.filter(Boolean), bpmHint, wasAllCaps };
}

/** Tomme parenteser, doble/løse bindestreker og mellomrom. */
function tidy(s: string): string {
  return s
    .replace(/[([]\s*[)\]]/g, ' ')
    .replace(/\s*[-–—]\s*(?:[-–—]\s*)+/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '')
    .replace(/\s+-\s*$|^\s*-\s+/g, '')
    .trim();
}

/**
 * Stor forbokstav i hvert ord. Bokstaver inne i ordet beholdes (DJ, McCoy), med mindre hele
 * tittelen er i versaler – da blir resten små. Ingen apostrofer legges til.
 */
export function titleCase(s: string): string {
  const allCaps = /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s);
  return s
    .split(' ')
    .map((w) => {
      const body = allCaps ? w.toLocaleLowerCase('nb') : w;
      const i = body.search(/\p{L}/u);
      return i < 0 ? body : body.slice(0, i) + body.charAt(i).toLocaleUpperCase('nb') + body.slice(i + 1);
    })
    .join(' ');
}

export interface FlatName {
  slug: string;
  variant: string | null;
  version: number;
  clean: CleanTitle;
}

/**
 * Tolker et filnavn i en flat eksportmappe. Versjon må skrives med understrek (`_v3`), slik at
 * «suno v4» i et navn ikke blir tolket som versjon 4. Variant skrives med dobbel understrek.
 */
export function parseFlatName(fileName: string, cfg: TitleCleanupConfig): FlatName {
  const base = fileName.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.*?)_v(\d{1,4})$/i);
  const rest = m ? m[1]! : base;
  const version = m ? parseInt(m[2]!, 10) : 1;
  const vi = rest.indexOf('__');
  const titlePart = vi >= 0 ? rest.slice(0, vi) : rest;
  const variantRaw = vi >= 0 ? slugify(rest.slice(vi + 2)) : '';
  const clean = cleanTitle(titlePart, cfg);
  const slug = slugify(clean.title) || slugify(titlePart) || 'untitled';
  return { slug, variant: variantRaw && variantRaw !== 'main' && variantRaw !== 'original' ? variantRaw : null, version: Math.max(1, version), clean };
}

/** Finn «suno» (uansett store/små bokstaver). Returnerer de treffende tekstbitene. */
export function findSuno(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/[^\s,;|]*suno[^\s,;|]*/giu)].map((x) => x[0]);
}

/** Fjerner «suno», «suno ai» og en ev. versjon etter (v4.5) fra et fritt tekstfelt. Endrer ellers ingenting. */
export function scrubSuno(text: string): string {
  return tidy(text.replace(/(?<![\p{L}\p{N}])suno(?:[\s_-]*ai)?(?:[\s_-]*v?\d+(?:\.\d+)?)?(?![\p{L}\p{N}])/giu, ' ').replace(/[([]\s*[)\]]/g, ' '));
}
