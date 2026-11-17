import { sectionsOf } from './sections';
import { barMsOf, rng, simOf, songKey, type SbTrack } from './setbuilder';
import { camelotDistance, similarity } from './similarity';
import type { AssetManifest } from './types';

/**
 * Del 26: albumbygger. Andre regler enn DJ-sett: et album skal ha variasjon og bue, ikke sømløs flyt.
 *  - Utvalg: kvalitet (hjerter, avspillinger, mastret, singel-kandidat) og sammenheng (likhetsmålet fra
 *    similarity.ts, delt med «Lag sett fra denne») – men ikke for like låter, og ingen utbrytere.
 *  - Rekkefølge: sterk åpner (kort intro), den sterkeste låta eller en singel blant de tre første, bue
 *    (åpning → oppbygging → midtpunkt → pustepause → klimaks → avslutning) og variasjon mellom nabolåter.
 *  - Aldri to versjoner eller varianter av samme låt (duplikatgruppene, songKey).
 *  - Deterministisk med frø.
 */

export type AlbumFormat = 'single' | 'ep' | 'album';
export const ALBUM_FORMATS: Record<AlbumFormat, { name: string; min: number; max: number; dflt: number; minMs: number; maxMs: number }> = {
  single: { name: 'Single', min: 1, max: 3, dflt: 2, minMs: 0, maxMs: 20 * 60_000 },
  ep: { name: 'EP', min: 4, max: 6, dflt: 5, minMs: 15 * 60_000, maxMs: 30 * 60_000 },
  album: { name: 'Album', min: 8, max: 14, dflt: 10, minMs: 35 * 60_000, maxMs: 55 * 60_000 }
};
/** Vinyl: maks ca. 18–22 min per side. */
export const VINYL_SIDE_MAX_MS = 22 * 60_000;

export interface AlbumTrack extends SbTrack {
  favorite: boolean;
  /** Avspillinger (lokal logg). */
  plays: number;
  singleCandidate: boolean;
  titleNeedsReview: boolean;
  /** Hook for forhåndslytting (ms), se hookMs(). */
  hookMs: number;
}

export type AlbumCharacter = 'strongest' | 'arc' | 'coherence';
export const ALBUM_CHARACTER_NAMES: Record<AlbumCharacter, string> = { strongest: 'Sterkest først', arc: 'Beste bue', coherence: 'Mest sammenheng' };

export interface AlbumOptions {
  format: AlbumFormat;
  /** Antall låter (innenfor formatet). */
  count?: number;
  vinyl?: boolean;
  /** Pool (asset-id). Tom/udefinert = alle. */
  pool?: string[] | null;
  /** «Utelat disse låtene» (slug), f.eks. det som allerede er gitt ut. */
  exclude?: string[];
  includeDrafts?: boolean;
  /** «Album rundt denne» (asset-id). Alltid med. */
  seedId?: string | null;
  /** Låste låter, eventuelt på fast plass. */
  locked?: Array<{ id: string; position?: number | null }>;
  seed?: number;
}

export interface AlbumResult {
  character: AlbumCharacter;
  tracks: AlbumTrack[];
  totalMs: number;
  /** Én kort forklaring per plass. */
  notes: string[];
  /** Pause etter hvert spor (ms), 0 = gapless. Siste er alltid 0. */
  gapsMs: number[];
  /** Vinyl: indeks der side B starter. */
  sideB: number | null;
  warnings: string[];
  cost: number;
}

/** Albumbuen (energi 1–10 ved andel t av albumet). */
export function arcAt(t: number): number {
  // åpning 7 → oppbygging 7,5 → midtpunkt 8,5 (~0,4) → pustepause 4,5 (~0,6) → klimaks 9 (~0,8) → avslutning 5
  const pts: Array<[number, number]> = [
    [0, 7],
    [0.2, 7.5],
    [0.4, 8.5],
    [0.6, 4.5],
    [0.8, 9],
    [1, 5]
  ];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x0, y0] = pts[i - 1]!;
    if (t <= x1) return y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
  }
  return 5;
}

