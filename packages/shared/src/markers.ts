import { mapPositionBetweenVariants } from './sections';
import type { AssetMarker, MarkerKind } from './types';

/**
 * Del 2: Knuts rettelser av strukturmarkørene (Intro, Build, Drop 1, Break, Drop 2, Outro …).
 * Lagres som markers.json ved siden av manifest.json i versjonsmappa.
 *  - Godkjente (`confirmed`) og manuelle (`source: "manual"`) markører overlever ny ingest (--force).
 *  - Forslag Knut har slettet, huskes i `dismissed` og kommer ikke tilbake.
 *  - Nye analyseforslag tas med bare der de ikke kolliderer med noe Knut har bestemt.
 */
export interface MarkersFile {
  schema: 1;
  updatedAt: string;
  markers: AssetMarker[];
  /** markerKey() for forslag som er slettet i Studio. */
  dismissed: string[];
}

export const MARKER_KINDS: MarkerKind[] = ['chapter', 'highlight', 'drop', 'clip'];
export const MAX_MARKERS = 200;

/** Identitet for et forslag: type + navn («chapter:drop 1»). */
export const markerKey = (m: Pick<AssetMarker, 'kind' | 'label'>) => `${m.kind}:${(m.label ?? '').trim().toLowerCase()}`;

/** Bevares ved ny ingest: alt Knut har bestemt. */
export const isKept = (m: AssetMarker) => m.confirmed || m.source === 'manual';

/** Samme sted (innenfor ett sekund) – da vinner Knuts markør over et nytt forslag. */
const NEAR_MS = 1000;

/**
 * Slår sammen nye analyseforslag med markers.json. Uten fil: forslagene som de er.
 * Resultatet er sortert på tid, med endMs fylt inn for kapitler (til neste kapittel).
 */
export function mergeMarkers(analysis: AssetMarker[], file: MarkersFile | null | undefined): AssetMarker[] {
  if (!file) return withEnds(analysis);
  const kept = file.markers.filter(isKept);
  const dismissed = new Set(file.dismissed ?? []);
  const keptKeys = new Set(kept.map(markerKey));
  const suggestions = analysis.filter(
    (a) => !dismissed.has(markerKey(a)) && !keptKeys.has(markerKey(a)) && !kept.some((k) => k.kind === a.kind && Math.abs(k.startMs - a.startMs) < NEAR_MS)
  );
  return withEnds([...kept, ...suggestions]);
}

/** Sorterer og setter endMs på kapitler = start på neste kapittel (siste: ingen). */
export function withEnds(markers: AssetMarker[]): AssetMarker[] {
  const sorted = [...markers].sort((a, b) => a.startMs - b.startMs);
  const chapters = sorted.filter((m) => m.kind === 'chapter');
  return sorted.map((m) => {
    if (m.kind !== 'chapter') return m;
    const next = chapters[chapters.indexOf(m) + 1];
    const { endMs: _old, ...rest } = m;
    return next ? { ...rest, endMs: next.startMs } : rest;
  });
}

/**
 * Ny versjon av låta (_v4): foreslå markørene fra forrige versjon, flyttet med samme logikk som
 * variantbytte (mapPositionBetweenVariants), og vis dem som ubekreftede. Hver markør kartlegges mot
 * naboene sine (ikke seg selv), så en rettet Drop 1 beholder avstanden til seksjonen før.
 * Samme lengde (± 50 ms) → samme tid. Analyseforslag med samme navn erstattes.
 */
export function carryMarkers(prev: { markers: AssetMarker[]; durationMs: number }, next: { markers: AssetMarker[]; durationMs: number }): AssetMarker[] {
  const same = Math.abs(prev.durationMs - next.durationMs) <= 50;
  const carried = prev.markers.filter(isKept).map((m) => {
    // Naboene uten markøren selv (og uten forslaget den erstatter), med seksjonsslutter regnet ut på nytt
    const others = withEnds(prev.markers.filter((x) => x !== m));
    const target = { markers: withEnds(next.markers.filter((x) => markerKey(x) !== markerKey(m))), durationMs: next.durationMs };
    const at = same ? m.startMs : mapPositionBetweenVariants({ markers: others, durationMs: prev.durationMs }, target, m.startMs);
    const { endMs: _e, ...rest } = m;
    return { ...rest, startMs: Math.max(0, Math.min(next.durationMs, Math.round(at))), confirmed: false };
  });
  const keys = new Set(carried.map(markerKey));
  return withEnds([...carried, ...next.markers.filter((a) => !keys.has(markerKey(a)))]);
}

/** Validerer markørene fra Studio. Returnerer rensede markører eller en norsk feilmelding. */
export function validateMarkers(input: unknown, durationMs: number): { ok: true; markers: AssetMarker[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'markers må være en liste' };
  if (input.length > MAX_MARKERS) return { ok: false, error: `for mange markører (maks ${MAX_MARKERS})` };
  const out: AssetMarker[] = [];
  for (const [i, raw] of input.entries()) {
    const m = raw as Partial<AssetMarker>;
    if (!m || typeof m !== 'object') return { ok: false, error: `markør ${i + 1} er ugyldig` };
    if (!MARKER_KINDS.includes(m.kind as MarkerKind)) return { ok: false, error: `markør ${i + 1}: ukjent type` };
    if (typeof m.startMs !== 'number' || !Number.isFinite(m.startMs) || m.startMs < 0 || m.startMs > durationMs) return { ok: false, error: `markør ${i + 1}: tiden er utenfor låta` };
    const label = typeof m.label === 'string' ? m.label.trim().replace(/\s+/g, ' ') : '';
    if (label.length > 40) return { ok: false, error: `markør ${i + 1}: navnet er for langt (maks 40 tegn)` };
    if (m.kind === 'chapter' && !label) return { ok: false, error: `markør ${i + 1}: seksjoner må ha et navn` };
    const source = (['manual', 'catalog_match', 'live_log', 'analysis'] as const).includes(m.source as never) ? m.source! : 'manual';
    out.push({
      kind: m.kind as MarkerKind,
      source,
      startMs: Math.round(m.startMs),
      ...(label ? { label } : {}),
      ...(typeof m.refSlug === 'string' ? { refSlug: m.refSlug } : {}),
      ...(typeof m.confidence === 'number' ? { confidence: m.confidence } : {}),
      ...(typeof m.bpm === 'number' && m.bpm > 0 && m.bpm < 400 ? { bpm: Math.round(m.bpm * 10) / 10 } : {}),
      confirmed: m.confirmed === true
    });
  }
  return { ok: true, markers: withEnds(out) };
}

/** Takt = 4 slag. Nærmeste takt fra 0 (uten BPM: uendret). */
export function snapToBar(ms: number, bpm: number | null | undefined): number {
  if (!bpm || bpm <= 0) return Math.round(ms);
  const bar = (4 * 60_000) / bpm;
  return Math.max(0, Math.round(Math.round(ms / bar) * bar));
}
export const barMs = (bpm: number | null | undefined) => (bpm && bpm > 0 ? (4 * 60_000) / bpm : 2000);
