import type { AssetMarker } from '@gv/shared';

/**
 * Formatet Echo Groove Lab (eller en hurtigtast) skriver mens et sett spilles.
 * Tidene er i loggens egen klokke; `sync`-hendelsen er klikket som også havner i opptaket.
 *
 * {
 *   "schema": 1,
 *   "events": [
 *     { "tMs": 0,      "type": "sync" },
 *     { "tMs": 4200,   "type": "track", "slug": "blue-fire", "label": "Blue Fire" },
 *     { "tMs": 380000, "type": "track", "slug": "would-you-run" },
 *     { "tMs": 512000, "type": "highlight", "label": "Publikum tar av" }
 *   ]
 * }
 */
export interface LiveLog {
  schema: 1;
  events: Array<{ tMs: number; type: 'sync' | 'track' | 'highlight'; slug?: string; label?: string }>;
}

export interface LiveLogResult {
  markers: AssetMarker[];
  offsetMs: number;
  synced: boolean;
}

/**
 * Gjør loggen om til markører på lydfilas tidslinje.
 * offset = (hvor klikket faktisk ligger i lyden) − (hvor loggen sier det ligger).
 * Uten sync-klikk eller funnet transient: offset 0, og markørene merkes ubekreftet.
 */
export function liveLogToMarkers(log: LiveLog, durationMs: number, audioSyncMs: number | null, manualOffsetMs = 0): LiveLogResult {
  if (log.schema !== 1 || !Array.isArray(log.events)) throw new Error('Ukjent live_log-format');
  const events = [...log.events].sort((a, b) => a.tMs - b.tMs);
  const sync = events.find((e) => e.type === 'sync');
  const synced = !!sync && audioSyncMs !== null;
  const offsetMs = (synced ? audioSyncMs! - sync!.tMs : 0) + manualOffsetMs;

  const tracks = events.filter((e) => e.type === 'track');
  const markers: AssetMarker[] = [];
  tracks.forEach((e, k) => {
    const start = clamp(e.tMs + offsetMs, 0, durationMs);
    const next = tracks[k + 1];
    const end = next ? clamp(next.tMs + offsetMs, 0, durationMs) : durationMs;
    if (end <= start) return;
    markers.push({
      kind: 'chapter',
      source: 'live_log',
      startMs: start,
      endMs: end,
      label: e.label ?? e.slug,
      refSlug: e.slug,
      confirmed: synced
    });
  });
  for (const e of events.filter((x) => x.type === 'highlight')) {
    markers.push({ kind: 'highlight', source: 'live_log', startMs: clamp(e.tMs + offsetMs, 0, durationMs), label: e.label, confirmed: synced });
  }
  return { markers, offsetMs, synced };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
