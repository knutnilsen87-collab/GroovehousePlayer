import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatTime, formatTimeMs, isDraft, keyShort, lyricIndexAt, RATE_MAX, RATE_MIN, versionName } from '@gv/shared/web';
import { assetUrl, variantName, type LoadedAsset } from '../lib/catalog';
import { useFavorites, useIsFavorite, useLyrics } from '../lib/library';
import { getPositionMs, usePlayer } from '../lib/player';
import { isApp } from '../lib/platform';
import { useToast } from '../lib/playlists';
import { CoverArt } from './CoverArt';
import { DraftBadge } from './Draft';
import { HeartIcon, MoreIcon, NextIcon, OutputIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ScreenIcon, ShuffleIcon, SlidersIcon, SpeedIcon, VolumeIcon } from './Icons';
import { BigWaveform, SpectrumView, ZoomWaveform } from './Visuals';

/**
 * Del 14 «High-End Studio»: dekket øverst på Hjem og Bibliotek (desktop), og bitene fullskjermspilleren
 * på mobil gjenbruker. Alle aksenter kommer fra coveret (CSS-variablene), gull bare i logoen.
 */

// ---------------------------------------------------------------- Små byggeklosser

export function Panel({ title, right, children, className = '' }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`gv-panel flex min-w-0 flex-col p-4 ${className}`}>
      {(title || right) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="gv-label m-0">{title}</h2>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function HeartButton({ slug, title, size = 20, className = '' }: { slug: string; title: string; size?: number; className?: string }) {
  const on = useIsFavorite(slug);
  const toggle = useFavorites((s) => s.toggle);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? `Fjern ${title} fra favoritter` : `Legg ${title} til i favoritter`}
      onClick={(e) => {
        e.stopPropagation();
        void toggle(slug);
      }}
      className={`flex flex-none items-center justify-center rounded-full transition-colors ${on ? 'text-accent' : 'text-soft hover:text-ink-strong'} ${className}`}
    >
      <HeartIcon filled={on} width={size} height={size} />
    </button>
  );
}

