import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { BUILT_IN_PRESETS, explainTransition, presetById, suggestPreset, toSbTracks, type AssetManifest, type CatalogIndex, type FxPreset, type SbTrack, type TransitionInfo } from '@gv/shared';
import { FFMPEG, run } from './ffmpeg';
import { findMaster } from './share';

/**
 * Del 20 C: «Hør før du spiller». En forhåndsvisning (30–60 s) av overgangen A → B, laget med ffmpeg:
 *  - B tempojusteres til A med tonehøyden bevart (rubberband, ellers atempo) og legges på takt-rutenettet,
 *  - volum og EQ følger presetet (blend med bass swap, filter fade, echo out, reverb, kutt, rolig fade),
 *  - automatisk kvalitetssjekk: takt-justering (krysskorrelasjon av anslag, mål < 15 ms), basskollisjon,
 *    vokal oppå vokal og nivåhopp. Stryker den, lages et alternativ automatisk (kortere/annen type).
 * Filen spilles som vanlig lyd (ingen Web Audio), så den virker på mobil og i appen.
 * Cache i data/renders/ (maks RENDER_CAP_BYTES, eldste slettes først). Bare filer der slettes.
 */
export const RENDER_VERSION = 5;
export const RENDER_CAP_BYTES = 2 * 1024 ** 3;
const PCM_RATE = 11025;

export interface VersionRef {
  slug: string;
  variant: string | null;
  version: number;
}
export interface RenderQuality {
  ok: boolean;
  /** Avvik i takt-justering i overlappen (ms), null når overlappen er for kort til å måle (kutt). */
  offsetMs: number | null;
  /** Med fortegn: positiv = B kommer for sent (brukes til finjustering). */
  lagMs?: number | null;
  bassClash: boolean;
  vocalClash: boolean;
  levelJumpDb: number;
  notes: string[];
}
export interface RenderResult {
  id: string;
  file: string;
  preset: string;
  presetName: string;
  bars: number;
  kind: 'blend' | 'short';
  durationMs: number;
  quality: RenderQuality;
  /** Satt når første forsøk strøk: alternativet som ble laget automatisk. */
  alternative?: Omit<RenderResult, 'alternative'>;
}

type Recipe = 'blend' | 'bass-swap' | 'filter-fade' | 'echo-out' | 'reverb' | 'cut' | 'fade-out';
const RECIPE: Record<string, Recipe> = {
  'long-blend-32': 'bass-swap',
  'bass-swap-16': 'bass-swap',
  'filter-fade': 'filter-fade',
  'echo-out': 'echo-out',
  'reverb-wash': 'reverb',
  'cut-on-drop': 'cut',
  'loop-build': 'cut',
  'loop-roll': 'cut',
  backspin: 'cut',
  'acapella-layer': 'blend',
  'energy-lift': 'blend',
  'slow-fade': 'fade-out'
};
export const recipeFor = (preset: string, kind: 'blend' | 'short'): Recipe => RECIPE[preset] ?? (kind === 'short' ? 'echo-out' : 'blend');

async function readIndex(mediaDir: string) {
  return JSON.parse(await readFile(path.join(path.resolve(mediaDir), 'index.json'), 'utf8')) as CatalogIndex;
}
async function loadVersion(mediaDir: string, ref: VersionRef) {
  const idx = await readIndex(mediaDir);
  const e = idx.assets.find((a) => a.slug === ref.slug && (a.variant ?? null) === (ref.variant ?? null) && a.version === ref.version);
  if (!e) throw Object.assign(new Error(`Fant ikke ${ref.slug} v${ref.version}`), { status: 404 });
  const dir = path.dirname(path.join(path.resolve(mediaDir), e.manifest));
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as AssetManifest;
  const master = findMaster(dir);
  if (!master) throw Object.assign(new Error(`${manifest.title} mangler master.flac`), { status: 409 });
  return { manifest, master };
}

/** Vault demper bare (som spilleren): ned til målnivået, aldri opp. */
const gainDb = (m: AssetManifest, target = -14) => Math.min(0, target - (m.loudness.normalizedLufs ?? m.loudness.integratedLufs ?? target));

/**
 * ffmpeg-grafen for en overgang. Tidslinja i resultatet: t = 0 er `lead` før A sitt mikspunkt.
 * Ren funksjon (testes): gir argumentene og tidene, kjører ikke noe.
 */
