import { parseCamelot } from './studio';

/**
 * Del 17: settbygger. Setter sammen DJ-sett av Knuts låter etter etablerte prinsipper:
 * harmonisk miksing (Camelot), tempo, energikurve, mikspunkter på frasegrenser, variasjon og lydnivå.
 *
 * Ærlig avgrensning: ingen trening på «verdens beste sett» – reglene er kjente DJ-prinsipper med vekter
 * som kan justeres, og som justeres litt etter Knuts egne endringer (læring, se adjustWeights).
 * Deterministisk med frø: samme valg gir samme sett. Ren kode, testet i packages/shared/test.
 */

// ---------------------------------------------------------------- Inndata

export interface SbTrack {
  /** Asset-id (versjon + variant). */
  id: string;
  slug: string;
  variant: string | null;
  title: string;
  durationMs: number;
  bpm: number | null;
  camelot: string | null;
  /** Lydnivå for avspilling (utkast: normalisert nivå). */
  lufs: number;
  /** 1–10 (fra analysen, eller Knuts overstyring). */
  energy: number;
  draft: boolean;
  /** Extended-variant (foretrekkes i DJ-sett ≥ 30 min). */
  extended: boolean;
  /** Ren intro: fra start til første seksjon etter «Intro» (ms). */
  introMs: number;
  /** Ren outro: fra start av «Outro» til slutten (ms). */
  outroMs: number;
  bpmConfidence: number | null;
  keyConfidence: number | null;
  /**
   * Samme låt under ulike titler/slugs (lydlikhet eller lik tittel etter rensing, data/dupe-groups.json).
   * Settbyggeren og «Bytt ut» bruker aldri to låter fra samme gruppe. Mangler = slug.
   */
  group?: string | null;
}

/** Hvilken «låt» et spor er: duplikatgruppa hvis den finnes, ellers slug (alle versjoner og varianter). */
export const songKey = (t: Pick<SbTrack, 'slug' | 'group'>) => t.group ?? t.slug;

export type CurveKind = 'warmup' | 'peak' | 'journey' | 'closing' | 'custom';
export const CURVE_NAMES: Record<CurveKind, string> = { warmup: 'Oppvarming', peak: 'Peak time', journey: 'Reise', closing: 'Avslutning', custom: 'Egen' };

export interface Weights {
  harmonic: number;
  tempo: number;
  mix: number;
  lufs: number;
  energy: number;
  variation: number;
}
export const DEFAULT_WEIGHTS: Weights = { harmonic: 1, tempo: 1, mix: 0.6, lufs: 0.3, energy: 1, variation: 0.6 };

export interface BuildOptions {
  durationMin: number;
  curve: CurveKind;
  /** «Egen» kurve: verdier 1–10 jevnt fordelt over settet (minst 2). */
  customCurve?: number[];
  bpmMin?: number | null;
  bpmMax?: number | null;
  startKey?: string | null;
  /** Fest låter (asset-id), eventuelt på bestemt plass (0-basert). */
  mustInclude?: Array<{ id: string; position?: number | null }>;
  /** Utelat låter (slug). */
  exclude?: string[];
  /** Utkast (del 16): av som standard. */
  includeDrafts?: boolean;
  seed?: number;
  weights?: Partial<Weights>;
  /** Kjente gode overganger (fra Knuts innspilte sett): «slugA→slugB». Gir bonus. */
  knownPairs?: string[];
}

// ---------------------------------------------------------------- Kriterie 1: harmonisk (Camelot)

export type Relation = 'same' | 'adjacent' | 'relative' | 'boost2' | 'boost7' | 'clash' | 'unknown';
export const RELATION_TEXT: Record<Relation, string> = {
  same: 'samme toneart',
  adjacent: '±1 på hjulet',
  relative: 'relativ dur/moll',
  boost2: 'energiløft +2',
  boost7: 'energiløft +7 (halvtone opp)',
  clash: 'brudd',
  unknown: 'ukjent toneart'
};

