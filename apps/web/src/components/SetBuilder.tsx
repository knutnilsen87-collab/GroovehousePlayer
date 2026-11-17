import { useEffect, useMemo, useState } from 'react';
import {
  adjustWeights,
  buildAlternatives,
  CHARACTER_NAMES,
  CURVE_NAMES,
  curveAt,
  explainTransition,
  formatTime,
  keyShort,
  lowConfidence,
  RELATION_TEXT,
  replacementsFor,
  SEED_PLACE_NAMES,
  toSbTracks,
  transitionParts,
  type BuildOptions,
  type Character,
  type CurveKind,
  type LearnEvent,
  type SbTrack,
  type SeedPlace,
  type SetResult
} from '@gv/shared/web';
import { assetUrl, dupeGroups, type LoadedAsset } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { useSeedSet } from '../lib/seedset';
import { toastError, usePlaylists, useToast } from '../lib/playlists';
import { CoverArt } from './CoverArt';
import { Panel } from './Deck';
import { DraftBadge } from './Draft';
import { useLockConfirm } from './DjLock';
import { TransitionFx } from './FxChip';
import { fxCuesFor, transitionPreset, useFx } from '../lib/fx';

/**
 * Del 17: settbygger. Velg varighet og kurve; Vault setter sammen tre forslag etter etablerte DJ-prinsipper
 * (harmonisk, tempo, energikurve, mikspunkter, variasjon, lydnivå) og forklarer hver overgang.
 * «Bytt ut», «Lås og bygg på nytt», lagre som Sett-plan og eksporter til rekordbox/M3U.
 */
type Alt = SetResult & { character: Character };
const DURATIONS = [30, 60, 90, 120];
const KEYS = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();
const QUALITY_COLOR = { good: '#3DDC84', ok: '#F5C84B', poor: '#FF6B5A' } as const;
const PART_NAMES: Record<string, string> = { harmonic: 'Harmonisk', tempo: 'Tempo', mix: 'Mikspunkter', lufs: 'Lydnivå', energy: 'Energikurve', variation: 'Variasjon' };

