import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { formatTime, sectionsOf, simOf, toSbTracks, transitionScore, type SbTrack } from '@gv/shared/web';
import { assetUrl, dupeGroups, type LoadedAsset, type Track } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { suggestTags, useTags } from '../lib/tags';
import { rankMatches, TIGHT, useVibe, type EnergyDir, type Tightness } from '../lib/vibe';
import { CoverArt } from './CoverArt';
import { trackVars } from './Draft';
import { TransitionPreview } from './TransitionPreview';
import { useFx, transitionPreset } from '../lib/fx';
import { explainTransition } from '@gv/shared/web';

type PlayFn = (t: Track, v?: LoadedAsset, atMs?: number) => void;

/**
 * Del 20 D pkt. 17–19: «Passer etter …» med Vibe Shifter, Match groove og cue/loop-forhåndsvisning.
 * Trykk på en markør spiller derfra; hold inne gir en løkke på 8 takter. «Hør overgangen» spiller den ferdige
 * overgangen fra låta som spilles. Markørfargene kommer fra aktivt skin (aksentvariablene).
 */
export function PasserEtter({ songs, cur, onPlay }: { songs: Track[]; cur: LoadedAsset; onPlay: PlayFn }) {
  const v = useVibe();
  const tagMap = useTags((s) => s.tags);
  const tagNames = useTags((s) => s.names);
  const ideas = useFx((s) => s.ideas);
  useEffect(() => void useTags.getState().load(), []);
  // Stil-skiftet glir videre for hver ny låt som spilles
  const index = usePlayer((s) => s.index);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    if (useVibe.getState().style) useVibe.getState().advance();
  }, [index]);
  const items = useMemo(() => {
    const assets = songs.map((t) => t.main);
    const tracks = toSbTracks([cur, ...assets].map((a) => ({ manifest: a.manifest, analysis: null })), dupeGroups()).map((t) => ({ ...t, tags: tagMap[t.slug] ?? null }));
    const [ref, ...rest] = tracks as [SbTrack, ...SbTrack[]];
    const bySlug = new Map(songs.map((t) => [t.slug, t]));
    const tagged = rest.filter((t) => t.tags?.length).map((t) => ({ sim: simOf(t), tags: t.tags! }));
    return {
      ref,
      ranked: rankMatches(ref, rest, v)
        .slice(0, 12)
        .map((r) => ({ ...r, track: bySlug.get(r.t.slug)!, suggested: r.t.tags?.length ? [] : suggestTags(simOf(r.t), tagged) }))
        .filter((x) => x.track)
    };
  }, [songs, cur, tagMap, v]);
  const seg = (on: boolean) => `h-11 rounded-full px-3 text-xs lg:h-8 ${on ? 'bg-accent/[0.16] font-semibold text-accent' : 'bg-white/[0.04] text-soft hover:text-ink'}`;

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Vibe Shifter" className="flex flex-wrap items-center gap-1.5">
        {(Object.keys(TIGHT) as Tightness[]).map((k) => (
          <button key={k} type="button" aria-pressed={v.tight === k} onClick={() => v.set({ tight: k })} className={seg(v.tight === k)} title={`Camelot ±${TIGHT[k].camelot}, BPM ±${TIGHT[k].bpmPct} %`}>
            {TIGHT[k].label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
        {([['up', 'Energi ↑'], ['flat', 'Energi →'], ['down', 'Energi ↓']] as Array<[EnergyDir, string]>).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={v.energy === k} onClick={() => v.set({ energy: v.energy === k ? null : k })} className={seg(v.energy === k)}>
            {label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/10" aria-hidden="true" />
        <label className="flex items-center gap-1.5 text-xs text-soft">
          Stil
          <select value={v.style ?? ''} onChange={(e) => v.set({ style: e.target.value || null })} aria-label="Skift mot stil" className="h-11 rounded-lg border border-white/10 bg-sunken px-2 text-xs text-ink lg:h-8">
            <option value="">(ingen)</option>
            {tagNames.map((n) => (
              <option key={n} value={n}>
                Skift mot {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" aria-pressed={v.matchGroove} onClick={() => v.set({ matchGroove: !v.matchGroove })} className={seg(v.matchGroove)} title="Vekter swing, perkusjonstetthet, kick-mønster og bass i tillegg til Camelot og BPM">
          Match groove
        </button>
      </div>
      {v.style && <p className="m-0 text-[12px] text-soft">Skifter mot {v.style}: {Math.min(3, v.styleStep + 1)} av 3 – forslagene glir mer mot {v.style} for hver låt.</p>}
      {items.ranked.length === 0 ? (
        <p className="m-0 text-sm text-muted">Ingen låter passer med disse valgene. Prøv «Bredere».</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.ranked.map(({ t, track, groovePct, suggested }) => {
            const a = track.main;
            const sc = transitionScore(items.ref, t);
            const info = explainTransition(items.ref, t);
            const fx = transitionPreset(items.ref, t, info, false, ideas);
            return (
              <li key={t.slug} className="flex flex-col gap-1.5 rounded-xl bg-white/[0.02] p-2" style={trackVars(a.manifest)}>
                <div className="flex items-center gap-3">
                  <CoverArt src={assetUrl(a, a.manifest.files.coverThumb)} palette={a.manifest.palette} title={t.title} size={40} rounded={6} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold text-ink-strong">{t.title}</span>
                    <span className="font-mono text-[11px] text-muted">
                      {t.bpm?.toFixed(1) ?? '–'} BPM · {t.camelot ?? '–'} · energi {t.energy.toFixed(1)}
                      {groovePct != null ? ` · groove ${groovePct} %` : ''}
                      {sc.bars ? ` · ${sc.bars} takter` : ' · kort overgang'}
                    </span>
                  </span>
                  <TagChips slug={t.slug} names={tagNames} tags={tagMap[t.slug] ?? []} suggested={suggested} />
                </div>
                <CueStrip track={track} t={t} mixInMs={sc.inAtMs} onPlay={onPlay} />
                <TransitionPreview from={cur} to={a} preset={fx.preset.id} compact />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Ett trykk per tagg (dine egne). */
function TagChips({ slug, names, tags, suggested = [] }: { slug: string; names: string[]; tags: string[]; suggested?: string[] }) {
  return (
    <span className="hidden flex-wrap gap-1 sm:flex">
      {names.slice(0, 4).map((n) => {
        const on = tags.some((t) => t.toLowerCase() === n.toLowerCase());
        const hint = !on && suggested.includes(n);
        return (
          <button key={n} type="button" aria-pressed={on} onClick={() => void useTags.getState().toggle(slug, n)} title={hint ? 'Forslag (ligner låter du har tagget slik) – trykk for å godta' : undefined} className={`h-8 rounded-full px-2 text-[11px] ${on ? 'bg-accent/[0.16] font-semibold text-accent' : hint ? 'border border-dashed border-accent/60 text-accent' : 'bg-white/[0.04] text-muted hover:text-ink'}`}>
            {n}
            {hint ? '?' : ''}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Miniatyr-bølgeform med markører: drop, breakdown, vokalstart, slutt på intro, outro og foreslått mikspunkt.
 * Trykk = spill derfra. Hold inne = løkke på 8 takter fra markøren.
 */
function CueStrip({ track, t, mixInMs, onPlay }: { track: Track; t: SbTrack; mixInMs: number; onPlay: PlayFn }) {
  const a = track.main;
  const m = a.manifest;
  const dur = m.durationMs || 1;
  const peaks = a.analysis?.peaks ?? [];
  const bar = m.bpm ? 240_000 / m.bpm : 2000;
  const hold = useRef<number | null>(null);
  const marks: Array<{ ms: number; label: string; color: string }> = [];
  for (const s of sectionsOf(m.markers)) {
    if (/drop/i.test(s.label ?? '')) marks.push({ ms: s.startMs, label: s.label ?? 'Drop', color: 'var(--accent)' });
    else if (/break/i.test(s.label ?? '')) marks.push({ ms: s.startMs, label: s.label ?? 'Breakdown', color: 'var(--accent-2)' });
  }
  if (t.vocals?.length) marks.push({ ms: t.vocals[0]![0], label: 'Vokal', color: 'var(--accent-3)' });
  marks.push({ ms: Math.min(dur, t.introMs), label: 'Intro slutt', color: '#C6CDD9' });
  marks.push({ ms: Math.max(0, dur - t.outroMs), label: 'Outro', color: '#C6CDD9' });
  marks.push({ ms: mixInMs, label: 'Miks inn', color: 'var(--accent)' });
  const start = (ms: number) => {
    hold.current = window.setTimeout(() => {
      hold.current = -1;
      onPlay(track, a, ms);
      // Løkke på 8 takter når låta er i gang
      setTimeout(() => usePlayer.getState().setLoop(ms, ms + 8 * bar, false), 400);
    }, 500);
  };
  const end = (ms: number) => {
    if (hold.current === -1) return void (hold.current = null);
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
    onPlay(track, a, ms);
  };
  return (
    <div className="flex flex-col gap-1">
      <svg viewBox="0 0 400 36" className="h-9 w-full" aria-hidden="true">
        {peaks.map((p, i) => (
          <rect key={i} x={(i / peaks.length) * 400} y={18 - p * 16} width={Math.max(1, 400 / peaks.length - 1)} height={Math.max(1, p * 32)} style={{ fill: 'color-mix(in srgb, var(--accent) 40%, transparent)' } as CSSProperties} />
        ))}
        {marks.map((mk, i) => (
          <rect key={`m${i}`} x={(mk.ms / dur) * 400 - 1} y={0} width={2} height={36} style={{ fill: mk.color }} />
        ))}
      </svg>
      <div className="flex flex-wrap gap-1">
        {marks
          .sort((x, y) => x.ms - y.ms)
          .map((mk, i) => (
            <button
              key={i}
              type="button"
              onPointerDown={() => start(mk.ms)}
              onPointerUp={() => end(mk.ms)}
              onPointerLeave={() => hold.current && hold.current !== -1 && (clearTimeout(hold.current), (hold.current = null))}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPlay(track, a, mk.ms))}
              title="Trykk: spill herfra · hold inne: løkke på 8 takter"
              className="flex h-11 items-center gap-1 rounded-full bg-white/[0.04] px-2.5 text-[11px] text-ink hover:bg-white/[0.08] lg:h-7"
            >
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: mk.color }} />
              {mk.label} {formatTime(mk.ms)}
            </button>
          ))}
      </div>
    </div>
  );
}