/** Hook for forhåndslytting: første drop eller refreng/hook-seksjon, ellers ca. 30 % inn. 20 s spilles derfra. */
export function hookMs(m: Pick<AssetManifest, 'markers' | 'durationMs'>): number {
  const drop = m.markers.find((k) => k.kind === 'drop');
  const named = sectionsOf(m.markers).find((s) => /chorus|refreng|hook|drop/i.test(s.label ?? ''));
  const at = drop?.startMs ?? named?.startMs ?? Math.round(m.durationMs * 0.3);
  return Math.max(0, Math.min(at, m.durationMs - 20_000));
}

/** Kvalitet 0–1: hjerter, avspillinger (log), mastret, singel-kandidat. */
export function albumQuality(t: AlbumTrack, maxPlays: number): number {
  return quality(t, maxPlays);
}
function quality(t: AlbumTrack, maxPlays: number): number {
  const plays = maxPlays > 0 ? Math.log1p(t.plays) / Math.log1p(maxPlays) : 0;
  return 0.35 * (t.favorite ? 1 : 0) + 0.25 * plays + 0.2 * (t.draft ? 0 : 1) + 0.2 * (t.singleCandidate ? 1 : 0);
}

const isCalm = (t: SbTrack) => t.energy <= 4;
const isHard = (t: SbTrack) => t.energy >= 8;
const shortIntro = (t: SbTrack) => t.introMs <= 16 * barMsOf(t.bpm);

interface Ctx {
  q: Map<string, number>;
  sim: (a: AlbumTrack, b: AlbumTrack) => number;
  w: { quality: number; arc: number; coherence: number; variation: number };
  fmt: (typeof ALBUM_FORMATS)[AlbumFormat];
  vinyl: boolean;
  seedT: AlbumTrack | null;
}

/** Kostnad for et album (lavere er bedre). Harde regler gir stor straff. */
function cost(seq: AlbumTrack[], c: Ctx): number {
  const n = seq.length;
  if (!n) return Infinity;
  let k = 0;
  // Kvalitet: snitt (vektet mot starten)
  k -= c.w.quality * seq.reduce((s, t, i) => s + c.q.get(t.id)! * (i < 3 ? 1.5 : 1), 0) / n;
  // Bue
  if (n >= 3) k += (c.w.arc * seq.reduce((s, t, i) => s + Math.abs(t.energy - arcAt(i / (n - 1))), 0)) / n / 3;
  // Sammenheng: snittlikhet til de andre (utbrytere straffes), men ikke for like naboer
  if (n >= 2) {
    let coh = 0;
    for (const a of seq) {
      const sims = seq.filter((b) => b !== a).map((b) => c.sim(a, b));
      const avg = sims.reduce((s, x) => s + x, 0) / sims.length;
      coh += avg;
      if (avg < 0.35) k += 0.6; // utbryter
    }
    k -= (c.w.coherence * coh) / n;
  }
  // Åpning: kort intro og representativ (energi ≥ 5)
  if (!shortIntro(seq[0]!)) k += 0.4;
  if (seq[0]!.energy < 5) k += 0.4;
  // Den sterkeste (eller en singel) blant de tre første – hard regel
  if (n > 3) {
    const best = Math.max(...seq.map((t) => c.q.get(t.id)!));
    const head = seq.slice(0, 3);
    if (!head.some((t) => c.q.get(t.id)! >= best - 1e-9 || t.singleCandidate)) k += 5;
  }
  // Avslutning: tydelig/rolig slutt
  if (n >= 4 && seq[n - 1]!.energy > 7.5) k += 0.4;
  // Variasjon mellom nabolåter
  let sameKeyRun = 1;
  for (let i = 1; i < n; i++) {
    const a = seq[i - 1]!;
    const b = seq[i]!;
    sameKeyRun = a.camelot && a.camelot === b.camelot ? sameKeyRun + 1 : 1;
    if (sameKeyRun > 2) k += 5 * c.w.variation; // ikke samme toneart mer enn to ganger på rad
    const kd = camelotDistance(a.camelot, b.camelot);
    if (kd != null && kd >= 5) k += 0.25 * c.w.variation; // skurrende hopp
    if (c.sim(a, b) > 0.92) k += 0.6 * c.w.variation; // for like naboer
    if (a.singleCandidate && b.singleCandidate) k += 0.8 * c.w.variation; // spre singlene
    if (i >= 2) {
      const z = seq[i - 2]!;
      if ((isCalm(z) && isCalm(a) && isCalm(b)) || (isHard(z) && isHard(a) && isHard(b))) k += 5 * c.w.variation;
    }
  }
  // Lengde
  const ms = seq.reduce((s, t) => s + t.durationMs, 0);
  if (ms < c.fmt.minMs) k += ((c.fmt.minMs - ms) / 60_000) * 0.5;
  if (ms > c.fmt.maxMs) k += ((ms - c.fmt.maxMs) / 60_000) * 0.5;
  if (c.vinyl) {
    const sb = vinylSplit(seq);
    if (sb == null) k += 5;
    else if (c.q.get(seq[sb]!.id)! < 0.3 && seq[sb]!.energy < 6) k += 0.5; // sterk åpner på side B
  }
  // Frølåt: låter som ligner den vektes opp
  if (c.seedT) k -= (0.5 * seq.reduce((s, t) => s + (t === c.seedT ? 1 : c.sim(t, c.seedT!)), 0)) / n;
  return k;
}