export function SetBuilder({ assets }: { assets: LoadedAsset[] }) {
  const pool = useMemo(() => toSbTracks(assets.filter((a) => a.manifest.kind !== 'set'), dupeGroups()), [assets]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.manifest.id, a])), [assets]);
  const [durationMin, setDuration] = useState(60);
  const [curve, setCurve] = useState<CurveKind>('journey');
  const [custom, setCustom] = useState<number[]>([4, 5, 6, 7, 8, 9, 8, 7, 5]);
  const [bpmMin, setBpmMin] = useState<string>('');
  const [bpmMax, setBpmMax] = useState<string>('');
  const [startKey, setStartKey] = useState<string>('');
  // Del 16 (2026-11-15): «Ta med umastret» er på som standard, og valget huskes
  const [includeDrafts, setIncludeDraftsState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('gv:setbuilder:includeUnmastered') !== '0';
    } catch {
      return true;
    }
  });
  const setIncludeDrafts = (on: boolean) => {
    setIncludeDraftsState(on);
    try {
      localStorage.setItem('gv:setbuilder:includeUnmastered', on ? '1' : '0');
    } catch {
      /* privat modus */
    }
  };
  const [must, setMust] = useState<Array<{ id: string; position: number | null }>>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [seed, setSeed] = useState(1);
  const [alts, setAlts] = useState<Alt[] | null>(null);
  const [active, setActive] = useState(0);
  const [locked, setLocked] = useState<Set<number>>(new Set());
  const [swapAt, setSwapAt] = useState<number | null>(null);
  const [took, setTook] = useState<number | null>(null);
  const [learn, setLearn] = useState<{ events: LearnEvent[]; knownPairs: string[] }>({ events: [], knownPairs: [] });
  const [name, setName] = useState('');
  // Del 20 E: frølåt fra «Lag sett fra denne» (⋯-menyen, fullskjerm, langt trykk på hjertet)
  const seedReq = useSeedSet((s) => s.seedSet);
  const [seedPlace, setSeedPlace] = useState<SeedPlace>('auto');
  const seedTrack = useMemo(() => {
    if (!seedReq) return null;
    return pool.find((t) => t.id === seedReq.id) ?? pool.find((t) => t.slug === seedReq.slug && (seedReq.variant === undefined || t.variant === (seedReq.variant ?? null))) ?? pool.find((t) => t.slug === seedReq.slug) ?? null;
  }, [seedReq, pool]);

  useEffect(() => {
    fetch('/api/sets/learn', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { events: LearnEvent[]; knownPairs: string[] } | null) => j && setLearn(j))
      .catch(() => {});
  }, []);
  const weights = useMemo(() => adjustWeights(learn.events), [learn.events]);
  const changes = learn.events.filter((e) => e.type === 'replace').length;

  const options = (extra: Partial<BuildOptions> = {}): BuildOptions => ({
    durationMin,
    curve,
    customCurve: curve === 'custom' ? custom : undefined,
    bpmMin: bpmMin ? Number(bpmMin) : null,
    bpmMax: bpmMax ? Number(bpmMax) : null,
    startKey: startKey || null,
    includeDrafts,
    mustInclude: must,
    exclude,
    seed,
    weights,
    knownPairs: learn.knownPairs,
    ...(seedTrack ? { seedTrack: { id: seedTrack.id, place: seedPlace } } : {}),
    ...extra
  });
  const warn = pool.filter((t) => (includeDrafts || !t.draft) && lowConfidence(t));

  const build = (extra: Partial<BuildOptions> = {}) => {
    const t0 = performance.now();
    const r = buildAlternatives(pool, options(extra));
    setTook(performance.now() - t0);
    setAlts(r);
    setActive(0);
    setSwapAt(null);
    setName(extra.seedTrack || seedTrack ? `Fra ${seedReq?.title ?? seedTrack?.title ?? ''}` : `${CURVE_NAMES[curve]} ${durationMin} min`);
  };
  // Ett trykk: tre forslag med standardvalgene (60 min, Reise, umastrede med). Ingenting lagres før Knut velger.
  useEffect(() => {
    if (!seedTrack || !seedReq) return;
    setDuration(60);
    setCurve('journey');
    setIncludeDrafts(true);
    setSeedPlace('auto');
    build({ durationMin: 60, curve: 'journey', customCurve: undefined, includeDrafts: true, seedTrack: { id: seedTrack.id, place: 'auto' } });
  }, [seedReq?.nonce, !!seedTrack]); // eslint-disable-line react-hooks/exhaustive-deps
  const placeSeed = (place: SeedPlace) => {
    setSeedPlace(place);
    if (seedTrack) build({ seedTrack: { id: seedTrack.id, place } });
  };
  const cur = alts?.[active];

  /** Lås og bygg på nytt: låste plasser beholdes, resten regnes om. */
  const rebuild = () => {
    if (!cur) return;
    const pins = [...locked].map((i) => ({ id: cur.tracks[i]!.id, position: i }));
    const r = buildAlternatives(pool, options({ mustInclude: [...must.filter((m) => !pins.some((p) => p.id === m.id)), ...pins], seed: seed + 1 }));
    setSeed((s) => s + 1);
    setAlts(alts!.map((a, i) => (i === active ? { ...r[active]!, character: a.character } : a)));
  };
  const logEvent = (e: LearnEvent) => {
    setLearn((l) => ({ ...l, events: [...l.events, e] }));
    void fetch('/api/sets/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: e }) }).catch(() => {});
  };
  const neighbourParts = (seq: SbTrack[], i: number, t: SbTrack) => {
    const sum = { harmonic: 0, tempo: 0, mix: 0, lufs: 0 };
    for (const [a, b] of [[seq[i - 1], t], [t, seq[i + 1]]] as Array<[SbTrack | undefined, SbTrack | undefined]>) {
      if (!a || !b) continue;
      const p = transitionParts(a, b);
      for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += p[k];
    }
    return sum;
  };
  const setTracks = (tracks: SbTrack[]) => setAlts(alts!.map((a, i) => (i === active ? { ...a, tracks, totalMs: tracks.reduce((s, t) => s + t.durationMs, 0) } : a)));
  const replace = (i: number, t: SbTrack) => {
    const seq = cur!.tracks;
    logEvent({ type: 'replace', before: neighbourParts(seq, i, seq[i]!), after: neighbourParts(seq, i, t) });
    setTracks(seq.map((x, j) => (j === i ? t : x)));
    setSwapAt(null);
  };
  const move = (i: number, d: number) => {
    const seq = [...cur!.tracks];
    const j = i + d;
    if (j < 0 || j >= seq.length) return;
    [seq[i], seq[j]] = [seq[j]!, seq[i]!];
    logEvent({ type: 'move' });
    setTracks(seq);
  };
  const remove = (i: number) => {
    logEvent({ type: 'remove' });
    setTracks(cur!.tracks.filter((_, j) => j !== i));
  };

  const ideas = useFx((s) => s.ideas);
  const loadFx = useFx((s) => s.load);
  useEffect(() => {
    void loadFx();
  }, [loadFx]);
  const fxAt = (i: number) => {
    const t = cur!.tracks[i]!;
    const next = cur!.tracks[i + 1];
    if (!next) return null;
    const info = explainTransition(t, next);
    return { info, ...transitionPreset(t, next, info, i + 1 === cur!.tracks.length - 1, ideas) };
  };
  /** Del 18 pkt. 11: «jukselapp» – én side per sett med låt, toneart, BPM og overgang (preset + steg). Skriv ut som PDF. */
  const cheatSheet = () => {
    const rows = cur!.tracks
      .map((t, i) => {
        const fx = fxAt(i);
        const steps = fx ? fxCuesFor(fx.preset, t, cur!.tracks[i + 1]!, fx.info) : null;
        const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
        return `<tr><td>${i + 1}</td><td><b>${esc(t.title)}</b></td><td>${t.camelot ?? '–'}</td><td>${t.bpm ? t.bpm.toFixed(1) : '–'}</td><td>${
          fx ? `<span style="color:${fx.preset.color}">${fx.preset.icon} ${esc(fx.preset.name)}</span><br><small>ut ${formatTime(fx.info.mix.outAtMs)} · ${[...steps!.a, ...steps!.b].map((c) => esc(c.name.split(' · ')[1] ?? c.name)).join(' → ')}</small>` : '<small>slutt</small>'
        }</td></tr>`;
      })
      .join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${(name || 'Sett').replace(/</g, '')} – jukselapp</title><style>body{font:16px system-ui;margin:24px;background:#fff;color:#000}h1{font-size:22px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #ccc;padding:8px 6px;vertical-align:top}td:nth-child(3),td:nth-child(4){font-family:monospace;font-size:18px}@media(max-width:600px){body{font-size:20px}}</style><h1>${(name || 'Sett').replace(/</g, '')}</h1><table>${rows}</table><script>setTimeout(()=>print(),300)</script>`);
    w.document.close();
  };

  const exportItems = () =>
    cur!.tracks.map((t, i) => {
      const a = byId.get(t.id)!.manifest;
      const prev = cur!.tracks[i - 1];
      const next = cur!.tracks[i + 1];
      // Del 18: presetet ut av denne (hot cue i presetets farge), presetet inn (M3U-kommentar) og stegene som memory cues
      const out = fxAt(i);
      const inn = i > 0 ? fxAt(i - 1) : null;
      const cuesOut = out ? fxCuesFor(out.preset, t, next!, out.info).a : [];
      const cuesIn = inn ? fxCuesFor(inn.preset, prev!, t, inn.info).b : [];
      return {
        slug: a.slug,
        variant: a.variant,
        version: a.version,
        mixInMs: prev ? explainTransition(prev, t).mix.inAtMs : 0,
        mixOutMs: next ? explainTransition(t, next).mix.outAtMs : null,
        bars: next ? explainTransition(t, next).mix.bars : null,
        fxOut: out ? { name: out.preset.name, color: out.preset.color } : null,
        fxIn: inn ? inn.preset.name : null,
        fxCues: [...cuesIn, ...cuesOut]
      };
    });
  const download = async (format: 'rekordbox' | 'm3u') => {
    try {
      const r = await fetch('/api/sets/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, name: name || 'Groovehouse-sett', items: exportItems() }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(name || 'Groovehouse-sett').replace(/[\\/:*?"<>|]/g, '_')}.${format === 'rekordbox' ? 'xml' : 'm3u8'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      useToast.getState().show(format === 'rekordbox' ? 'rekordbox-XML lastet ned – importer den i rekordbox (Fil → Importer)' : 'M3U lastet ned');
    } catch (err) {
      toastError(err);
    }
  };
  const save = async () => {
    try {
      const st = usePlaylists.getState();
      const listName = name || `Sett ${durationMin} min`;
      // Del 27 pkt. 8: «DJ-klar» – hver låt låses til versjonen settet ble bygget med (bekreftes først)
      const items = cur!.tracks.flatMap((t) => {
        const a = byId.get(t.id);
        return a ? [{ slug: t.slug, variant: t.variant, version: a.manifest.version, title: a.manifest.title, variantLabel: a.manifest.variantLabel ?? null }] : [];
      });
      if (!(await useLockConfirm.getState().confirm(listName, items.map(({ title, variantLabel, version }) => ({ title, variantLabel, version }))))) return;
      const created = await st.create(
        listName,
        items.map(({ slug, variant, version }) => ({ slug, variant, version }))
      );
      const p = await st.setPlan(created.id, 'set');
      useToast.getState().show(`Lagret under Live-sett → Planlagte sett: «${p.name}»`);
    } catch (err) {
      toastError(err);
    }
  };
  const play = () => {
    const list = cur!.tracks.map((t) => byId.get(t.id)!).filter(Boolean);
    usePlayer.getState().playFrom(list, 0);
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Lag sett">
        <div className="flex flex-col gap-3">
          {seedTrack && (
            <div className="flex flex-col gap-2 rounded-xl bg-accent/[0.08] p-3" aria-label="Frølåt">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Frølåt</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-strong">{seedTrack.title}</span>
                <button type="button" onClick={() => useSeedSet.getState().clearSeedSet()} className="h-11 rounded-full px-3 text-xs text-muted hover:text-ink lg:h-8">
                  Fjern
                </button>
              </div>
              <div role="radiogroup" aria-label="Plass i settet" className="flex flex-wrap gap-1.5">
                {(Object.keys(SEED_PLACE_NAMES) as SeedPlace[]).map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={seedPlace === p} onClick={() => placeSeed(p)} className={`h-11 rounded-full px-3 text-xs lg:h-8 ${seedPlace === p ? 'bg-accent text-on-accent font-semibold' : 'bg-white/[0.05] text-soft hover:text-ink'}`}>
                    {SEED_PLACE_NAMES[p]}
                  </button>
                ))}
              </div>
              <p className="m-0 text-[11px] text-muted">Låter som ligner (BPM, toneart, energi, bass) vektes opp nær frølåta. Velg et forslag og lagre det under Planlagte sett.</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted">Varighet</span>
            {DURATIONS.map((d) => (
              <button key={d} type="button" aria-pressed={durationMin === d} onClick={() => setDuration(d)} className={`h-9 rounded-lg px-3 font-mono text-sm ${durationMin === d ? 'gv-neon-soft border border-accent/70 bg-accent/[0.12] text-accent' : ' text-soft'}`}>
                {d} min
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs text-muted">
              fritt
              <input type="number" min={10} max={300} value={durationMin} onChange={(e) => setDuration(Math.max(10, Math.min(300, Number(e.target.value) || 60)))} className="h-9 w-20 rounded-lg border border-white/10 bg-sunken px-2 font-mono text-sm text-ink" aria-label="Varighet i minutter" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted">Kurve</span>
            {(Object.keys(CURVE_NAMES) as CurveKind[]).map((c) => (
              <button key={c} type="button" aria-pressed={curve === c} onClick={() => setCurve(c)} className={`h-9 rounded-lg px-3 text-sm ${curve === c ? 'gv-neon-soft border border-accent/70 bg-accent/[0.12] font-semibold text-accent' : ' text-soft'}`}>
                {CURVE_NAMES[c]}
              </button>
            ))}
          </div>
          {curve === 'custom' && (
            <div className="ml-0 flex items-end gap-2 sm:ml-[104px]" role="group" aria-label="Tegn kurven">
              {custom.map((v, i) => (
                <input
                  key={i}
                  type="range"
                  min={1}
                  max={10}
                  step={0.5}
                  value={v}
                  aria-label={`Energi ved ${Math.round((i / (custom.length - 1)) * 100)} %`}
                  onChange={(e) => setCustom(custom.map((x, j) => (j === i ? Number(e.target.value) : x)))}
                  className="gv-range h-24 w-6 [writing-mode:vertical-lr] [direction:rtl]"
                />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="w-24">BPM-spenn</span>
            <input value={bpmMin} onChange={(e) => setBpmMin(e.target.value)} placeholder="fra" inputMode="decimal" className="h-9 w-16 rounded-lg border border-white/10 bg-sunken px-2 font-mono text-sm text-ink" aria-label="Laveste BPM" />
            <input value={bpmMax} onChange={(e) => setBpmMax(e.target.value)} placeholder="til" inputMode="decimal" className="h-9 w-16 rounded-lg border border-white/10 bg-sunken px-2 font-mono text-sm text-ink" aria-label="Høyeste BPM" />
            <label className="flex items-center gap-1.5">
              Starttoneart
              <select value={startKey} onChange={(e) => setStartKey(e.target.value)} className="h-9 rounded-lg border border-white/10 bg-sunken px-2 font-mono text-sm text-ink">
                <option value="">alle</option>
                {KEYS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
              Ta med umastret
            </label>
          </div>
          <TrackPicker label="Må være med" pool={pool} chosen={must.map((m) => m.id)} onAdd={(id) => setMust([...must, { id, position: null }])} onRemove={(id) => setMust(must.filter((m) => m.id !== id))} positions={must} setPosition={(id, p) => setMust(must.map((m) => (m.id === id ? { ...m, position: p } : m)))} />
          <TrackPicker label="Utelat" pool={pool} chosen={pool.filter((t) => exclude.includes(t.slug)).map((t) => t.id)} onAdd={(id) => setExclude([...exclude, pool.find((t) => t.id === id)!.slug])} onRemove={(id) => setExclude(exclude.filter((s) => s !== pool.find((t) => t.id === id)?.slug))} />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => build()} disabled={!pool.length} className="h-11 rounded-full bg-accent px-6 text-sm font-semibold text-on-accent disabled:opacity-40">
              Lag tre forslag
            </button>
            {took != null && <span className="font-mono text-xs text-muted">3 forslag på {(took / 1000).toFixed(2).replace('.', ',')} s · {pool.filter((t) => includeDrafts || !t.draft).length} kandidater</span>}
            <span className="text-xs text-muted">
              {changes ? `Vektene er justert etter ${changes} av dine endringer.` : 'Vektene følger standard (justeres etter dine bytter).'}
              {changes > 0 && (
                <button
                  type="button"
                  onClick={() => void fetch('/api/sets/learn', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => setLearn((l) => ({ ...l, events: [] })))}
                  className="ml-2 text-accent underline"
                >
                  Tilbakestill
                </button>
              )}
            </span>
          </div>
          {warn.length > 0 && (
            <p className="m-0 rounded-lg border border-[#F5C84B]/40 bg-[#F5C84B]/[0.06] px-3 py-2 text-xs text-soft">
              Lav analyse-sikkerhet (sjekk BPM/toneart i Studio): {warn.slice(0, 8).map((t) => t.title).join(', ')}
              {warn.length > 8 ? ` og ${warn.length - 8} til` : ''}. Feil BPM eller toneart gir feil sett.
            </p>
          )}
        </div>
      </Panel>

      {alts && alts.length === 0 && <p className="text-sm text-muted">Fant ingen låter som passer valgene.</p>}
      {alts && cur && (
        <>
          <div role="tablist" aria-label="Forslag" className="grid gap-3 sm:grid-cols-3">
            {alts.map((a, i) => (
              <button key={a.character} type="button" role="tab" aria-selected={i === active} onClick={() => (setActive(i), setLocked(new Set()), setSwapAt(null))} className={`gv-panel flex flex-col gap-1 p-3 text-left ${i === active ? 'gv-neon-soft' : 'opacity-80'}`}>
                <span className="gv-label">{CHARACTER_NAMES[a.character]}</span>
                <span className="font-mono text-2xl text-ink-strong">{a.score}</span>
                <span className="font-mono text-[11px] text-muted">
                  {a.tracks.length} låter · {formatTime(a.totalMs)}
                </span>
                <span className="flex flex-wrap gap-x-2 font-mono text-[11px] text-soft">
                  {Object.entries(scoresOf(a)).map(([k, v]) => (
                    <span key={k}>
                      {PART_NAMES[k]} {v}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>

          <Panel title="Energikurve" right={<span className="font-mono text-[11px] text-muted">stiplet = mål ({CURVE_NAMES[curve]})</span>}>
            <EnergyChart tracks={cur.tracks} curve={curve} custom={custom} />
          </Panel>

          <Panel
            title={`Settet · ${formatTime(cur.totalMs)}`}
            right={
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={play} className="h-9 rounded-full border border-accent/60 px-3 text-xs font-semibold text-accent">
                  Spill
                </button>
                <button type="button" onClick={rebuild} disabled={!locked.size} title="Låste plasser beholdes, resten regnes om" className="h-9 rounded-full bg-white/[0.04] px-3 text-xs text-ink disabled:opacity-40">
                  Lås og bygg på nytt ({locked.size})
                </button>
              </div>
            }
          >
            <ol className="m-0 flex list-none flex-col p-0" aria-label="Låter og overganger">
              {cur.tracks.map((t, i) => {
                const a = byId.get(t.id);
                const next = cur.tracks[i + 1];
                const tr = next ? explainTransition(t, next) : null;
                return (
                  <li key={`${t.id}-${i}`} className="flex flex-col">
                    <div className={`flex items-center gap-3 rounded-xl px-2 py-1.5 ${locked.has(i) ? 'bg-accent/[0.08]' : ''}`}>
                      <span className="w-6 text-right font-mono text-xs text-muted">{i + 1}</span>
                      {a && <CoverArt src={assetUrl(a, a.manifest.files.coverThumb)} palette={a.manifest.palette} title={t.title} size={36} rounded={6} draft={t.draft} />}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-semibold text-ink-strong">
                          {t.title}
                          {a && <DraftBadge m={a.manifest} className="ml-1.5" />}
                        </span>
                        <span className="font-mono text-[11px] text-muted">
                          {t.bpm ? t.bpm.toFixed(1) : '–'} BPM · {t.camelot ?? '–'} {a?.manifest.key ? keyShort(a.manifest.key.name) : ''} · energi {t.energy.toFixed(1)} · {formatTime(t.durationMs)}
                        </span>
                      </span>
                      <button type="button" aria-pressed={locked.has(i)} onClick={() => setLocked((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))} className={`h-8 rounded-full px-2 text-xs ${locked.has(i) ? 'text-accent' : 'text-muted hover:text-ink'}`} aria-label={`${locked.has(i) ? 'Lås opp' : 'Lås'} ${t.title}`}>
                        {locked.has(i) ? '🔒 låst' : 'lås'}
                      </button>
                      <button type="button" onClick={() => setSwapAt(swapAt === i ? null : i)} className="h-8 rounded-full bg-white/[0.04] px-2.5 text-xs text-soft hover:text-ink" aria-expanded={swapAt === i}>
                        Bytt ut
                      </button>
                      <button type="button" onClick={() => move(i, -1)} aria-label={`Flytt ${t.title} opp`} className="h-8 w-7 text-muted hover:text-ink">
                        ↑
                      </button>
                      <button type="button" onClick={() => move(i, 1)} aria-label={`Flytt ${t.title} ned`} className="h-8 w-7 text-muted hover:text-ink">
                        ↓
                      </button>
                      <button type="button" onClick={() => remove(i)} aria-label={`Fjern ${t.title}`} className="h-8 w-7 text-muted hover:text-[#FF8A7A]">
                        ×
                      </button>
                    </div>
                    {swapAt === i && (
                      <ul aria-label={`Alternativer til ${t.title}`} className="m-0 ml-9 flex list-none flex-col gap-1 rounded-xl bg-white/[0.02] p-2">
                        {replacementsFor(cur.tracks, i, pool, options()).map(({ track: r }) => (
                          <li key={r.id}>
                            <button type="button" onClick={() => replace(i, r)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-white/[0.05]">
                              <span className="min-w-0 flex-1 truncate text-ink">{r.title}</span>
                              <span className="font-mono text-[11px] text-muted">
                                {r.bpm?.toFixed(1)} · {r.camelot} · energi {r.energy.toFixed(1)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {tr && (
                      <div className="ml-9 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-l border-dashed border-white/15 py-1 pl-4 font-mono text-[11px] text-muted" data-testid="transition">
                        <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: QUALITY_COLOR[tr.quality] }} />
                        <span className="text-ink">{tr.label}</span>
                        <span>{RELATION_TEXT[tr.relation]}</span>
                        <span>{tr.tempoPct === null ? 'tempo ukjent' : `${tr.tempoPct > 0 ? '+' : ''}${tr.tempoPct.toFixed(1).replace('.', ',')} %`}</span>
                        <span>
                          ut ved {formatTime(tr.mix.outAtMs)} / inn ved {formatTime(tr.mix.inAtMs)}
                          {tr.mix.bars ? `, ${tr.mix.bars} takter` : ', kort overgang'}
                        </span>
                        {(() => {
                          const fx = fxAt(i);
                          return fx && next ? (
                            <div className="w-full pt-1">
                              <TransitionFx a={t} b={next} info={fx.info} preset={fx.preset} reason={fx.reason} learned={fx.learned} />
                            </div>
                          ) : null;
                        })()}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </Panel>

          <Panel title="Lagre og eksporter">
            <div className="flex flex-wrap items-center gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Navn på settet" className="h-10 min-w-[200px] flex-1 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink" />
              <button type="button" onClick={() => void save()} className="h-10 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
                Lagre under Planlagte sett
              </button>
              <button type="button" onClick={cheatSheet} className="h-10 rounded-full bg-white/[0.04] px-4 text-sm text-ink">
                Jukselapp (PDF)
              </button>
              <button type="button" onClick={() => void download('rekordbox')} className="h-10 rounded-full bg-white/[0.04] px-4 text-sm text-ink">
                rekordbox XML
              </button>
              <button type="button" onClick={() => void download('m3u')} className="h-10 rounded-full bg-white/[0.04] px-4 text-sm text-ink">
                M3U
              </button>
            </div>
            <p className="m-0 mt-2 text-[11px] text-muted">rekordbox-fila har mikspunktene som hot cues (A = Mix inn, B = Mix ut) og memory cues, og peker på originalfilene i REASONDONE (ellers Vaults master).</p>
          </Panel>
        </>
      )}
    </div>
  );
}

function scoresOf(a: Alt) {
  const p = a.parts;
  const s = (v: number, scale = 1) => Math.round(100 * Math.max(0, 1 - v / scale));
  return { harmonic: s(p.harmonic), tempo: s(p.tempo, 1.5), mix: s(p.mix), energy: s(p.energy, 0.5), variation: s(p.variation, 0.5) };
}

/** Energien til låtene (stolper) oppå målkurven (stiplet). */
function EnergyChart({ tracks, curve, custom }: { tracks: SbTrack[]; curve: CurveKind; custom: number[] }) {
  const W = 600;
  const H = 120;
  const total = tracks.reduce((s, t) => s + t.durationMs, 0) || 1;
  let at = 0;
  const bars = tracks.map((t) => {
    const x = (at / total) * W;
    const w = (t.durationMs / total) * W;
    at += t.durationMs;
    return { x, w, y: H - (t.energy / 10) * H, title: `${t.title}: ${t.energy.toFixed(1)}` };
  });
  const target = Array.from({ length: 41 }, (_, i) => `${(i / 40) * W},${H - (curveAt(curve, i / 40, custom) / 10) * H}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" role="img" aria-label="Energien i settet mot målkurven">
      {bars.map((b, i) => (
        <rect key={i} x={b.x + 1} y={b.y} width={Math.max(1, b.w - 2)} height={H - b.y} rx={3} style={{ fill: 'color-mix(in srgb, var(--accent) 55%, transparent)' }}>
          <title>{b.title}</title>
        </rect>
      ))}
      <polyline points={target} fill="none" stroke="#F5F7FA" strokeWidth={2} strokeDasharray="6 5" opacity={0.8} />
    </svg>
  );
}

/** Velg låter (søk i tittel) for «Må være med» og «Utelat». */
function TrackPicker({
  label,
  pool,
  chosen,
  onAdd,
  onRemove,
  positions,
  setPosition
}: {
  label: string;
  pool: SbTrack[];
  chosen: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  positions?: Array<{ id: string; position: number | null }>;
  setPosition?: (id: string, p: number | null) => void;
}) {
  const [q, setQ] = useState('');
  const hits = q.trim() ? pool.filter((t) => !chosen.includes(t.id) && t.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 6) : [];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="w-24">{label}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="søk i tittel …" aria-label={`${label}: søk`} className="h-9 w-56 rounded-lg border border-white/10 bg-sunken px-2 text-sm text-ink" />
        {chosen.map((id) => {
          const t = pool.find((x) => x.id === id);
          const pos = positions?.find((p) => p.id === id)?.position ?? null;
          return (
            <span key={id} className="flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-0.5 text-xs text-ink">
              {t?.title}
              {setPosition && (
                <input
                  type="number"
                  min={1}
                  placeholder="plass"
                  value={pos == null ? '' : pos + 1}
                  onChange={(e) => setPosition(id, e.target.value ? Math.max(0, Number(e.target.value) - 1) : null)}
                  aria-label={`Plass for ${t?.title}`}
                  className="h-6 w-14 rounded border border-white/10 bg-sunken px-1 font-mono text-[11px]"
                />
              )}
              <button type="button" onClick={() => onRemove(id)} aria-label={`Fjern ${t?.title}`} className="text-muted hover:text-ink">
                ×
              </button>
            </span>
          );
        })}
      </div>
      {hits.length > 0 && (
        <ul className="m-0 ml-0 flex list-none flex-wrap gap-1 p-0 sm:ml-[104px]">
          {hits.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  onAdd(t.id);
                  setQ('');
                }}
                className="h-8 rounded-full border border-accent/40 px-3 text-xs text-accent"
              >
                + {t.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