/** Tid med millisekunder som oppdateres i hver frame mens musikken spiller (uten re-render av resten). */
export function LiveTime({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const playing = usePlayer((s) => s.playing);
  const pos = usePlayer((s) => s.positionMs);
  useEffect(() => {
    if (ref.current) ref.current.textContent = formatTimeMs(getPositionMs() || pos);
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (ref.current) ref.current.textContent = formatTimeMs(getPositionMs());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, pos]);
  return <span ref={ref} className={`font-mono ${className}`} />;
}

export function useSourceFile(a: LoadedAsset | undefined): string | null | undefined {
  const [source, setSource] = useState<{ id?: string; v: string | null | undefined }>({ v: undefined });
  const m = a?.manifest;
  useEffect(() => {
    if (!m) return;
    let alive = true;
    fetch(`/api/sources/${encodeURIComponent(m.slug)}/${encodeURIComponent(m.variant ?? 'main')}/${m.version}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { fileName: string }).fileName : null))
      .catch(() => null)
      .then((f) => alive && setSource({ id: m.id, v: f }));
    return () => {
      alive = false;
    };
  }, [m]);
  return m && source.id === m.id ? source.v : undefined;
}

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`);

// ---------------------------------------------------------------- Cover-kort

export function CoverCard({ cur, onMore }: { cur: LoadedAsset; onMore: (anchor: { x: number; y: number } | null) => void }) {
  const m = cur.manifest;
  return (
    <section aria-label="Låta som spilles" className="gv-panel flex min-w-0 flex-col gap-3 p-3">
      <div className="relative overflow-hidden rounded-xl">
        <CoverArt src={assetUrl(cur, m.files.cover)} palette={m.palette} title={m.title} size={600} rounded={12} fluid draft={isDraft(m)} />
      </div>
      <div className="flex items-start gap-2 px-1 pb-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-lg font-bold leading-tight text-ink-strong">
            {m.title}<DraftBadge m={m} className="ml-1.5" />
          </span>
          <span className="truncate text-[13px] text-soft">
            {m.artist ?? 'Echo Groove'}
            {m.variant ? ` · ${variantName(cur)}` : ''}
          </span>
        </div>
        <HeartButton slug={m.slug} title={m.title} className="h-9 w-9" />
        <button
          type="button"
          aria-label={`Valg for ${m.title}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMore({ x: r.left, y: r.bottom + 4 });
          }}
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-soft hover:bg-white/[0.06] hover:text-ink-strong"
        >
          <MoreIcon width={18} height={18} />
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Transport og nederste linje

/** `idle`: ingen kø ennå – play starter låta som vises i dekket. */
export function Transport({ size = 'md', idle }: { size?: 'md' | 'lg'; idle?: (atMs?: number) => void }) {
  const { playing, toggle, next, prev, repeat, cycleRepeat, shuffleUpcoming, queue, index } = usePlayer();
  const big = size === 'lg';
  const icon = big ? 26 : 22;
  const btn = `flex items-center justify-center rounded-full text-soft hover:text-ink-strong ${big ? 'h-12 w-12' : 'h-11 w-11'}`;
  const repeatLabel = repeat === 'off' ? 'Gjenta: av' : repeat === 'all' ? 'Gjenta: hele køen' : 'Gjenta: denne låta';
  return (
    <div className={`flex items-center justify-center ${big ? 'gap-5' : 'gap-7'}`}>
      <button
        type="button"
        aria-label="Bland resten av køen"
        title="Bland resten av køen"
        disabled={queue.length - index < 3}
        onClick={() => {
          shuffleUpcoming();
          useToast.getState().show('Resten av køen er blandet');
        }}
        className={`${btn} disabled:opacity-30`}
      >
        <ShuffleIcon width={icon - 2} height={icon - 2} />
      </button>
      <button type="button" aria-label="Forrige spor" onClick={prev} className={btn}>
        <PrevIcon width={icon} height={icon} />
      </button>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Spill'}
        onClick={() => (!queue.length && idle ? idle() : toggle())}
        className={`gv-neon-soft flex flex-none items-center justify-center rounded-full border-2 border-accent text-accent transition-transform active:scale-95 ${big ? 'h-[76px] w-[76px]' : 'h-[62px] w-[62px]'}`}
      >
        {playing ? <PauseIcon width={big ? 30 : 26} height={big ? 30 : 26} /> : <PlayIcon width={big ? 30 : 26} height={big ? 30 : 26} className="ml-1" />}
      </button>
      <button type="button" aria-label="Neste spor" onClick={next} className={btn}>
        <NextIcon width={icon} height={icon} />
      </button>
      <button type="button" aria-label={repeatLabel} title={repeatLabel} aria-pressed={repeat !== 'off'} onClick={cycleRepeat} className={`${btn} ${repeat !== 'off' ? '!text-accent gv-neon-text' : ''}`}>
        <RepeatIcon one={repeat === 'one'} width={icon - 2} height={icon - 2} />
      </button>
    </div>
  );
}

/** A·B: første trykk = A her, andre = B her (festet til takt; Shift = fritt), tredje = av. */
export function AbButton({ compact = false }: { compact?: boolean }) {
  const { loop, setLoop, queue, index } = usePlayer();
  const [a, setA] = useState<number | null>(null);
  const cur = queue[index];
  useEffect(() => setA(null), [cur?.manifest.id]);
  const state = loop ? 'on' : a != null ? 'a' : 'off';
  const label = state === 'on' ? `A·B-løkke ${formatTimeMs(loop!.a)}–${formatTimeMs(loop!.b)}. Trykk for å slå av.` : state === 'a' ? 'A er satt. Trykk for å sette B.' : 'Sett A·B-løkke (eller dra i bølgeformen)';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={state !== 'off'}
      disabled={!cur}
      onClick={(e) => {
        if (state === 'on') {
          setLoop(null);
          setA(null);
        } else if (state === 'a') {
          setLoop(a!, getPositionMs(), !e.shiftKey);
          setA(null);
        } else setA(getPositionMs());
      }}
      className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border px-3 font-mono text-[13px] tracking-[0.2em] ${
        state === 'on' ? 'gv-neon-soft border-accent text-accent' : state === 'a' ? 'border-accent/60 text-ink-strong' : 'border-white/20 text-soft hover:border-white/40 hover:text-ink-strong'
      } ${compact ? 'min-w-[56px]' : 'min-w-[64px]'}`}
    >
      <span className={state !== 'off' ? 'text-accent' : ''}>A</span>
      <span className={state === 'on' ? 'text-accent' : ''}>B</span>
    </button>
  );
}

/** Hastighet 0,90–1,10 (tonehøyden bevart). Dobbeltklikk nullstiller. */
export function RateControl() {
  const { rate, setRate } = usePlayer();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-label={`Hastighet ${rate.toFixed(2)}x. Dobbeltklikk nullstiller.`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => {
          setRate(1);
          setOpen(false);
        }}
        className={`flex h-9 items-center gap-2 rounded-lg px-2.5 font-mono text-[13px] ${rate !== 1 ? 'text-accent' : 'text-soft hover:text-ink-strong'}`}
      >
        <SpeedIcon width={18} height={18} />
        {rate.toFixed(rate === 1 ? 1 : 2)}x
      </button>
      {open && (
        <div role="dialog" aria-label="Hastighet" className="gv-panel absolute bottom-11 right-0 z-30 flex w-60 flex-col gap-2 !bg-[#0E1117] p-3">
          <div className="flex items-center justify-between">
            <span className="gv-label">Hastighet</span>
            <span className="font-mono text-sm text-ink-strong">{rate.toFixed(2)}x</span>
          </div>
          <input
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={0.01}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            onDoubleClick={() => setRate(1)}
            aria-label="Hastighet"
            className="gv-range w-full"
          />
          <div className="flex justify-between font-mono text-[10px] text-muted">
            <span>0.90</span>
            <button type="button" onClick={() => setRate(1)} className="text-soft hover:text-ink-strong">
              1.00
            </button>
            <span>1.10</span>
          </div>
          <p className="m-0 text-[11px] text-muted">Tonehøyden beholdes. Dobbeltklikk for 1.0x. Lagres ikke per låt.</p>
        </div>
      )}
    </div>
  );
}

/** Lydinnstillinger: normalisering for låta som spilles, og lenke til Innstillinger. */
function AudioSettings({ cur }: { cur: LoadedAsset | undefined }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const l = cur?.manifest.loudness;
  return (
    <div ref={wrap} className="relative">
      <button type="button" aria-label="Lydinnstillinger" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex h-9 w-9 items-center justify-center rounded-lg text-soft hover:text-ink-strong">
        <SlidersIcon width={20} height={20} />
      </button>
      {open && (
        <div role="dialog" aria-label="Lydinnstillinger" className="gv-panel absolute bottom-11 right-0 z-30 flex w-64 flex-col gap-2 !bg-[#0E1117] p-3 text-[12px]">
          <span className="gv-label">Lyd</span>
          {l ? (
            <dl className="m-0 grid grid-cols-[1fr_auto] gap-y-1 font-mono">
              <dt className="text-muted">Målt</dt>
              <dd className="m-0 text-ink-strong">{l.integratedLufs} LUFS</dd>
              <dt className="text-muted">Normalisering</dt>
              <dd className="m-0 text-ink-strong">{l.playbackGainDb < 0 ? `${l.playbackGainDb} dB` : 'ingen (bare demping)'}</dd>
              <dt className="text-muted">True peak</dt>
              <dd className="m-0 text-ink-strong">{l.truePeakDbtp ?? '–'} dBTP</dd>
            </dl>
          ) : (
            <p className="m-0 text-muted">Ingen låt spilles.</p>
          )}
          <a href="/studio/innstillinger" className="text-accent no-underline hover:underline">
            Målnivå og mer i Innstillinger →
          </a>
        </div>
      )}
    </div>
  );
}

export function BottomControls({ cur }: { cur: LoadedAsset | undefined }) {
  const { volume, setVolume } = usePlayer();
  return (
    <div className="flex items-center gap-3">
      {/* Volum: i Android-appen brukes telefonens volumknapper */}
      {!isApp && (
        <label className="flex min-w-0 flex-1 items-center gap-3 text-soft">
          <VolumeIcon width={20} height={20} className="flex-none" />
          <span className="sr-only">Volum</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="gv-range w-full" style={{ ['--fill' as string]: `${volume * 100}%` }} />
        </label>
      )}
      {isApp && <span className="flex-1" />}
      <AbButton />
      <span aria-hidden="true" className="h-6 w-px bg-white/10" />
      <RateControl />
      <AudioSettings cur={cur} />
    </div>
  );
}

// ---------------------------------------------------------------- Låtinfo, kreditering, tekst, kø

export function TrackInfoRows({ cur }: { cur: LoadedAsset }) {
  const m = cur.manifest;
  const rows: Array<[string, ReactNode]> = [
    ['BPM', m.bpm != null ? m.bpm.toFixed(1) : '–'],
    ['Toneart', m.key ? `${keyShort(m.key.name)} · ${m.key.camelot}` : '–'],
    ['LUFS', m.loudness.integratedLufs.toFixed(1)],
    // Del 16: utkast spilles normalisert (loudnorm); originalnivået står over
    ...(m.loudness.normalizedLufs != null ? ([['Avspilling', `${m.loudness.normalizedLufs.toFixed(1)} (normalisert)`]] as Array<[string, ReactNode]>) : []),
    ['Tid', formatTime(m.durationMs)],
    ['Format', m.sourceFormat?.label ?? '–']
  ];
  return (
    <div className="flex flex-col">
      <dl className="m-0 flex flex-col">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] py-2 last:border-0">
            <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-soft">{k}</dt>
            <dd className="m-0 truncate font-mono text-[13px] text-ink-strong">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 mt-1 text-right font-mono text-[10px] text-muted">Strømmes som AAC 256 kbps</p>
    </div>
  );
}

export function Credits({ cur }: { cur: LoadedAsset }) {
  const m = cur.manifest;
  const source = useSourceFile(cur);
  const rows: Array<[string, ReactNode]> = [
    ['Artist', m.artist ?? '–'],
    ['Label', m.label ?? '–'],
    ['℗', m.copyright ?? '–'],
    ['Album', m.album ?? '–'],
    ['Variant', m.variant ? variantName(cur) : 'Original'],
    ['Versjon', `${versionName(m)}${m.versionLabel && m.versionLabel !== versionName(m) ? ` · ${m.versionLabel}` : ''}`],
    ['Status', isDraft(m) ? 'Utkast (umastret)' : 'Release-klar'],
    ['Ingestet', new Date(m.createdAt).toLocaleDateString('nb-NO', { dateStyle: 'medium' })],
    ['BPM-sikkerhet', pct(m.bpmConfidence)],
    ['Toneart-sikkerhet', pct(m.key?.confidence)],
    ['Kildefil', source === undefined ? '…' : (source ?? 'ukjent')]
  ];
  return (
    <dl className="m-0 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className={`m-0 break-words text-ink-strong ${['BPM-sikkerhet', 'Toneart-sikkerhet', 'Versjon'].includes(k) ? 'font-mono' : ''}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tekst: synkronisert LRC ruller med avspillingen; ren tekst vises som den er. */
export function LyricsView({ cur, className = '' }: { cur: LoadedAsset; className?: string }) {
  const data = useLyrics(cur.manifest.slug);
  const pos = usePlayer((s) => (s.queue[s.index]?.manifest.id === cur.manifest.id ? s.positionMs : 0));
  const box = useRef<HTMLDivElement>(null);
  const idx = data?.parsed.synced ? lyricIndexAt(data.parsed.lines, pos + 150) : -1;
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${idx}"]`);
    const b = box.current;
    if (!el || !b) return;
    b.scrollTo({ top: el.offsetTop - b.clientHeight / 2 + el.clientHeight / 2, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [idx]);
  if (data === undefined) return <p className="m-0 text-sm text-muted">Henter tekst …</p>;
  if (data === null)
    return (
      <p className="m-0 text-sm text-muted">
        Ingen tekst ennå –{' '}
        <a href={`/studio#arkiv-${cur.manifest.slug}`} className="text-accent no-underline hover:underline">
          legg til i Studio
        </a>
      </p>
    );
  return (
    <div ref={box} className={`gv-scroll relative overflow-y-auto ${className}`}>
      {data.parsed.lines.map((l, i) => (
        <p
          key={i}
          data-line={i}
          className={`m-0 py-0.5 text-[15px] leading-relaxed transition-colors ${!data.parsed.synced ? 'text-ink' : i === idx ? 'gv-neon-text font-semibold text-accent' : i < idx ? 'text-muted' : 'text-soft'}`}
        >
          {l.text || ' '}
        </p>
      ))}
    </div>
  );
}

function QueueList() {
  const { queue, index, playing, playIndex } = usePlayer();
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    box.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  if (!queue.length) return <p className="m-0 text-sm text-muted">Køen er tom.</p>;
  return (
    <ol ref={box} className="gv-scroll m-0 h-full list-none overflow-y-auto p-0">
      {queue.map((a, i) => {
        const m = a.manifest;
        const cur = i === index;
        return (
          <li key={`${m.id}-${i}`}>
            <button
              type="button"
              onClick={() => playIndex(i)}
              aria-current={cur ? 'true' : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left ${cur ? 'bg-accent/[0.12]' : 'hover:bg-white/[0.04]'}`}
            >
              <span className="w-6 flex-none text-right font-mono text-xs text-muted">{cur ? <span className="text-accent">{playing ? '▶' : '❚❚'}</span> : i + 1}</span>
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={32} rounded={5} />
              <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${cur ? 'text-accent' : 'text-ink-strong'}`}>{m.title}</span>
              <span className="font-mono text-xs text-soft">{m.bpm ? Math.round(m.bpm) : '–'}</span>
              <span className="w-12 text-right font-mono text-xs text-muted">{formatTime(m.durationMs)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- Spilles nå-panelet

export type DeckTab = 'now' | 'queue' | 'lyrics' | 'credits';
export const DECK_TABS: Array<[DeckTab, string]> = [
  ['now', 'Spilles nå'],
  ['queue', 'Kø'],
  ['lyrics', 'Tekst'],
  ['credits', 'Kreditering']
];

export function Tabs<T extends string>({ tabs, value, onChange, label, segmented = false }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void; label: string; segmented?: boolean }) {
  return (
    <div role="tablist" aria-label={label} className={`flex min-w-0 ${segmented ? 'rounded-xl border border-white/10 bg-white/[0.03] p-1' : 'gap-1.5'}`}>
      {tabs.map(([id, name]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          onKeyDown={(e) => {
            const i = tabs.findIndex(([t]) => t === id);
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]![0];
              onChange(n);
              (e.currentTarget.parentElement?.querySelector(`[data-tab="${n}"]`) as HTMLElement | null)?.focus();
            }
          }}
          data-tab={id}
          tabIndex={value === id ? 0 : -1}
          className={`h-9 whitespace-nowrap rounded-lg px-3.5 text-sm transition-colors ${segmented ? 'flex-1' : ''} ${
            value === id ? 'gv-neon-soft border border-accent/80 bg-accent/[0.12] font-semibold text-accent' : 'border border-transparent text-soft hover:text-ink-strong'
          }`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export function NowPanel({ cur, onMore, extra, idle }: { cur: LoadedAsset; onMore: (anchor: { x: number; y: number } | null) => void; extra?: ReactNode; idle?: (atMs?: number) => void }) {
  const [tab, setTab] = useState<DeckTab>('now');
  const { loop, seek, setLoop } = usePlayer();
  const m = cur.manifest;
  return (
    <section aria-label="Spilles nå" className="gv-panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Tabs tabs={DECK_TABS} value={tab} onChange={setTab} label="Visning" />
        <span className="flex-1" />
        <span title="Spilles på denne enheten" className="hidden h-9 w-9 items-center justify-center text-soft xl:flex">
          <OutputIcon width={19} height={19} />
        </span>
        <a href="/studio" aria-label="Åpne i Studio" title="Åpne i Studio" className="flex h-9 w-9 items-center justify-center rounded-lg text-soft hover:text-ink-strong">
          <ScreenIcon width={19} height={19} />
        </a>
        <button
          type="button"
          aria-label={`Valg for ${m.title}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMore({ x: r.right - 260, y: r.bottom + 4 });
          }}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-soft hover:text-ink-strong"
        >
          <MoreIcon width={19} height={19} />
        </button>
      </div>
      <div className="relative h-[168px]">
        {tab === 'now' && (
          <div className="flex h-full flex-col justify-center gap-2">
            <BigWaveform asset={cur} height={128} loop={loop} onSeek={(ms) => (idle ? idle(ms) : seek(ms))} onLoop={(a, b, snap) => !idle && setLoop(a, b, snap)} />
            <div className="flex justify-between text-[13px] text-soft">
              <LiveTime />
              {loop && <span className="font-mono text-[11px] text-accent">A·B {formatTimeMs(loop.a)} – {formatTimeMs(loop.b)}</span>}
              <span className="font-mono">{formatTimeMs(m.durationMs)}</span>
            </div>
          </div>
        )}
        {tab === 'queue' && <QueueList />}
        {tab === 'lyrics' && <LyricsView cur={cur} className="h-full" />}
        {tab === 'credits' && (
          <div className="gv-scroll h-full overflow-y-auto">
            <Credits cur={cur} />
          </div>
        )}
      </div>
      <div className="border-t border-white/[0.06] pt-3">
        <Transport idle={idle} />
      </div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
        <BottomControls cur={cur} />
      </div>
      {extra}
    </section>
  );
}

// ---------------------------------------------------------------- Høyre kolonne

export function TrackInfoPanel({ cur }: { cur: LoadedAsset }) {
  return (
    <Panel title="Låtinfo">
      <TrackInfoRows cur={cur} />
    </Panel>
  );
}
export function ZoomPanel({ cur }: { cur: LoadedAsset }) {
  const seek = usePlayer((s) => s.seek);
  return (
    <Panel title="Bølgeform-zoom">
      <ZoomWaveform asset={cur} onSeek={seek} />
    </Panel>
  );
}
export function SpectrumPanel({ cur }: { cur: LoadedAsset }) {
  return (
    <Panel title="Spektrum (Hz)">
      <SpectrumView asset={cur} />
    </Panel>
  );
}

/** 1024–1279 px: høyre kolonne blir faner under bølgeformen. */
export function SideTabs({ cur }: { cur: LoadedAsset }) {
  const [tab, setTab] = useState<'info' | 'zoom' | 'spectrum'>('info');
  const seek = usePlayer((s) => s.seek);
  return (
    <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-3">
      <Tabs
        label="Analyse"
        tabs={[
          ['info', 'Låtinfo'],
          ['zoom', 'Zoom'],
          ['spectrum', 'Spektrum']
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'info' && <TrackInfoRows cur={cur} />}
      {tab === 'zoom' && <ZoomWaveform asset={cur} onSeek={seek} />}
      {tab === 'spectrum' && <SpectrumView asset={cur} />}
    </div>
  );
}