/** Relasjonen fra a til b på Camelot-hjulet (alle 24 nøkler). */
export function camelotRelation(a: string | null, b: string | null): Relation {
  const A = parseCamelot(a);
  const B = parseCamelot(b);
  if (!A || !B) return 'unknown';
  const step = (((B.n - A.n) % 12) + 12) % 12; // med klokka
  if (A.minor === B.minor) {
    if (step === 0) return 'same';
    if (step === 1 || step === 11) return 'adjacent';
    if (step === 2) return 'boost2';
    if (step === 7) return 'boost7';
    return 'clash';
  }
  return step === 0 ? 'relative' : 'clash';
}
const RELATION_COST: Record<Relation, number> = { same: 0, adjacent: 0.1, relative: 0.15, boost2: 0.45, boost7: 0.5, clash: 1, unknown: 0.5 };

// ---------------------------------------------------------------- Kriterie 2: tempo

/** Tempojustering (andel) fra a til b; halv og dobbel tempo regnes som match. */
export function tempoDiff(a: number | null, b: number | null): number | null {
  if (!a || !b) return null;
  const r = b / a;
  return [r, r * 2, r / 2].reduce((best, x) => (Math.abs(x - 1) < Math.abs(best - 1) ? x : best)) - 1;
}
function tempoCost(a: number | null, b: number | null): number {
  const d = tempoDiff(a, b);
  if (d === null) return 0.4;
  const x = Math.abs(d);
  if (x <= 0.03) return (x / 0.03) * 0.25;
  if (x <= 0.06) return 0.25 + ((x - 0.03) / 0.03) * 0.5;
  return 0.75 + Math.min(1, (x - 0.06) / 0.06) * 2.25; // over ±6 %: hardt
}

// ---------------------------------------------------------------- Kriterie 4: mikspunkter

export const barMsOf = (bpm: number | null) => (bpm && bpm > 0 ? (4 * 60_000) / bpm : 2000);
/** Frase: 8, 16 eller 32 takter (største som får plass), ellers 0. */
export function phraseBars(bars: number): 0 | 8 | 16 | 32 {
  if (bars >= 32) return 32;
  if (bars >= 16) return 16;
  if (bars >= 8) return 8;
  return 0;
}
export interface MixPoint {
  /** Når låt A begynner å mikses ut (ms i A). */
  outAtMs: number;
  /** Cue i låt B (ms i B). */
  inAtMs: number;
  bars: 0 | 8 | 16 | 32;
}
/** Mikspunkt på frasegrenser: overlapp = minste av rene outro/intro, rundet ned til 8/16/32 takter. */
export function mixPoint(a: SbTrack, b: SbTrack): MixPoint {
  const bar = barMsOf(a.bpm);
  const bars = phraseBars(Math.floor(Math.min(a.outroMs / bar, b.introMs / barMsOf(b.bpm))));
  const overlap = (bars || 8) * bar;
  // Ut: fra en frasegrense (16 takter fra start) så overlappen slutter ved låtens slutt
  const rawOut = Math.max(0, a.durationMs - overlap);
  const outAtMs = Math.max(0, Math.floor(rawOut / (16 * bar)) * 16 * bar);
  // Inn: B starter slik at introen er ferdig når A er ute
  const inAtMs = Math.max(0, b.introMs - (bars || 8) * barMsOf(b.bpm));
  return { outAtMs: Math.round(outAtMs), inAtMs: Math.round(inAtMs), bars };
}
function mixCost(a: SbTrack, b: SbTrack): number {
  const bars = mixPoint(a, b).bars;
  return bars >= 16 ? 0 : bars === 8 ? 0.4 : 1;
}

// ---------------------------------------------------------------- Kriterie 3: energikurve

/** Målkurven (1–10) ved t ∈ [0, 1]. */
export function curveAt(kind: CurveKind, t: number, custom?: number[]): number {
  const x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case 'warmup':
      return 3.5 + 4.5 * x;
    case 'peak':
      // Høyt, med små pustepauser
      return 8.2 - 0.9 * Math.max(0, Math.sin(x * Math.PI * 5)) ** 4;
    case 'journey': {
      // Bølger opp og ned med topp ved ca. 70 %
      const base = 4 + 5 * Math.exp(-(((x - 0.7) / 0.28) ** 2));
      return Math.min(10, base + 0.8 * Math.sin(x * Math.PI * 4));
    }
    case 'closing':
      return 8 - 4.5 * x;
    case 'custom': {
      const pts = custom && custom.length >= 2 ? custom : [5, 5];
      const f = x * (pts.length - 1);
      const i = Math.min(pts.length - 2, Math.floor(f));
      return pts[i]! + (pts[i + 1]! - pts[i]!) * (f - i);
    }
  }
}