export function renderPlan(a: { m: AssetManifest; master: string }, b: { m: AssetManifest; master: string }, info: TransitionInfo, recipe: Recipe, haveRubberband: boolean, nudgeMs = 0, rateAdjust = 1) {
  // Tempoet fra takt-rutenettet (stem-analysen) er mer presist enn ingest-tempoet når det finnes
  const bpmA = a.m.groove?.gridBpm ?? a.m.bpm ?? 124;
  const bpmB = b.m.groove?.gridBpm ?? b.m.bpm ?? bpmA;
  const barA = 240_000 / bpmA;
  const r = Math.max(0.85, Math.min(1.15, (bpmA / bpmB) * rateAdjust)); // B spilles i A sitt tempo (justert mot målt drift)
  const bars = info.mix.bars || (recipe === 'cut' ? 0 : 4);
  const ovMs = recipe === 'cut' ? 0 : bars * barA;
  const lead = Math.min(16 * barA, 20_000, info.mix.outAtMs);
  const aStart = Math.max(0, info.mix.outAtMs - lead);
  const tailMs = Math.min(16 * barA, 20_000);
  const L0 = (info.mix.outAtMs - aStart) / 1000; // sekunder i resultatet der overgangen starter
  const ov = ovMs / 1000;
  const total = L0 + ov + tailMs / 1000;
  const aLen = Math.min((a.m.durationMs - aStart) / 1000, L0 + ov + (recipe === 'echo-out' || recipe === 'reverb' ? 0 : 0.05));
  const bSrcLen = Math.max(1, (ov + tailMs / 1000) * r);
  const swap = L0 + ov / 2;
  const f = (n: number) => n.toFixed(3);
  // A: demping til målnivå, så oppskriften
  const aChain: string[] = [`volume=${gainDb(a.m).toFixed(2)}dB`];
  const bChain: string[] = [haveRubberband ? `rubberband=tempo=${r.toFixed(5)}:pitch=1` : `atempo=${r.toFixed(5)}`, `volume=${gainDb(b.m).toFixed(2)}dB`, `adelay=${Math.round(L0 * 1000)}|${Math.round(L0 * 1000)}`];
  const beat = 60_000 / bpmA;
  switch (recipe) {
    case 'bass-swap':
    case 'blend':
      aChain.push(`volume='if(lt(t,${f(swap)}),1,max(0,1-(t-${f(swap)})/${f(Math.max(0.1, ov / 2))}))':eval=frame`);
      bChain.push(`volume='if(lt(t,${f(L0)}),0,min(1,(t-${f(L0)})/${f(Math.max(0.1, ov / 2))}))':eval=frame`);
      if (recipe === 'bass-swap') {
        aChain.push(`highpass=f=180:enable='gte(t,${f(swap)})'`);
        bChain.push(`highpass=f=180:enable='lt(t,${f(swap)})'`);
      }
      break;
    case 'filter-fade':
      for (const [i, hz] of [300, 700, 1600, 3500].entries()) aChain.push(`highpass=f=${hz}:enable='gte(t,${f(L0 + (ov * i) / 4)})'`);
      aChain.push(`volume='if(lt(t,${f(L0 + ov * 0.75)}),1,max(0,1-(t-${f(L0 + ov * 0.75)})/${f(Math.max(0.1, ov / 4))}))':eval=frame`);
      bChain.push(`volume='min(1,max(0,(t-${f(L0)})/${f(Math.min(2, Math.max(0.1, ov / 4)))}))':eval=frame`);
      break;
    case 'echo-out':
      // A kuttes på mikspunktet, men ekkoet (ett slag) klinger ut over B sin start
      aChain.push(`atrim=0:${f(L0)}`, `apad=pad_dur=${f(4 * barA / 1000)}`, `aecho=0.9:0.75:${Math.round(beat)}|${Math.round(beat * 2)}:0.5|0.3`, `afade=t=out:st=${f(L0)}:d=${f(Math.min(6, (4 * barA) / 1000))}`);
      bChain.push(`afade=t=in:st=${f(L0)}:d=0.05`);
      break;
    case 'reverb':
      aChain.push(`atrim=0:${f(L0 + ov / 2)}`, `apad=pad_dur=6`, `aecho=0.8:0.85:40|73|117|163:0.5|0.4|0.3|0.2`, `afade=t=out:st=${f(L0)}:d=${f(Math.max(2, ov / 2))}`);
      bChain.push(`afade=t=in:st=${f(L0)}:d=${f(Math.min(4, Math.max(0.5, ov / 2)))}`);
      break;
    case 'cut':
      aChain.push(`atrim=0:${f(L0)}`, `afade=t=out:st=${f(Math.max(0, L0 - 0.01))}:d=0.01`);
      break;
    case 'fade-out':
      aChain.push(`afade=t=out:st=${f(L0)}:d=${f(Math.max(4, ov || 8))}`);
      break;
  }
  const withB = recipe !== 'fade-out';
  // Måledelene (pa/pb) tas ut FØR oppskriften (EQ, volum, ekko): bare demping, tempo og plassering. Da måles
  // takt-justeringen på kicken også der B har bassen av i første halvdel av en bass swap.
  const [gainA, ...procA] = aChain;
  const [tempoB, gainB, delayB, ...procB] = bChain;
  const mono = `aresample=${PCM_RATE},pan=mono|c0=0.5*c0+0.5*c1,atrim=0:${f(total)}`;
  const graph = withB
    ? `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,${gainA},asplit=2[a0][ar];[a0]${procA.length ? procA.join(',') : 'anull'}[a1];[1:a]aformat=sample_rates=44100:channel_layouts=stereo,${tempoB},${gainB},${delayB},asplit=2[b0][br];[b0]${procB.length ? procB.join(',') : 'anull'}[b1];[a1][b1]amix=inputs=2:normalize=0:duration=longest,alimiter=limit=0.95,atrim=0:${f(total)}[mix];[ar]${mono}[pa];[br]${mono}[pb]`
    : `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,${gainA},asplit=2[a0][ar];[a0]${procA.length ? procA.join(',') : 'anull'},alimiter=limit=0.95[mix];[ar]${mono}[pa]`;  // Finjustering: B startes litt senere i kilden når den kom for sent (nudge i resultatets tid × tempo)
  return { graph, aStart: aStart / 1000, aLen, bStart: Math.max(0, info.mix.inAtMs + nudgeMs * r) / 1000, bSrcLen, L0, ov, total, r, withB };
}