/** Vinyl: indeksen der side B starter, med så like sider som mulig og begge ≤ 22 min. null = går ikke. */
export function vinylSplit(seq: Array<{ durationMs: number }>): number | null {
  const total = seq.reduce((s, t) => s + t.durationMs, 0);
  let best: number | null = null;
  let bestD = Infinity;
  let a = 0;
  for (let i = 1; i < seq.length; i++) {
    a += seq[i - 1]!.durationMs;
    const b = total - a;
    if (a > VINYL_SIDE_MAX_MS || b > VINYL_SIDE_MAX_MS) continue;
    if (Math.abs(a - b) < bestD) {
      bestD = Math.abs(a - b);
      best = i;
    }
  }
  return best;
}

const fmtTime = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

function explain(seq: AlbumTrack[], c: Ctx, sideB: number | null): string[] {
  const n = seq.length;
  const best = Math.max(...seq.map((t) => c.q.get(t.id)!));
  return seq.map((t, i) => {
    const parts: string[] = [];
    const f = n > 1 ? i / (n - 1) : 0;
    if (i === 0) parts.push(`Åpner: ${shortIntro(t) ? `kort intro (${fmtTime(t.introMs)})` : `intro ${fmtTime(t.introMs)}`}, energi ${t.energy.toFixed(1)}`);
    else if (i === n - 1) parts.push(`Avslutning: energi ${t.energy.toFixed(1)}`);
    else if (sideB === i) parts.push(`Åpner side B: energi ${t.energy.toFixed(1)}`);
    else if (f > 0.5 && f < 0.7 && t.energy <= 5.5) parts.push('Pustepause');
    else if (f >= 0.7 && t.energy >= 8) parts.push('Klimaks');
    else if (f >= 0.3 && f <= 0.5) parts.push('Midtpunkt');
    else parts.push(f < 0.3 ? 'Oppbygging' : 'Mot slutten');
    if (c.q.get(t.id)! >= best - 1e-9 && n > 1) parts.push('sterkest');
    if (t.singleCandidate) parts.push('singel-kandidat');
    if (t.favorite) parts.push('♥');
    const prev = seq[i - 1];
    if (prev?.camelot && t.camelot && prev.camelot !== t.camelot) parts.push(`${prev.camelot} → ${t.camelot}`);
    return parts.join(' · ');
  });
}

/** Pause etter hvert spor: gapless når låtene glir i hverandre (nær toneart og tempo), ellers 1–2 s. */
export function gapsFor(seq: SbTrack[]): number[] {
  return seq.map((a, i) => {
    const b = seq[i + 1];
    if (!b) return 0;
    const kd = camelotDistance(a.camelot, b.camelot);
    const tempo = a.bpm && b.bpm ? Math.abs(a.bpm - b.bpm) / b.bpm : 1;
    if (kd != null && kd <= 1 && tempo <= 0.03) return 0;
    return b.energy < a.energy - 2 ? 2000 : 1000;
  });
}