// ---------------------------------------------------------------- Kostnader og poeng

export interface Parts {
  harmonic: number;
  tempo: number;
  mix: number;
  lufs: number;
  energy: number;
  variation: number;
}

/** Kostnad for én overgang (kriterie 1, 2, 4 og 6). Lavere er bedre. */
export function transitionParts(a: SbTrack, b: SbTrack): Pick<Parts, 'harmonic' | 'tempo' | 'mix' | 'lufs'> {
  return {
    harmonic: RELATION_COST[camelotRelation(a.camelot, b.camelot)],
    tempo: tempoCost(a.bpm, b.bpm),
    mix: mixCost(a, b),
    lufs: Math.min(1, Math.max(0, Math.abs(a.lufs - b.lufs) - 2) / 6)
  };
}

interface Ctx {
  w: Weights;
  opts: BuildOptions;
  targetMs: number;
  matrix: Map<string, number>;
  known: Set<string>;
}

const pairKey = (a: SbTrack, b: SbTrack) => `${a.id}>${b.id}`;
function pairCost(ctx: Ctx, a: SbTrack, b: SbTrack): number {
  const k = pairKey(a, b);
  let c = ctx.matrix.get(k);
  if (c === undefined) {
    const p = transitionParts(a, b);
    c = ctx.w.harmonic * p.harmonic + ctx.w.tempo * p.tempo + ctx.w.mix * p.mix + ctx.w.lufs * p.lufs;
    if (ctx.known.has(`${a.slug}→${b.slug}`)) c -= 0.3; // Knut har spilt denne overgangen selv
    ctx.matrix.set(k, c);
  }
  return c;
}

/** Hele settets delscorer (0 = perfekt) og samlet kostnad. */
export function evaluate(seq: SbTrack[], opts: BuildOptions, weights: Weights = { ...DEFAULT_WEIGHTS, ...opts.weights }): { cost: number; parts: Parts } {
  const parts: Parts = { harmonic: 0, tempo: 0, mix: 0, lufs: 0, energy: 0, variation: 0 };
  if (!seq.length) return { cost: Infinity, parts };
  for (let i = 1; i < seq.length; i++) {
    const p = transitionParts(seq[i - 1]!, seq[i]!);
    parts.harmonic += p.harmonic;
    parts.tempo += p.tempo;
    parts.mix += p.mix;
    parts.lufs += p.lufs;
  }
  const n = Math.max(1, seq.length - 1);
  parts.harmonic /= n;
  parts.tempo /= n;
  parts.mix /= n;
  parts.lufs /= n;
  const total = seq.reduce((s, t) => s + t.durationMs, 0);
  let at = 0;
  for (const t of seq) {
    const mid = (at + t.durationMs / 2) / total;
    parts.energy += Math.abs(t.energy - curveAt(opts.curve, mid, opts.customCurve)) / 9;
    at += t.durationMs;
  }
  parts.energy /= seq.length;
  parts.variation = variationPenalty(seq);
  // Første låt: lang intro; siste: tydelig outro
  const edge = (seq[0]!.introMs < 16 * barMsOf(seq[0]!.bpm) ? 0.5 : 0) + (seq[seq.length - 1]!.outroMs < 8 * barMsOf(seq[seq.length - 1]!.bpm) ? 0.5 : 0);
  parts.mix += edge / n;
  const target = opts.durationMin * 60_000;
  const durPenalty = Math.max(0, Math.abs(total - target) / target - 0.05) * 6;
  const cost =
    weights.harmonic * parts.harmonic + weights.tempo * parts.tempo + weights.mix * parts.mix + weights.lufs * parts.lufs + weights.energy * parts.energy * 2 + weights.variation * parts.variation + durPenalty;
  return { cost, parts };
}

