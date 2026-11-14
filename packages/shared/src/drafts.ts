import { camelotNeighbors, parseCamelot } from './studio';
import type { AssetManifest } from './types';

/**
 * Del 16: utkast (umastrede låter) holdes atskilt fra release-klare.
 *
 * Status bestemmes av mappa låta kom fra. Utkast får egne versjonsnumre (DRAFT_BASE + N, vist som
 * «Utkast vN»), så de aldri kolliderer med release-versjoner av samme låt og alle nøkler
 * (slug + variant + versjon) virker som før. En låt bytter aldri status av seg selv.
 */
export type AssetStatus = 'release' | 'draft';
export const DRAFT_BASE = 1000;

/** Utkast-versjonsnummer. Idempotent: et nummer som allerede er et utkastnummer, beholdes. */
export const toDraftVersion = (n: number) => (n > DRAFT_BASE ? n : DRAFT_BASE + Math.max(1, Math.floor(n)));
export const isDraftVersion = (v: number) => v > DRAFT_BASE;
/** Status for et manifest (eldre manifester uten felt: ut fra versjonsnummeret). */
export const statusOf = (m: Pick<AssetManifest, 'version'> & { status?: AssetStatus }): AssetStatus => m.status ?? (isDraftVersion(m.version) ? 'draft' : 'release');
export const isDraft = (m: Pick<AssetManifest, 'version'> & { status?: AssetStatus }) => statusOf(m) === 'draft';
/** «v3» eller «Utkast v3». */
export function versionName(m: Pick<AssetManifest, 'version'> & { status?: AssetStatus }): string {
  return isDraftVersion(m.version) ? `Utkast v${m.version - DRAFT_BASE}` : `v${m.version}`;
}

/**
 * Hvilken versjon som vises og spilles («følg nyeste»): release hvis den finnes, ellers nyeste utkast.
 * Når en låt blir mastret, går altså lister og planer automatisk over til masteren.
 */
export function preferredVersion<T extends { version: number; status?: AssetStatus }>(versions: T[]): T | undefined {
  const rel = versions.filter((v) => statusOf(v) === 'release').sort((a, b) => b.version - a.version);
  if (rel.length) return rel[0];
  return [...versions].sort((a, b) => b.version - a.version)[0];
}

export type StatusFilter = 'release' | 'draft' | 'all';
export const matchesStatus = (m: Pick<AssetManifest, 'version'> & { status?: AssetStatus }, f: StatusFilter) => f === 'all' || statusOf(m) === f;

// ---------------------------------------------------------------- Album- og settplaner

export type PlaylistPlan = 'album' | 'set';
export const PLAN_NAMES: Record<PlaylistPlan | 'none', string> = { none: 'Vanlig', album: 'Album-plan', set: 'Sett-plan' };

/** Flyt mellom to nabolåter: grønn = harmonisk (samme/relativ), gul = ±1 på hjulet, rød = brudd. */
export type Flow = 'green' | 'yellow' | 'red' | 'unknown';
export function flowBetween(a: { bpm: number | null; camelot: string | null }, b: { bpm: number | null; camelot: string | null }): Flow {
  if (!a.camelot || !b.camelot || !parseCamelot(a.camelot) || !parseCamelot(b.camelot)) return 'unknown';
  const A = a.camelot.toUpperCase();
  const B = b.camelot.toUpperCase();
  // Tempo: over 6 % (halv/dobbel regnes som match) er brudd uansett toneart
  if (a.bpm && b.bpm) {
    const r = b.bpm / a.bpm;
    const off = Math.min(...[r, r * 2, r / 2].map((x) => Math.abs(x - 1)));
    if (off > 0.06) return 'red';
  }
  const [same, down, up, rel] = camelotNeighbors(A);
  if (B === same || B === rel) return 'green';
  if (B === down || B === up) return 'yellow';
  return 'red';
}

export interface PlanStats {
  total: number;
  mastered: number;
  durationMs: number;
  flows: Flow[];
}
export function planStats(rows: Array<{ status: AssetStatus; durationMs: number; bpm: number | null; camelot: string | null }>): PlanStats {
  return {
    total: rows.length,
    mastered: rows.filter((r) => r.status === 'release').length,
    durationMs: rows.reduce((s, r) => s + r.durationMs, 0),
    flows: rows.slice(1).map((r, i) => flowBetween(rows[i]!, r))
  };
}

// ---------------------------------------------------------------- Deling av utkast (del 10)

export const DRAFT_ALBUM = 'Groovehouse Records – Demo';
/** «Night Drive» → «Night Drive (Utkast)» (ikke dobbelt). */
export const draftTitle = (t: string) => (/\(utkast\)$/i.test(t.trim()) ? t : `${t} (Utkast)`);
