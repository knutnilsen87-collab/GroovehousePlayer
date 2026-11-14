import { isDraft } from './drafts';
import { sectionsOf } from './sections';
import type { SbTrack } from './setbuilder';
import type { Analysis, AssetManifest } from './types';

/**
 * Del 17: gjør manifest + analyse om til settbyggerens låter.
 *
 * Energi 1–10 (kriterie 3): lydstyrke i drop-seksjonene (energikurven), bass-energi og transient-tetthet
 * (diskant i bølgeformen), pluss målt LUFS. Rangeres innenfor katalogen, så skalaen bruker hele 1–10.
 * Knut kan overstyre den i Studio (manifest.energy).
 */
export interface EnergyFeatures {
  drop: number;
  bass: number;
  transients: number;
  lufs: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function energyFeatures(m: AssetManifest, a: Analysis | null): EnergyFeatures {
  const lufs = m.loudness.normalizedLufs ?? m.loudness.integratedLufs;
  if (!a) return { drop: 0.5, bass: 0.5, transients: 0.5, lufs };
  const dur = m.durationMs || 1;
  const drops = sectionsOf(m.markers).filter((s) => /drop/i.test(s.label ?? ''));
  const slice = (arr: number[], s: number, e: number) => arr.slice(Math.floor((s / dur) * arr.length), Math.max(Math.floor((s / dur) * arr.length) + 1, Math.floor((e / dur) * arr.length)));
  const inDrops = (arr: number[]) => (drops.length ? drops.flatMap((d) => slice(arr, d.startMs, d.endMs ?? dur)) : [...arr].sort((x, y) => y - x).slice(0, Math.ceil(arr.length / 4)));
  const energy = a.energy ?? [];
  const low = a.bands3?.low ?? [];
  const high = a.bands3?.high ?? [];
  // Transient-tetthet: andel bøtter der diskanten hopper markert opp fra forrige
  let jumps = 0;
  for (let i = 1; i < high.length; i++) if (high[i]! - high[i - 1]! > 0.15) jumps++;
  return {
    drop: mean(inDrops(energy)),
    bass: mean(inDrops(low)),
    transients: high.length ? jumps / high.length : 0.5,
    lufs
  };
}

/** Rangerer funksjonene innen katalogen og gir 1–10 (én desimal). */
export function energyScores(feats: EnergyFeatures[]): number[] {
  const rank = (vals: number[]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return vals.map((v) => (sorted.length > 1 ? sorted.indexOf(v) / (sorted.length - 1) : 0.5));
  };
  const d = rank(feats.map((f) => f.drop));
  const b = rank(feats.map((f) => f.bass));
  const t = rank(feats.map((f) => f.transients));
  const l = rank(feats.map((f) => f.lufs));
  return feats.map((_, i) => Math.round((1 + 9 * (0.3 * d[i]! + 0.25 * b[i]! + 0.2 * t[i]! + 0.25 * l[i]!)) * 10) / 10);
}

/** Ren intro/outro fra strukturmarkørene (del 2). Mangler de: 16 takter antas ikke – kort (8 s). */
export function introOutro(m: AssetManifest): { introMs: number; outroMs: number } {
  const secs = sectionsOf(m.markers);
  const intro = secs.find((s) => /^intro/i.test(s.label ?? ''));
  const outro = [...secs].reverse().find((s) => /^outro/i.test(s.label ?? ''));
  const firstAfterIntro = intro ? secs.find((s) => s.startMs > intro.startMs) : undefined;
  return {
    introMs: intro ? (intro.endMs ?? firstAfterIntro?.startMs ?? 8000) - intro.startMs : secs[0] && secs[0].startMs > 0 ? secs[0].startMs : 8000,
    outroMs: outro ? m.durationMs - outro.startMs : 8000
  };
}

export function toSbTracks(items: Array<{ manifest: AssetManifest; analysis: Analysis | null }>): SbTrack[] {
  const scores = energyScores(items.map((i) => energyFeatures(i.manifest, i.analysis)));
  return items.map(({ manifest: m }, i) => {
    const io = introOutro(m);
    return {
      id: m.id,
      slug: m.slug,
      variant: m.variant,
      title: m.variantLabel ? `${m.title} (${m.variantLabel})` : m.title,
      durationMs: m.durationMs,
      bpm: m.bpm,
      camelot: m.key?.camelot ?? null,
      lufs: m.loudness.normalizedLufs ?? m.loudness.integratedLufs,
      energy: typeof m.energy === 'number' ? m.energy : scores[i]!,
      draft: isDraft(m),
      extended: /extended/i.test(`${m.variant ?? ''} ${m.variantLabel ?? ''}`),
      ...io,
      bpmConfidence: m.bpmConfidence,
      keyConfidence: m.key?.confidence ?? null
    };
  });
}

/** Låter med lav analyse-sikkerhet: feil BPM eller toneart gir feil sett – foreslå å sjekke dem. */
export const lowConfidence = (t: SbTrack) => (t.bpmConfidence != null && t.bpmConfidence < 0.25) || (t.keyConfidence != null && t.keyConfidence < 0.25) || !t.bpm || !t.camelot;