/** Kriterie 5: samme toneart mer enn tre ganger på rad, eller nesten lik energi for lenge. */
function variationPenalty(seq: SbTrack[]): number {
  let pen = 0;
  let sameKey = 1;
  let flat = 1;
  for (let i = 1; i < seq.length; i++) {
    sameKey = seq[i]!.camelot && seq[i]!.camelot === seq[i - 1]!.camelot ? sameKey + 1 : 1;
    if (sameKey > 3) pen += 0.5;
    flat = Math.abs(seq[i]!.energy - seq[i - 1]!.energy) < 0.5 ? flat + 1 : 1;
    if (flat > 4) pen += 0.3;
  }
  return pen / Math.max(1, seq.length - 1);
}

/** 0–100 per kriterium (100 = ingen kostnad). */
export function scores(parts: Parts): Record<keyof Parts, number> {
  const s = (v: number, scale = 1) => Math.round(100 * Math.max(0, 1 - v / scale));
  return { harmonic: s(parts.harmonic), tempo: s(parts.tempo, 1.5), mix: s(parts.mix), lufs: s(parts.lufs), energy: s(parts.energy, 0.5), variation: s(parts.variation, 0.5) };
}
export const totalScore = (parts: Parts) => {
  const s = scores(parts);
  return Math.round(0.28 * s.harmonic + 0.2 * s.tempo + 0.14 * s.mix + 0.06 * s.lufs + 0.22 * s.energy + 0.1 * s.variation);
};

// ---------------------------------------------------------------- Kandidater

/**
 * Kandidatene: bare låter (ikke live-sett), uten utkast som standard, uten utelatte, innenfor BPM-spennet.
 * Én versjon per låt (kriterie 5): Extended foretrekkes i sett på 30 min eller mer (kriterie 7).
 */
export function candidates(all: SbTrack[], opts: BuildOptions): SbTrack[] {
  const ex = new Set(opts.exclude ?? []);
  const must = new Set((opts.mustInclude ?? []).map((m) => m.id));
  const bySlug = new Map<string, SbTrack[]>();
  for (const t of all) {
    if (ex.has(t.slug) && !must.has(t.id)) continue;
    if (t.draft && !opts.includeDrafts && !must.has(t.id)) continue;
    if (!must.has(t.id) && t.bpm != null && ((opts.bpmMin != null && t.bpm < opts.bpmMin) || (opts.bpmMax != null && t.bpm > opts.bpmMax))) continue;
    bySlug.set(songKey(t), [...(bySlug.get(songKey(t)) ?? []), t]);
  }
  const preferExtended = opts.durationMin >= 30;
  return [...bySlug.values()].map((vs) => {
    const forced = vs.find((v) => must.has(v.id));
    if (forced) return forced;
    const ext = vs.find((v) => v.extended);
    // Flere låter i samme duplikatgruppe: release-klar (f.eks. LANDR-master) før umastret
    const orig = vs.find((v) => !v.variant && !v.draft) ?? vs.find((v) => !v.variant) ?? vs.find((v) => !v.draft) ?? vs[0]!;
    return preferExtended && ext ? ext : orig;
  });
}

// ---------------------------------------------------------------- Søk

/** Deterministisk PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SetResult {
  tracks: SbTrack[];
  cost: number;
  parts: Parts;
  score: number;
  totalMs: number;
}

/**
 * Bygger ett sett: beam search (bredde 24) fram til målvarigheten, så lokalt søk med simulert nedkjøling
 * (bytt plass, bytt ut, flytt) mot hele målet. Festede låter på bestemte plasser står; festede uten plass
 * blir med, men kan flyttes. `avoid` = låter (slug) som gir litt straff (for å lage ulike alternativer).
 */