/** Lydnivå: låter som stikker seg ut (mer enn 2 LU fra medianen), særlig umastrede. */
function loudnessWarnings(seq: AlbumTrack[]): string[] {
  const l = [...seq.map((t) => t.lufs)].sort((a, b) => a - b);
  const med = l[Math.floor(l.length / 2)] ?? -9;
  return seq
    .filter((t) => Math.abs(t.lufs - med) > 2)
    .map((t) => `«${t.title}» ligger ${t.lufs > med ? 'høyere' : 'lavere'} enn resten (${t.lufs.toFixed(1)} LUFS mot ${med.toFixed(1)})${t.draft ? ' – umastret, vurder LANDR-mastering' : ''}`);
}

const PROFILES: Record<AlbumCharacter, Ctx['w']> = {
  strongest: { quality: 3, arc: 0.6, coherence: 0.8, variation: 1 },
  arc: { quality: 1, arc: 2.5, coherence: 0.8, variation: 1 },
  coherence: { quality: 1, arc: 0.8, coherence: 3, variation: 1 }
};

/** Kandidatene: én per sang, uten utelatte, og bare pool/umastrede etter valg. */
export function albumCandidates(all: AlbumTrack[], o: AlbumOptions): AlbumTrack[] {
  const ex = new Set(o.exclude ?? []);
  const pool = o.pool?.length ? new Set(o.pool) : null;
  const forced = new Set([...(o.locked ?? []).map((l) => l.id), ...(o.seedId ? [o.seedId] : [])]);
  const by = new Map<string, AlbumTrack[]>();
  for (const t of all) {
    if (!forced.has(t.id)) {
      if (ex.has(t.slug)) continue;
      if (pool && !pool.has(t.id)) continue;
      if (t.draft && o.includeDrafts === false) continue;
    }
    by.set(songKey(t), [...(by.get(songKey(t)) ?? []), t]);
  }
  return [...by.values()].map((vs) => vs.find((v) => forced.has(v.id)) ?? vs.find((v) => !v.variant && !v.draft) ?? vs.find((v) => !v.variant) ?? vs.find((v) => !v.draft) ?? vs[0]!);
}

