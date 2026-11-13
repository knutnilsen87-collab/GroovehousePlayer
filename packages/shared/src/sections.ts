import type { AssetMarker } from './types';

/** Kapitler/strukturdeler sortert etter start. */
export function sectionsOf(markers: AssetMarker[]): AssetMarker[] {
  return markers.filter((m) => m.kind === 'chapter').sort((a, b) => a.startMs - b.startMs);
}

export function sectionAt(markers: AssetMarker[], ms: number): AssetMarker | null {
  const s = sectionsOf(markers);
  let cur: AssetMarker | null = null;
  for (const m of s) if (m.startMs <= ms + 1) cur = m;
  return cur;
}

/** Start på neste del, eller null hvis vi er i siste. */
export function nextSectionStart(markers: AssetMarker[], ms: number): number | null {
  const n = sectionsOf(markers).find((m) => m.startMs > ms + 500);
  return n ? n.startMs : null;
}

/**
 * Start på forrige del. Som på en CD-spiller: er vi mer enn 3 s inn i delen,
 * hopper vi til starten av den; ellers til delen før.
 */
export function prevSectionStart(markers: AssetMarker[], ms: number): number {
  const s = sectionsOf(markers);
  const cur = [...s].reverse().find((m) => m.startMs <= ms + 1);
  if (!cur) return 0;
  if (ms - cur.startMs > 3000) return cur.startMs;
  const i = s.indexOf(cur);
  return i > 0 ? s[i - 1]!.startMs : 0;
}

/**
 * Bytter variant (f.eks. Radio Edit → Extended) og lander i samme del av låta:
 * samme etikett og samme relative posisjon inne i delen. Faller tilbake til samme andel av låta.
 */
export function mapPositionBetweenVariants(
  from: { markers: AssetMarker[]; durationMs: number },
  to: { markers: AssetMarker[]; durationMs: number },
  ms: number
): number {
  const a = sectionAt(from.markers, ms);
  if (a?.label) {
    const b = sectionsOf(to.markers).find((m) => m.label === a.label);
    if (b) {
      const aEnd = a.endMs ?? from.durationMs;
      const bEnd = b.endMs ?? to.durationMs;
      const frac = (ms - a.startMs) / Math.max(1, aEnd - a.startMs);
      return Math.round(b.startMs + frac * (bEnd - b.startMs));
    }
  }
  return Math.round((ms / Math.max(1, from.durationMs)) * to.durationMs);
}