export function buildSet(all: SbTrack[], opts: BuildOptions, avoid: Set<string> = new Set()): SetResult | null {
  const w: Weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const pool = candidates(all, opts);
  if (!pool.length) return null;
  const ctx: Ctx = { w, opts, targetMs: opts.durationMin * 60_000, matrix: new Map(), known: new Set(opts.knownPairs ?? []) };
  const byId = new Map(pool.map((t) => [t.id, t]));
  const pinned = new Map<number, SbTrack>();
  const mustFree: SbTrack[] = [];
  for (const m of opts.mustInclude ?? []) {
    const t = byId.get(m.id);
    if (!t) continue;
    if (m.position != null && m.position >= 0) pinned.set(m.position, t);
    else mustFree.push(t);
  }
  const avoidCost = (t: SbTrack) => (avoid.has(songKey(t)) ? 0.35 : 0);
  const energyCost = (t: SbTrack, midMs: number) => (Math.abs(t.energy - curveAt(opts.curve, Math.min(1, midMs / ctx.targetMs), opts.customCurve)) / 9) * 2 * w.energy;

  // ---- Beam search
  interface State {
    seq: SbTrack[];
    used: Set<string>;
    ms: number;
    cost: number;
  }
  const BEAM = 24;
  let beam: State[] = [{ seq: [], used: new Set(), ms: 0, cost: 0 }];
  const done: State[] = [];
  const startOk = (t: SbTrack) => !opts.startKey || t.camelot === opts.startKey || pinned.has(0);
  for (let step = 0; step < 80 && beam.length; step++) {
    const next: State[] = [];
    for (const s of beam) {
      const pos = s.seq.length;
      const fixed = pinned.get(pos);
      const opts2 = fixed ? [fixed] : pool;
      for (const t of opts2) {
        if (s.used.has(songKey(t))) continue;
        if (!fixed && [...pinned.values()].some((p) => songKey(p) === songKey(t))) continue; // står på en annen plass
        if (pos === 0 && !fixed && !startOk(t)) continue;
        const prev = s.seq[pos - 1];
        let c = s.cost + (prev ? pairCost(ctx, prev, t) : t.introMs < 16 * barMsOf(t.bpm) ? 0.3 : 0) + energyCost(t, s.ms + t.durationMs / 2) + avoidCost(t);
        // Variasjon: samme toneart for mange på rad
        if (pos >= 3 && t.camelot && s.seq.slice(-3).every((x) => x.camelot === t.camelot)) c += 0.5 * w.variation;
        const used = new Set(s.used);
        used.add(songKey(t));
        const st = { seq: [...s.seq, t], used, ms: s.ms + t.durationMs, cost: c };
        if (st.ms >= ctx.targetMs * 0.97) done.push(st);
        else next.push(st);
      }
    }
    // Tomt for låter før lengden er nådd (liten katalog): behold det lengste vi har, ikke gi opp
    if (!next.length) break;
    next.sort((a, b) => a.cost / a.seq.length - b.cost / b.seq.length);
    // Litt bredde i toppen: ikke bare varianter av samme start
    beam = next.slice(0, BEAM);
    if (done.length >= BEAM * 2) break;
  }
  const pick = (done.length ? done : beam).map((s) => s.seq);
  if (!pick.length) return null;
  let best = pick[0]!;
  let bestCost = Infinity;
  const full = (seq: SbTrack[]) => evaluate(seq, opts, w).cost + seq.reduce((s, t) => s + avoidCost(t), 0);
  for (const seq of pick) {
    const c = full(withMust(seq, mustFree, ctx));
    if (c < bestCost) {
      bestCost = c;
      best = withMust(seq, mustFree, ctx);
    }
  }

  // ---- Lokalt søk (simulert nedkjøling)
  const rand = rng(opts.seed ?? 1);
  const locked = (i: number) => pinned.has(i);
  const mustIds = new Set(mustFree.map((t) => t.id));
  let cur = best;
  let curCost = bestCost;
  const iters = Math.min(6000, 400 + pool.length * 25);
  for (let k = 0; k < iters; k++) {
    const temp = 0.3 * (1 - k / iters) + 0.002;
    const cand = [...cur];
    const r = rand();
    const i = Math.floor(rand() * cand.length);
    if (locked(i)) continue;
    if (r < 0.4) {
      const j = Math.floor(rand() * cand.length);
      if (j === i || locked(j)) continue;
      [cand[i], cand[j]] = [cand[j]!, cand[i]!];
    } else if (r < 0.8) {
      if (mustIds.has(cand[i]!.id)) continue;
      const used = new Set(cand.map(songKey));
      const free = pool.filter((t) => !used.has(songKey(t)) && ![...pinned.values()].some((p) => songKey(p) === songKey(t)));
      if (!free.length) continue;
      cand[i] = free[Math.floor(rand() * free.length)]!;
    } else {
      // Legg til eller fjern én for å treffe varigheten bedre
      const total = cand.reduce((s, t) => s + t.durationMs, 0);
      if (total > ctx.targetMs && cand.length > 2 && !mustIds.has(cand[i]!.id)) cand.splice(i, 1);
      else {
        const used = new Set(cand.map(songKey));
        const free = pool.filter((t) => !used.has(songKey(t)));
        if (!free.length) continue;
        cand.splice(i + 1, 0, free[Math.floor(rand() * free.length)]!);
      }
      if ([...pinned.entries()].some(([p, t]) => cand[p]?.id !== t.id)) continue;
    }
    const c = full(cand);
    if (c < curCost || rand() < Math.exp((curCost - c) / temp)) {
      cur = cand;
      curCost = c;
      if (c < bestCost) {
        best = cand;
        bestCost = c;
      }
    }
  }
  const ev = evaluate(best, opts, w);
  return { tracks: best, cost: ev.cost, parts: ev.parts, score: totalScore(ev.parts), totalMs: best.reduce((s, t) => s + t.durationMs, 0) };
}