// ---------------------------------------------------------------- kvalitetssjekk (ren, testes)

function frames(x: Int16Array, hop: number): Float32Array {
  const n = Math.floor(x.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += (x[j]! / 32768) ** 2;
    out[i] = Math.sqrt(s / hop);
  }
  return out;
}
function onsetCurve(rms: Float32Array): Float32Array {
  const o = new Float32Array(rms.length);
  for (let i = 1; i < rms.length; i++) o[i] = Math.max(0, rms[i]! - rms[i - 1]!);
  return o;
}
/** Enkel lavpass (én pol) for bassenergi. */
function lowpass(x: Int16Array, hz: number, rate = PCM_RATE): Int16Array {
  const a = Math.exp((-2 * Math.PI * hz) / rate);
  const y = new Int16Array(x.length);
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    p = (1 - a) * x[i]! + a * p;
    y[i] = p;
  }
  return y;
}
const db = (x: number) => 20 * Math.log10(Math.max(1e-6, x));

/**
 * Måler den ferdige overgangen fra de to bearbeidede delene (mono PCM, PCM_RATE).
 * - offset: krysskorrelasjon av anslagskurvene i overlappen (±120 ms, 2,5 ms oppløsning)
 * - bass: begge med kraftig bass (< 120 Hz) samtidig i mer enn 30 % av overlappen
 * - nivå: forskjellen i lydnivå (LUFS) mellom låtene etter dempingen til målnivået – ikke forskjellen mellom en rolig
 *   outro og en ny intro, som er musikk og ikke et problem. Over 3 dB merkes.
 */
/** Avvik (med fortegn, ms) i første og andre halvdel av overlappen – forskjellen er tempodrift. */
export function halfLags(pa: Int16Array, pb: Int16Array, L0: number, ov: number): [number, number] | null {
  if (ov < 6) return null;
  const one = (from: number, len: number) => measureLag(pa, pb, from, len);
  const a = one(L0, ov / 2);
  const b = one(L0 + ov / 2, ov / 2);
  return a == null || b == null ? null : [a, b];
}

