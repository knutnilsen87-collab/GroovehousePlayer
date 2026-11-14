import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { BUILTIN_SMART, camelotNeighbors, formatTime, keyShort, mixesWith, paletteToCssVars, parseCamelot } from '@gv/shared/web';
import { assetUrl, type LoadedAsset, type Track } from '../lib/catalog';
import { fetchListens, type ListenLog } from '../lib/library';
import { savedPosition, usePlayer } from '../lib/player';
import { usePlaylists } from '../lib/playlists';
import { CoverArt } from '../components/CoverArt';
import { HeartButton, Panel } from '../components/Deck';
import { PlayIcon } from '../components/Icons';
import { buildListView, ColorDot, ListCover } from '../components/Playlists';
import { useFavorites } from '../lib/library';

/**
 * Del 14: nye sider, enkle i første versjon. Hjem, DJ-verktøy og Analyse (egne avspillinger).
 * Lytteinnsikt fra andre kommer med del 13.
 */

type PlayFn = (t: Track, v?: LoadedAsset, atMs?: number) => void;

const H1 = ({ children }: { children: ReactNode }) => <h1 className="m-0 text-[28px] font-bold tracking-tight text-ink-strong lg:text-[32px]">{children}</h1>;

function useListens(): ListenLog | null | undefined {
  const [log, setLog] = useState<ListenLog | null | undefined>(undefined);
  const playing = usePlayer((s) => s.playing);
  useEffect(() => {
    let alive = true;
    void fetchListens().then((l) => alive && setLog(l));
    return () => {
      alive = false;
    };
  }, [playing]);
  return log;
}