/** Sett inn festede låter uten plass der de koster minst (erstatter den som passer dårligst ved behov). */
function withMust(seq: SbTrack[], must: SbTrack[], ctx: Ctx): SbTrack[] {
  let out = seq.filter((t) => !must.some((m) => songKey(m) === songKey(t)));
  for (const m of must) {
    let bestI = 0;
    let bestC = Infinity;
    for (let i = 0; i <= out.length; i++) {
      const a = out[i - 1];
      const b = out[i];
      const c = (a ? pairCost(ctx, a, m) : 0) + (b ? pairCost(ctx, m, b) : 0) - (a && b ? pairCost(ctx, a, b) : 0);
      if (c < bestC) {
        bestC = c;
        bestI = i;
      }
    }
    out = [...out.slice(0, bestI), m, ...out.slice(bestI)];
  }
  // For langt nå? Fjern den dyreste ikke-festede fra slutten av lengden
  const total = () => out.reduce((s, t) => s + t.durationMs, 0);
  while (total() > ctx.targetMs * 1.08 && out.length > must.length + 1) {
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) if (!must.includes(out[i]!)) {
      idx = i;
      break;
    }
    if (idx < 0) break;
    out.splice(idx, 1);
  }
  return out;
}

// ---------------------------------------------------------------- Tre alternativer

export type Character = 'harmonic' | 'energy' | 'variety';
export const CHARACTER_NAMES: Record<Character, string> = { harmonic: 'Tryggest harmonisk', energy: 'Mest energi', variety: 'Mest variasjon' };
const PROFILES: Record<Character, Partial<Weights>> = {
  harmonic: { harmonic: 2.5, tempo: 1.5, energy: 0.7, variation: 0.4 },
  energy: { energy: 2.2, harmonic: 0.8, tempo: 1 },
  variety: { variation: 2.5, harmonic: 0.8, energy: 0.9 }
};

/** Tre forslag med ulik karakter; hvert unngår litt det forrige brukte, så de faktisk blir forskjellige. */
export function buildAlternatives(all: SbTrack[], opts: BuildOptions): Array<SetResult & { character: Character }> {
  const out: Array<SetResult & { character: Character }> = [];
  const avoid = new Set<string>();
  (['harmonic', 'energy', 'variety'] as Character[]).forEach((ch, i) => {
    const base = { ...DEFAULT_WEIGHTS, ...opts.weights };
    const prof = PROFILES[ch];
    const w = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v * (prof[k as keyof Weights] ?? 1)])) as unknown as Weights;
    const curveOpts = ch === 'energy' && opts.curve !== 'custom' ? { ...opts, customCurve: sampleCurve(opts.curve).map((v) => Math.min(10, v + 1)), curve: 'custom' as const } : opts;
    const r = buildSet(all, { ...curveOpts, weights: w, seed: (opts.seed ?? 1) * 7 + i }, avoid);
    if (r) {
      // Vis delscorer mot den valgte kurven (ikke den løftede)
      const ev = evaluate(r.tracks, opts);
      out.push({ ...r, cost: ev.cost, parts: ev.parts, score: totalScore(ev.parts), character: ch });
      for (const t of r.tracks) avoid.add(songKey(t));
    }
  });
  return out;
}
export const sampleCurve = (kind: CurveKind, custom?: number[], n = 11) => Array.from({ length: n }, (_, i) => curveAt(kind, i / (n - 1), custom));