/**
 * Kick-tider (sekunder) i et utsnitt: topper i bassbåndet, flyttet til starten av anslaget i bredbåndssignalet
 * (der det først når halve toppen). Ulike kick-lyder gir da samme tidspunkt for samme slag.
 */
function kickTimes(x: Int16Array, from: number, len: number): number[] {
  const a = Math.max(0, Math.floor(from * PCM_RATE));
  const b = Math.min(x.length, Math.floor((from + len) * PCM_RATE));
  if (b - a < PCM_RATE) return [];
  const seg = x.subarray(a, b);
  const low = lowpass(seg, 150);
  const env = new Float32Array(seg.length);
  const k = Math.exp(-1 / (0.004 * PCM_RATE));
  let p = 0;
  for (let i = 0; i < low.length; i++) env[i] = p = Math.max(Math.abs(low[i]!), k * p);
  const sorted = [...env].sort((q, r) => q - r);
  const thr = 0.35 * (sorted[Math.floor(sorted.length * 0.99)] ?? 0);
  const gap = Math.round(0.2 * PCM_RATE);
  const out: number[] = [];
  let last = -gap;
  for (let i = 1; i < env.length; i++) {
    if (env[i]! < thr || env[i - 1]! >= thr || i - last < gap) continue;
    last = i;
    // Starten av anslaget i bredbåndet: gå bakover (maks 25 ms) til nivået er under halvparten av toppen
    let top = 0;
    for (let j = i; j < Math.min(seg.length, i + Math.round(0.015 * PCM_RATE)); j++) top = Math.max(top, Math.abs(seg[j]!));
    let s = i;
    for (let j = i; j > Math.max(0, i - Math.round(0.025 * PCM_RATE)); j--) {
      if (Math.abs(seg[j]!) < 0.5 * top) {
        s = j;
        break;
      }
    }
    out.push((a + s) / PCM_RATE);
  }
  return out;
}

/** Median av (B-kick − nærmeste A-kick) i ms, når minst 6 kick har en partner innen 120 ms. */
function measureLag(pa: Int16Array, pb: Int16Array, from: number, len: number): number | null {
  const ka = kickTimes(pa, from, len);
  const kb = kickTimes(pb, from, len);
  if (ka.length < 4 || kb.length < 4) return null;
  const d: number[] = [];
  for (const t of kb) {
    let best = Infinity;
    for (const s of ka) if (Math.abs(t - s) < Math.abs(best)) best = t - s;
    if (Math.abs(best) <= 0.12) d.push(best * 1000);
  }
  if (d.length < 6) return null;
  d.sort((q, r) => q - r);
  return Math.round(d[Math.floor(d.length / 2)]! * 2) / 2;
}
export function measureQuality(pa: Int16Array, pb: Int16Array | null, L0: number, ov: number, vocalClash: boolean, recipe: Recipe, levelJumpDbIn = 0): RenderQuality {
  const notes: string[] = [];
  const hop = Math.round(PCM_RATE * 0.0025);
  let offsetMs: number | null = null;
  let lagMs: number | null = null;
  let bassClash = false;
  if (pb && ov >= 2) {
    lagMs = measureLag(pa, pb, L0, ov);
    offsetMs = lagMs == null ? null : Math.abs(lagMs);
    if (recipe === 'blend') {
      const la = frames(lowpass(pa, 120), Math.round(PCM_RATE * 0.1));
      const lb = frames(lowpass(pb, 120), Math.round(PCM_RATE * 0.1));
      const s10 = Math.floor(L0 * 10);
      const e10 = Math.floor((L0 + ov) * 10);
      const peak = (x: Float32Array) => [...x].sort((p, q) => p - q)[Math.floor(x.length * 0.95)] ?? 0;
      const pA = peak(la);
      const pB = peak(lb);
      let both = 0;
      for (let i = s10; i < e10; i++) if (la[i]! > 0.4 * pA && lb[i]! > 0.4 * pB) both++;
      bassClash = e10 > s10 && both / (e10 - s10) > 0.3;
    }
  }
  const levelJumpDb = pb ? Math.round(levelJumpDbIn * 10) / 10 : 0;
  if (offsetMs != null && offsetMs >= 15) notes.push(`Takt-justering ${offsetMs} ms (mål < 15)`);
  if (bassClash) notes.push('Bass i begge samtidig');
  if (vocalClash) notes.push('Vokal oppå vokal');
  if (Math.abs(levelJumpDb) > 3) notes.push(`Nivåhopp ${levelJumpDb > 0 ? '+' : ''}${levelJumpDb} dB`);
  return { ok: notes.length === 0, offsetMs, lagMs, bassClash, vocalClash, levelJumpDb, notes };
}