/** Liten låtrad (mobil og lister på Hjem). */
function Row({ t, onPlay, sub }: { t: Track; onPlay: PlayFn; sub?: string }) {
  const m = t.main.manifest;
  const cur = usePlayer((s) => s.queue[s.index]?.manifest.slug === t.slug);
  return (
    <li className="flex items-center gap-1" style={paletteToCssVars(m.palette) as CSSProperties}>
      <button type="button" onClick={() => onPlay(t)} className={`flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 text-left hover:bg-white/[0.03] ${cur ? 'bg-accent/[0.1]' : ''}`}>
        <CoverArt src={assetUrl(t.main, m.files.coverThumb)} palette={m.palette} title={m.title} size={46} rounded={8} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate text-[15px] font-semibold ${cur ? 'text-accent' : 'text-ink-strong'}`}>{m.title}</span>
          <span className="truncate font-mono text-[11px] text-muted">{sub ?? [m.bpm ? `${Math.round(m.bpm)} BPM` : null, m.key ? `${keyShort(m.key.name)} ${m.key.camelot}` : null, formatTime(m.durationMs)].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      <HeartButton slug={m.slug} title={m.title} size={18} className="h-10 w-10" />
    </li>
  );
}

// ---------------------------------------------------------------- Hjem

export function HomeView({ tracks, onPlay, onOpenList, table }: { tracks: Track[]; onPlay: PlayFn; onOpenList: (id: string) => void; table?: ReactNode }) {
  const log = useListens();
  const playlists = usePlaylists((s) => s.playlists);
  useFavorites((s) => s.slugs);
  const { queue, index, positionMs } = usePlayer();
  const cur = queue[index];
  const bySlug = useMemo(() => new Map(tracks.map((t) => [t.slug, t])), [tracks]);
  const recentlyAdded = useMemo(() => [...tracks].sort((a, b) => b.main.manifest.createdAt.localeCompare(a.main.manifest.createdAt)).slice(0, 8), [tracks]);
  const recentlyPlayed = (log?.recent ?? []).flatMap((r) => bySlug.get(r.slug) ?? []).slice(0, 10);
  // Fortsett: låta i køen (pauset), ellers et live-sett med lagret posisjon
  const resume = cur
    ? { t: bySlug.get(cur.manifest.slug), a: cur, at: positionMs }
    : (() => {
        const t = tracks.find((x) => x.main.manifest.kind === 'set' && savedPosition(x.main));
        return t ? { t, a: t.main, at: savedPosition(t.main) ?? 0 } : null;
      })();
  const lists = [...BUILTIN_SMART.map((b) => b.id as string), ...playlists.filter((p) => p.kind === 'manual').sort((a, b) => (b.usedAt ?? b.createdAt).localeCompare(a.usedAt ?? a.createdAt)).map((p) => p.id)]
    .map((id) => buildListView(id, playlists, tracks))
    .filter((v): v is NonNullable<typeof v> => !!v && v.assets.length > 0)
    .slice(0, 8);

  return (
    <div className="flex flex-col gap-6">
      <div className="lg:hidden">
        <H1>Hjem</H1>
      </div>
      {/* Mobil: fortsett-kort (desktop har dekket øverst) */}
      {resume?.t && (
        <section aria-label="Fortsett der du slapp" className="gv-panel flex items-center gap-4 p-3 lg:hidden" style={paletteToCssVars(resume.a.manifest.palette) as CSSProperties}>
          <CoverArt src={assetUrl(resume.a, resume.a.manifest.files.coverThumb)} palette={resume.a.manifest.palette} title={resume.a.manifest.title} size={64} rounded={10} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="gv-label !text-[10px]">Fortsett der du slapp</span>
            <span className="truncate text-base font-semibold text-ink-strong">{resume.a.manifest.title}</span>
            <span className="font-mono text-[11px] text-muted">
              {formatTime(resume.at)} / {formatTime(resume.a.manifest.durationMs)}
            </span>
          </span>
          <button type="button" aria-label={`Fortsett ${resume.a.manifest.title}`} onClick={() => onPlay(resume.t!, resume.a, resume.at)} className="gv-neon-soft flex h-12 w-12 flex-none items-center justify-center rounded-full border-2 border-accent text-accent">
            <PlayIcon width={20} height={20} className="ml-0.5" />
          </button>
        </section>
      )}

      {table}

      {recentlyPlayed.length > 0 && (
        <section aria-labelledby="gv-home-played">
          <h2 id="gv-home-played" className="gv-label m-0 mb-3">
            Nylig spilt
          </h2>
          <ul className="gv-scroll -mx-1 m-0 flex list-none gap-3 overflow-x-auto px-1 pb-2">
            {recentlyPlayed.map((t) => {
              const m = t.main.manifest;
              return (
                <li key={t.slug} className="w-[132px] flex-none">
                  <button type="button" onClick={() => onPlay(t)} className="flex w-full flex-col gap-1.5 text-left">
                    <CoverArt src={assetUrl(t.main, m.files.coverThumb)} palette={m.palette} title={m.title} size={132} rounded={12} />
                    <span className="truncate text-[13px] font-semibold text-ink-strong">{m.title}</span>
                    <span className="truncate font-mono text-[10px] text-muted">{log?.bySlug[t.slug]?.plays ?? 0} avspillinger</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="gv-home-added" className="lg:hidden">
        <h2 id="gv-home-added" className="gv-label m-0 mb-2">
          Nylig lagt til
        </h2>
        <ul className="m-0 flex list-none flex-col p-0">
          {recentlyAdded.slice(0, 5).map((t) => (
            <Row key={t.slug} t={t} onPlay={onPlay} />
          ))}
        </ul>
      </section>

      {lists.length > 0 && (
        <section aria-labelledby="gv-home-lists">
          <h2 id="gv-home-lists" className="gv-label m-0 mb-3">
            Spillelister
          </h2>
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
            {lists.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => onOpenList(v.id)}
                  className="flex w-full flex-col gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-2.5 text-left transition-shadow hover:bg-white/[0.04]"
                  style={{ boxShadow: `0 0 0 1px ${v.color.primary}40, 0 0 22px ${v.color.primary}22` }}
                >
                  <span className="w-full overflow-hidden rounded-xl [&>*]:!h-auto [&>*]:!w-full [&>*]:aspect-square">
                    <ListCover v={v} size={160} rounded={12} />
                  </span>
                  <span className="flex items-center gap-2">
                    <ColorDot color={v.color} size={8} />
                    <span className="truncate text-[13px] font-semibold text-ink-strong">{v.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted">{v.assets.length}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- DJ-verktøy

const ORDER = Array.from({ length: 12 }, (_, i) => i + 1);

/** Camelot-hjul: ytre ring = dur (B), indre = moll (A). Låtene som prikker i sitt felt. */
function CamelotWheel({ counts, selected, highlight, onPick }: { counts: Map<string, number>; selected: string | null; highlight: Set<string>; onPick: (code: string | null) => void }) {
  const size = 320;
  const c = size / 2;
  const ring = (rOut: number, rIn: number, letter: 'A' | 'B') =>
    ORDER.map((n) => {
      const code = `${n}${letter}`;
      // 12 øverst, med klokka
      const a0 = ((n - 1) / 12) * 2 * Math.PI - Math.PI / 2 - Math.PI / 12;
      const a1 = a0 + (2 * Math.PI) / 12;
      const p = (r: number, a: number) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
      const d = `M ${p(rIn, a0)} L ${p(rOut, a0)} A ${rOut} ${rOut} 0 0 1 ${p(rOut, a1)} L ${p(rIn, a1)} A ${rIn} ${rIn} 0 0 0 ${p(rIn, a0)} Z`;
      const mid = (a0 + a1) / 2;
      const rm = (rOut + rIn) / 2;
      const count = counts.get(code) ?? 0;
      const sel = selected === code;
      const hl = highlight.has(code);
      return (
        <g key={code}>
          <path
            d={d}
            role="button"
            tabIndex={0}
            aria-label={`${code}: ${count} låter`}
            aria-pressed={sel}
            onClick={() => onPick(sel ? null : code)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(sel ? null : code))}
            style={{
              fill: sel ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : hl ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : count ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)',
              stroke: sel || hl ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
              strokeWidth: sel ? 1.5 : 1,
              cursor: 'pointer'
            }}
          />
          <text x={c + rm * Math.cos(mid)} y={c + rm * Math.sin(mid) - (count ? 4 : -4)} textAnchor="middle" className="pointer-events-none fill-[#E9ECF2] font-mono text-[11px]">
            {code}
          </text>
          {count > 0 && (
            <g className="pointer-events-none">
              {Array.from({ length: Math.min(count, 6) }, (_, k) => (
                <circle key={k} cx={c + rm * Math.cos(mid) + (k - (Math.min(count, 6) - 1) / 2) * 5} cy={c + rm * Math.sin(mid) + 9} r={1.8} style={{ fill: 'var(--accent)' }} />
              ))}
            </g>
          )}
        </g>
      );
    });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-auto w-full max-w-[360px]" role="group" aria-label="Camelot-hjul">
      {ring(156, 108, 'B')}
      {ring(106, 58, 'A')}
      <text x={c} y={c - 4} textAnchor="middle" className="fill-[#8B93A1] font-mono text-[10px]">
        B = dur
      </text>
      <text x={c} y={c + 10} textAnchor="middle" className="fill-[#8B93A1] font-mono text-[10px]">
        A = moll
      </text>
    </svg>
  );
}

export function DjView({ tracks, onPlay }: { tracks: Track[]; onPlay: PlayFn }) {
  const songs = tracks.filter((t) => t.main.manifest.kind !== 'set');
  const bpms = songs.map((t) => t.main.manifest.bpm).filter((b): b is number => b != null);
  const lo = Math.floor(Math.min(...bpms, 120));
  const hi = Math.ceil(Math.max(...bpms, 130));
  const [range, setRange] = useState<[number, number]>([lo, hi]);
  const [code, setCode] = useState<string | null>(null);
  const cur = usePlayer((s) => s.queue[s.index]);
  const ref = cur && cur.manifest.kind !== 'set' ? cur.manifest : null;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of songs) {
      const c = t.main.manifest.key?.camelot;
      if (c) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [songs]);
  const highlight = new Set(ref?.key ? camelotNeighbors(ref.key.camelot) : []);
  const inRange = songs.filter((t) => {
    const b = t.main.manifest.bpm;
    return b == null || (b >= range[0] && b <= range[1]);
  });
  const filtered = inRange.filter((t) => !code || t.main.manifest.key?.camelot === code).sort((a, b) => (a.main.manifest.bpm ?? 0) - (b.main.manifest.bpm ?? 0));
  const matches = ref ? songs.filter((t) => t.slug !== ref.slug && mixesWith({ bpm: ref.bpm, camelot: ref.key?.camelot ?? null }, { bpm: t.main.manifest.bpm, camelot: t.main.manifest.key?.camelot ?? null })) : [];

  return (
    <div className="flex flex-col gap-5">
      <H1>DJ-verktøy</H1>
      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Panel title="Camelot-hjul">
          <div className="flex flex-col items-center gap-3">
            <CamelotWheel counts={counts} selected={code} highlight={highlight} onPick={setCode} />
            <p className="m-0 text-center text-[12px] text-muted">
              {code ? `Viser ${code}. Trykk igjen for alle.` : 'Trykk et felt for å filtrere.'}
              {ref?.key && ` Markert: naboer til ${ref.key.camelot} (låta som spilles).`}
            </p>
          </div>
        </Panel>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="BPM-spenn" right={<span className="font-mono text-sm text-ink-strong">{range[0]}–{range[1]} BPM</span>}>
            <div className="flex items-center gap-3">
              <label className="flex flex-1 items-center gap-2 font-mono text-[11px] text-muted">
                Fra
                <input type="range" min={lo} max={hi} value={range[0]} onChange={(e) => setRange([Math.min(Number(e.target.value), range[1]), range[1]])} className="gv-range w-full" aria-label="Laveste BPM" />
              </label>
              <label className="flex flex-1 items-center gap-2 font-mono text-[11px] text-muted">
                Til
                <input type="range" min={lo} max={hi} value={range[1]} onChange={(e) => setRange([range[0], Math.max(Number(e.target.value), range[0])])} className="gv-range w-full" aria-label="Høyeste BPM" />
              </label>
            </div>
          </Panel>
          <Panel title={ref ? `Passer etter «${ref.title}»` : 'Passer etter denne'} right={ref ? <span className="font-mono text-[11px] text-muted">{ref.key?.camelot ?? '–'} · {ref.bpm ? Math.round(ref.bpm) : '–'} BPM · ±3 %</span> : undefined}>
            {!ref ? (
              <p className="m-0 text-sm text-muted">Spill en låt, så vises låtene som passer harmonisk etter den (Camelot ±1 eller relativ dur/moll, og BPM ±3 %).</p>
            ) : matches.length === 0 ? (
              <p className="m-0 text-sm text-muted">Ingen låter passer innenfor ±3 % BPM og nabotonearter.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {matches.map((t) => (
                  <Row key={t.slug} t={t} onPlay={onPlay} />
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <Panel title={`Låter (${filtered.length})`}>
        <ul className="m-0 grid list-none gap-x-6 p-0 md:grid-cols-2">
          {filtered.map((t) => (
            <Row key={t.slug} t={t} onPlay={onPlay} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- Analyse

const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1).replace('.', ',')} t` : `${Math.round(ms / 60_000)} min`);

export function StatsView({ tracks, onPlay }: { tracks: Track[]; onPlay: PlayFn }) {
  const log = useListens();
  const bySlug = useMemo(() => new Map(tracks.map((t) => [t.slug, t])), [tracks]);
  if (log === undefined) return <p className="text-sm text-muted">Henter lyttelogg …</p>;
  const entries = Object.entries(log?.bySlug ?? {}).filter(([s]) => bySlug.has(s));
  const totalMs = entries.reduce((a, [, v]) => a + v.ms, 0);
  const totalPlays = entries.reduce((a, [, v]) => a + v.plays, 0);
  const top = [...entries].sort((a, b) => b[1].plays - a[1].plays || b[1].ms - a[1].ms).slice(0, 12);
  const maxPlays = Math.max(1, ...top.map(([, v]) => v.plays));
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10);
    return { d, ms: log?.byDay[d] ?? 0 };
  });
  const maxDay = Math.max(1, ...days.map((d) => d.ms));
  const camelots = new Map<string, number>();
  for (const [s, v] of entries) {
    const c = bySlug.get(s)?.main.manifest.key?.camelot;
    if (c && parseCamelot(c)) camelots.set(c, (camelots.get(c) ?? 0) + v.ms);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <H1>Analyse</H1>
        <p className="m-0 text-[12px] text-muted">Egne avspillinger på alle enhetene dine. Lytteinnsikt fra andre kommer med delingslenkene (del 13).</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Tid lyttet', hours(totalMs)],
          ['Avspillinger', String(totalPlays)],
          ['Låter spilt', `${entries.length} / ${tracks.length}`],
          ['Siste 7 dager', hours(days.slice(-7).reduce((a, d) => a + d.ms, 0))]
        ].map(([k, v]) => (
          <Panel key={k} title={k}>
            <span className="font-mono text-2xl text-ink-strong">{v}</span>
          </Panel>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Mest spilt">
          {top.length === 0 ? (
            <p className="m-0 text-sm text-muted">Ingenting spilt ennå. Avspillinger logges på PC-en (data/listens.json).</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
              {top.map(([s, v], i) => {
                const t = bySlug.get(s)!;
                return (
                  <li key={s}>
                    <button type="button" onClick={() => onPlay(t)} className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left hover:bg-white/[0.03]">
                      <span className="w-5 text-right font-mono text-xs text-muted">{i + 1}</span>
                      <span className="w-36 truncate text-sm text-ink-strong sm:w-48">{t.main.manifest.title}</span>
                      <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                        <span className="gv-neon absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(v.plays / maxPlays) * 100}%` }} />
                      </span>
                      <span className="w-24 text-right font-mono text-[11px] text-soft">
                        {v.plays}× · {hours(v.ms)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
        <Panel title="Tid lyttet – siste 30 dager">
          <div className="flex h-40 items-end gap-1" role="img" aria-label={`Tid lyttet per dag, totalt ${hours(days.reduce((a, d) => a + d.ms, 0))}`}>
            {days.map((d) => (
              <span key={d.d} title={`${d.d}: ${hours(d.ms)}`} className="flex-1 rounded-t bg-accent/70" style={{ height: `${Math.max(2, (d.ms / maxDay) * 100)}%`, opacity: d.ms ? 1 : 0.25 }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
            <span>{days[0]!.d.slice(5)}</span>
            <span>i dag</span>
          </div>
        </Panel>
      </div>
      {camelots.size > 0 && (
        <Panel title="Lyttet tid per toneart">
          <div className="flex flex-wrap gap-2">
            {[...camelots.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([c, ms]) => (
                <span key={c} className="rounded-lg border border-white/10 px-2.5 py-1 font-mono text-[12px] text-ink">
                  {c} <span className="text-muted">{hours(ms)}</span>
                </span>
              ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