// ---------------------------------------------------------------- Bytt ut og forklar

/** «Bytt ut»: de beste alternativene som passer begge naboene og energikurven på plassen. */
export function replacementsFor(seq: SbTrack[], pos: number, all: SbTrack[], opts: BuildOptions, n = 5): Array<{ track: SbTrack; cost: number }> {
  const w: Weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const ctx: Ctx = { w, opts, targetMs: opts.durationMin * 60_000, matrix: new Map(), known: new Set(opts.knownPairs ?? []) };
  // Ingen andre versjoner av låtene i settet, heller ikke av den som byttes ut
  const used = new Set(seq.map(songKey));
  const before = seq.slice(0, pos).reduce((s, t) => s + t.durationMs, 0);
  const total = seq.reduce((s, t) => s + t.durationMs, 0);
  return candidates(all, opts)
    .filter((t) => !used.has(songKey(t)))
    .map((t) => {
      const a = seq[pos - 1];
      const b = seq[pos + 1];
      const mid = (before + t.durationMs / 2) / total;
      const cost = (a ? pairCost(ctx, a, t) : 0) + (b ? pairCost(ctx, t, b) : 0) + (Math.abs(t.energy - curveAt(opts.curve, mid, opts.customCurve)) / 9) * 2 * w.energy;
      return { track: t, cost };
    })
    .sort((x, y) => x.cost - y.cost)
    .slice(0, n);
}

export interface TransitionInfo {
  relation: Relation;
  label: string;
  tempoPct: number | null;
  mix: MixPoint;
  quality: 'good' | 'ok' | 'poor';
}
/** Forklaringen på en overgang: «8A → 9A», tempo i %, mikspunkt og farge. */
export function explainTransition(a: SbTrack, b: SbTrack): TransitionInfo {
  const relation = camelotRelation(a.camelot, b.camelot);
  const p = transitionParts(a, b);
  const c = p.harmonic + p.tempo + p.mix * 0.6;
  const d = tempoDiff(a.bpm, b.bpm);
  return {
    relation,
    label: `${a.camelot ?? '?'} → ${b.camelot ?? '?'}`,
    tempoPct: d === null ? null : Math.round(d * 1000) / 10,
    mix: mixPoint(a, b),
    quality: c <= 0.45 ? 'good' : c <= 1.1 ? 'ok' : 'poor'
  };
}

// ---------------------------------------------------------------- Læring (kriterie 14)

export interface LearnEvent {
  type: 'replace' | 'move' | 'remove';
  /** Delkostnadene for låta som ble tatt ut og den som kom inn (replace), relativt til naboene. */
  before?: Pick<Parts, 'harmonic' | 'tempo' | 'mix' | 'lufs'>;
  after?: Pick<Parts, 'harmonic' | 'tempo' | 'mix' | 'lufs'>;
}
/**
 * Justerer vektene litt etter Knuts endringer: når han bytter ut en låt, får kriteriene som ble bedre
 * av byttet, litt mer vekt (±4 % per hendelse, begrenset til 0,5×–2× av standard).
 */
export function adjustWeights(events: LearnEvent[], base: Weights = DEFAULT_WEIGHTS): Weights {
  const w: Weights = { ...base };
  for (const e of events) {
    if (e.type !== 'replace' || !e.before || !e.after) continue;
    for (const k of ['harmonic', 'tempo', 'mix', 'lufs'] as const) {
      const gain = e.before[k] - e.after[k];
      if (Math.abs(gain) < 0.05) continue;
      w[k] *= gain > 0 ? 1.04 : 0.98;
      w[k] = Math.min(base[k] * 2, Math.max(base[k] * 0.5, w[k]));
    }
  }
  return w;
}