// ---------------------------------------------------------------- rendering

let rubberband: boolean | null = null;
async function hasRubberband(): Promise<boolean> {
  if (rubberband !== null) return rubberband;
  const r = await run(FFMPEG, ['-hide_banner', '-filters'], { allowFail: true });
  rubberband = /\srubberband\s/.test(r.stdout);
  return rubberband;
}

export async function renderTransition(o: { mediaDir: string; dataDir: string; from: VersionRef; to: VersionRef; preset?: string | null; noAlternative?: boolean }): Promise<RenderResult> {
  const A = await loadVersion(o.mediaDir, o.from);
  const B = await loadVersion(o.mediaDir, o.to);
  const [ta, tb] = toSbTracks([
    { manifest: A.manifest, analysis: null },
    { manifest: B.manifest, analysis: null }
  ]) as [SbTrack, SbTrack];
  const info = explainTransition(ta, tb);
  const presetId = o.preset && presetById(BUILT_IN_PRESETS, o.preset) ? o.preset : (o.preset ?? suggestPreset({ info, energyA: ta.energy, energyB: tb.energy }).id);
  const preset: FxPreset | undefined = presetById(BUILT_IN_PRESETS, presetId);
  const recipe = recipeFor(presetId, info.mix.kind ?? 'blend');
  const first = await renderOnce(o, A, B, info, presetId, preset?.name ?? presetId, recipe);
  if (first.quality.ok || o.noAlternative) return first;
  // Strøk: prøv et alternativ – kort overgang (echo out), eller kutt hvis det allerede var kort
  const altPreset = recipe === 'echo-out' || recipe === 'cut' ? 'cut-on-drop' : 'echo-out';
  const altInfo: TransitionInfo = { ...info, mix: { ...info.mix, bars: 0, kind: 'short' } };
  const alt = await renderOnce(o, A, B, altInfo, altPreset, presetById(BUILT_IN_PRESETS, altPreset)?.name ?? altPreset, recipeFor(altPreset, 'short'));
  return { ...first, alternative: alt };
}

