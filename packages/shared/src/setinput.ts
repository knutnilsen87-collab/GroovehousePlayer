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

/**
 * `features`: ferdig beregnet på serveren (den samlede katalogen har bare en lett analyse).
 * `groups`: slug::variant → duplikatgruppe (samme låt under ulike titler).
 */
export function toSbTracks(items: Array<{ manifest: AssetManifest; analysis: Analysis | null; features?: EnergyFeatures | null }>, groups?: Record<string, string> | null): SbTrack[] {
  const feats = items.map((i) => i.features ?? energyFeatures(i.manifest, i.analysis));
  const scores = energyScores(feats);
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
      keyConfidence: m.key?.confidence ?? null,
      group: groups?.[`${m.slug}::${m.variant ?? ''}`] ?? null,
      // Likhetsmålet (del 20 E / 26). Uten analyse er verdiene 0,5 (ukjent) – da teller de ikke.
      bass: items[i]!.features || items[i]!.analysis ? feats[i]!.bass : null,
      transients: items[i]!.features || items[i]!.analysis ? feats[i]!.transients : null
    };
  });
}

/** Låter med lav analyse-sikkerhet: feil BPM eller toneart gir feil sett – foreslå å sjekke dem. */
export const lowConfidence = (t: SbTrack) => (t.bpmConfidence != null && t.bpmConfidence < BPM_UNCERTAIN_BELOW) || (t.keyConfidence != null && t.keyConfidence < 0.25) || !t.bpm || !t.camelot;

/**
 * BPM-sikkerhet (`bpmConfidence`) er ikke en sannsynlighet. Den er autokorrelasjonen av anslagskurven ved ett
 * slag delt på autokorrelasjonen ved null forsinkelse (0–1). Ferdigmikset house med tette hi-hats, bass og
 * effekter gir ofte 0,2–0,5 selv når BPM-en er riktig: målt 2026-11-16 lå 96–97 % av låtene med 0,15–0,5 i
 * 118–132 BPM, som de andre. Under 0,15 er bare 59 % der, så først da er tempoet reelt usikkert.
 */
export const BPM_UNCERTAIN_BELOW = 0.15;
export const bpmUncertain = (m: { bpm: number | null; bpmConfidence: number | null }) => m.bpm != null && m.bpmConfidence != null && m.bpmConfidence < BPM_UNCERTAIN_BELOW;
/** «126 BPM», eller «≈126 BPM» når tempoet er usikkert. */
export const bpmLabel = (m: { bpm: number | null; bpmConfidence: number | null }, decimals = 0) => (m.bpm ? `${bpmUncertain(m) ? '≈' : ''}${decimals ? m.bpm.toFixed(decimals) : Math.round(m.bpm)} BPM` : null);
/** Sikkerheten i ord (Låtinfo): tallet alene ser lavt ut for nesten alle låter. */
export const bpmConfidenceText = (v: number | null | undefined) => (v == null ? '–' : v < BPM_UNCERTAIN_BELOW ? `Lav (${v.toFixed(2)}) – sjekk med øret` : v < 0.5 ? `Normal (${v.toFixed(2)})` : `Høy (${v.toFixed(2)})`);