export function buildAlbum(all: AlbumTrack[], o: AlbumOptions, character: AlbumCharacter = 'arc', avoid: Set<string> = new Set()): AlbumResult | null {
  const fmt = ALBUM_FORMATS[o.format];
  const pool = albumCandidates(all, o);
  const n = Math.max(fmt.min, Math.min(fmt.max, o.count ?? fmt.dflt, pool.length));
  if (!pool.length || n < 1) return null;
  const maxPlays = Math.max(0, ...pool.map((t) => t.plays));
  const simCache = new Map<string, number>();
  const ctx: Ctx = {
    q: new Map(pool.map((t) => [t.id, quality(t, maxPlays)])),
    sim: (a, b) => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      let v = simCache.get(key);
      if (v === undefined) simCache.set(key, (v = similarity(simOf(a), simOf(b))));
      return v;
    },
    w: PROFILES[character],
    fmt,
    vinyl: !!o.vinyl,
    seedT: o.seedId ? (pool.find((t) => t.id === o.seedId) ?? null) : null
  };
  const byId = new Map(pool.map((t) => [t.id, t]));
  const lockedAt = new Map<number, AlbumTrack>();
  const lockedFree: AlbumTrack[] = [];
  for (const l of o.locked ?? []) {
    const t = byId.get(l.id);
    if (!t) continue;
    if (l.position != null && l.position >= 0 && l.position < n) lockedAt.set(l.position, t);
    else lockedFree.push(t);
  }
  if (ctx.seedT && ![...lockedAt.values(), ...lockedFree].includes(ctx.seedT)) lockedFree.push(ctx.seedT);
  const mustIds = new Set([...lockedAt.values(), ...lockedFree].map((t) => t.id));

  // Start: grådig etter kvalitet + likhet til de beste, så lokal søk (simulert nedkjøling)
  const r = rng((o.seed ?? 1) * 31 + ['strongest', 'arc', 'coherence'].indexOf(character));
  const ranked = [...pool].sort((a, b) => ctx.q.get(b.id)! - ctx.q.get(a.id)! - (avoid.has(songKey(a)) ? 0.2 : 0) + (avoid.has(songKey(b)) ? 0.2 : 0) || a.id.localeCompare(b.id));
  const chosen: AlbumTrack[] = [...lockedAt.values(), ...lockedFree];
  for (const t of ranked) {
    if (chosen.length >= n) break;
    if (!chosen.some((x) => songKey(x) === songKey(t))) chosen.push(t);
  }
  // Rekkefølge: låste på plass, resten etter buen (energi nær arcAt)
  const free = chosen.filter((t) => ![...lockedAt.values()].includes(t));
  const seq: AlbumTrack[] = new Array(n);
  for (const [p, t] of lockedAt) seq[p] = t;
  for (let i = 0; i < n; i++) {
    if (seq[i]) continue;
    const target = arcAt(n > 1 ? i / (n - 1) : 0);
    free.sort((a, b) => Math.abs(a.energy - target) - Math.abs(b.energy - target) || a.id.localeCompare(b.id));
    seq[i] = free.shift()!;
  }
  let cur = seq.filter(Boolean);
  let curCost = cost(cur, ctx);
  let best = cur;
  let bestCost = curCost;
  const locked = (i: number) => lockedAt.has(i);
  const iters = 3000 + pool.length * 10;
  for (let k = 0; k < iters; k++) {
    const temp = 0.4 * (1 - k / iters) + 0.003;
    const cand = [...cur];
    const i = Math.floor(r() * cand.length);
    if (locked(i)) continue;
    if (r() < 0.55) {
      const j = Math.floor(r() * cand.length);
      if (j === i || locked(j)) continue;
      [cand[i], cand[j]] = [cand[j]!, cand[i]!];
    } else {
      if (mustIds.has(cand[i]!.id)) continue;
      const used = new Set(cand.map(songKey));
      const opts = pool.filter((t) => !used.has(songKey(t)));
      if (!opts.length) continue;
      cand[i] = opts[Math.floor(r() * opts.length)]!;
    }
    const c = cost(cand, ctx) + cand.reduce((s, t) => s + (avoid.has(songKey(t)) ? 0.15 : 0), 0);
    if (c < curCost || r() < Math.exp((curCost - c) / temp)) {
      cur = cand;
      curCost = c;
      if (c < bestCost) {
        best = cand;
        bestCost = c;
      }
    }
  }
  // Hard regel: den sterkeste låta (eller en singel-kandidat) blant de tre første. Flytt den dit det koster minst.
  if (best.length > 3) {
    const top = Math.max(...best.map((t) => ctx.q.get(t.id)!));
    const strong = (t: AlbumTrack) => ctx.q.get(t.id)! >= top - 1e-9 || t.singleCandidate;
    if (!best.slice(0, 3).some(strong)) {
      const j = best.findIndex(strong);
      let pick: AlbumTrack[] | null = null;
      let pc = Infinity;
      for (let p = 0; p < 3; p++) {
        if (locked(p) || locked(j)) continue;
        const cand = [...best];
        const [t] = cand.splice(j, 1);
        cand.splice(p, 0, t!);
        if ([...lockedAt].some(([lp, lt]) => cand[lp]?.id !== lt.id)) continue;
        const c = cost(cand, ctx);
        if (c < pc) {
          pc = c;
          pick = cand;
        }
      }
      if (pick) {
        best = pick;
        bestCost = pc;
      }
    }
  }
  const sideB = o.vinyl ? vinylSplit(best) : null;
  const warnings = loudnessWarnings(best);
  if (o.vinyl && sideB == null) warnings.push('For langt for vinyl: hver side kan ha maks ca. 22 min.');
  const totalMs = best.reduce((s, t) => s + t.durationMs, 0);
  if (totalMs < fmt.minMs || totalMs > fmt.maxMs) warnings.push(`Lengden (${fmtTime(totalMs)}) er utenfor det vanlige for ${fmt.name} (${fmtTime(fmt.minMs)}–${fmtTime(fmt.maxMs)}).`);
  return { character, tracks: best, totalMs, notes: explain(best, ctx, sideB), gapsMs: gapsFor(best), sideB, warnings, cost: bestCost };
}