async function renderOnce(
  o: { mediaDir: string; dataDir: string; from: VersionRef; to: VersionRef },
  A: { manifest: AssetManifest; master: string },
  B: { manifest: AssetManifest; master: string },
  info: TransitionInfo,
  presetId: string,
  presetName: string,
  recipe: Recipe
): Promise<Omit<RenderResult, 'alternative'>> {
  const dir = path.join(o.dataDir, 'renders');
  await mkdir(dir, { recursive: true });
  const key = JSON.stringify([RENDER_VERSION, A.manifest.id, A.manifest.masterSha256, A.manifest.groove?.gridBpm ?? null, B.manifest.id, B.manifest.masterSha256, B.manifest.groove?.gridBpm ?? null, presetId, recipe, info.mix]);
  const id = createHash('sha256').update(key).digest('hex').slice(0, 24);
  const file = path.join(dir, `${id}.m4a`);
  const metaFile = path.join(dir, `${id}.json`);
  if (existsSync(file) && existsSync(metaFile)) {
    const now = new Date();
    await utimes(file, now, now).catch(() => {});
    return JSON.parse(await readFile(metaFile, 'utf8')) as Omit<RenderResult, 'alternative'>;
  }
  const rb = await hasRubberband();
  const tmp = `${file}.partial.m4a`;
  const pa = path.join(dir, `${id}.a.raw`);
  const pb = path.join(dir, `${id}.b.raw`);
  const read = async (p: string) => {
    const b = await readFile(p);
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
  };
  const vocal = info.score.vocalClash && recipe !== 'cut' && recipe !== 'echo-out';
  let lastParts: { pa: Int16Array; pb: Int16Array | null } | null = null;
  const once = async (nudgeMs: number, rateAdjust = 1) => {
    const plan = renderPlan({ m: A.manifest, master: A.master }, { m: B.manifest, master: B.master }, info, recipe, rb, nudgeMs, rateAdjust);
    const args = ['-hide_banner', '-v', 'error', '-y', '-ss', plan.aStart.toFixed(3), '-t', plan.aLen.toFixed(3), '-i', A.master];
    if (plan.withB) args.push('-ss', plan.bStart.toFixed(3), '-t', plan.bSrcLen.toFixed(3), '-i', B.master);
    args.push('-filter_complex', plan.graph, '-map', '[mix]', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp, '-map', '[pa]', '-f', 's16le', '-ac', '1', '-ar', String(PCM_RATE), pa);
    if (plan.withB) args.push('-map', '[pb]', '-f', 's16le', '-ac', '1', '-ar', String(PCM_RATE), pb);
    await run(FFMPEG, args);
    // Lydnivå etter dempingen (Vault demper bare): B minus A i dB
    const eff = (m: AssetManifest) => (m.loudness.normalizedLufs ?? m.loudness.integratedLufs ?? -14) + gainDb(m);
    const parts = { pa: await read(pa), pb: plan.withB ? await read(pb) : null };
    lastParts = parts;
    return { plan, quality: measureQuality(parts.pa, parts.pb, plan.L0, plan.ov, vocal, recipe, eff(B.manifest) - eff(A.manifest)) };
  };
  try {
    let { plan, quality } = await once(0);
    // Finjustering: B kom for tidlig eller sent i forhold til A sine slag – flytt B og lag den én gang til
    if (quality.lagMs != null && Math.abs(quality.lagMs) >= 5 && Math.abs(quality.lagMs) <= 120) {
      // Drift: ulik forskyvning i første og andre halvdel betyr at tempoet ikke er helt likt – strekk B litt
      const halves = lastParts && (lastParts as { pb: Int16Array | null }).pb ? halfLags((lastParts as { pa: Int16Array }).pa, (lastParts as { pb: Int16Array }).pb, plan.L0, plan.ov) : null;
      let nudge = quality.lagMs;
      let rate = 1;
      if (halves && Math.abs(halves[1] - halves[0]) >= 5) {
        // B drøyer (senere i andre halvdel) → spill B litt fortere; forskyv mot starten av overlappen
        rate = 1 + (halves[1] - halves[0]) / ((plan.ov / 2) * 1000);
        nudge = halves[0] - (halves[1] - halves[0]) / 2;
      }
      const second = await once(nudge, rate);
      if ((second.quality.offsetMs ?? Infinity) < (quality.offsetMs ?? Infinity)) ({ plan, quality } = second);
      else await once(0);
    }
    await rename(tmp, file);
    const res = { id, file: `${id}.m4a`, preset: presetId, presetName, bars: info.mix.bars, kind: info.mix.kind ?? 'blend', durationMs: Math.round(plan.total * 1000), quality };
    await import('node:fs/promises').then((fs) => fs.writeFile(metaFile, JSON.stringify(res)));
    await prune(dir);
    return res;
  } finally {
    // Feilsøking: GV_RENDER_DEBUG_DIR=<mappe> beholder måledelene (mono PCM)
    if (process.env.GV_RENDER_DEBUG_DIR) {
      await import('node:fs/promises').then(async (fs) => {
        await fs.copyFile(pa, path.join(process.env.GV_RENDER_DEBUG_DIR!, `${id}.a.raw`)).catch(() => {});
        await fs.copyFile(pb, path.join(process.env.GV_RENDER_DEBUG_DIR!, `${id}.b.raw`)).catch(() => {});
      });
    }
    await rm(pa, { force: true });
    await rm(pb, { force: true });
    await rm(tmp, { force: true });
  }
}

/** Holder data/renders under taket: eldste (sist brukt) slettes først. Bare filer i renders-mappa røres. */
async function prune(dir: string) {
  const files = await Promise.all(
    (await readdir(dir)).filter((n) => n.endsWith('.m4a')).map(async (n) => ({ n, s: await stat(path.join(dir, n)) }))
  );
  let total = files.reduce((s, f) => s + f.s.size, 0);
  for (const f of files.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs)) {
    if (total <= RENDER_CAP_BYTES) break;
    await rm(path.join(dir, f.n), { force: true });
    await rm(path.join(dir, f.n.replace(/\.m4a$/, '.json')), { force: true });
    total -= f.s.size;
  }
}