/** Tre forslag: «Sterkest først», «Beste bue», «Mest sammenheng» (forskjellige der det går). */
export function buildAlbumAlternatives(all: AlbumTrack[], o: AlbumOptions): AlbumResult[] {
  const out: AlbumResult[] = [];
  const avoid = new Set<string>();
  for (const ch of ['strongest', 'arc', 'coherence'] as AlbumCharacter[]) {
    const r = buildAlbum(all, o, ch, avoid);
    if (!r) continue;
    out.push(r);
    for (const t of r.tracks) avoid.add(songKey(t));
  }
  return out;
}

/** «Bytt ut»: fem alternativer som passer plassen (bue, naboer, sammenheng). */
export function albumReplacements(album: AlbumResult, pos: number, all: AlbumTrack[], o: AlbumOptions, k = 5): AlbumTrack[] {
  const pool = albumCandidates(all, o);
  const used = new Set(album.tracks.map(songKey));
  const maxPlays = Math.max(0, ...pool.map((t) => t.plays));
  const ctx: Ctx = { q: new Map(pool.map((t) => [t.id, quality(t, maxPlays)])), sim: (a, b) => similarity(simOf(a), simOf(b)), w: PROFILES[album.character], fmt: ALBUM_FORMATS[o.format], vinyl: !!o.vinyl, seedT: null };
  for (const t of album.tracks) if (!ctx.q.has(t.id)) ctx.q.set(t.id, quality(t, maxPlays));
  return pool
    .filter((t) => !used.has(songKey(t)))
    .map((t) => {
      const seq = [...album.tracks];
      seq[pos] = t;
      return { t, c: cost(seq, ctx) };
    })
    .sort((a, b) => a.c - b.c || a.t.id.localeCompare(b.t.id))
    .slice(0, k)
    .map((x) => x.t);
}

/** Kurveverdier for visning (samme form som settbyggerens). */
export const sampleArc = (n = 11) => Array.from({ length: n }, (_, i) => arcAt(i / (n - 1)));

/** Etter manuell flytting eller «Bytt ut»: forklaringer, pauser, vinylsider og varsler regnes på nytt. */
export function rescoreAlbum(tracks: AlbumTrack[], all: AlbumTrack[], o: AlbumOptions, character: AlbumCharacter): AlbumResult {
  const pool = albumCandidates(all, o);
  const maxPlays = Math.max(0, ...pool.map((t) => t.plays), ...tracks.map((t) => t.plays));
  const fmt = ALBUM_FORMATS[o.format];
  const ctx: Ctx = { q: new Map([...pool, ...tracks].map((t) => [t.id, quality(t, maxPlays)])), sim: (a, b) => similarity(simOf(a), simOf(b)), w: PROFILES[character], fmt, vinyl: !!o.vinyl, seedT: null };
  const sideB = o.vinyl ? vinylSplit(tracks) : null;
  const warnings = loudnessWarnings(tracks);
  if (o.vinyl && sideB == null) warnings.push('For langt for vinyl: hver side kan ha maks ca. 22 min.');
  const totalMs = tracks.reduce((s, t) => s + t.durationMs, 0);
  if (totalMs < fmt.minMs || totalMs > fmt.maxMs) warnings.push(`Lengden (${fmtTime(totalMs)}) er utenfor det vanlige for ${fmt.name} (${fmtTime(fmt.minMs)}–${fmtTime(fmt.maxMs)}).`);
  return { character, tracks, totalMs, notes: explain(tracks, ctx, sideB), gapsMs: gapsFor(tracks), sideB, warnings, cost: cost(tracks, ctx) };
}
