import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { camelotRelation, displayLabel, formatTime, RELATION_TEXT, formatTimeMs, isDraft, keyShort, lyricIndexAt, parseLyricWords, RATE_MAX, RATE_MIN, versionName, wordIndexAt } from '@gv/shared/web';
import { assetUrl, uploadAssetCover, variantName, type LoadedAsset } from '../lib/catalog';
import { needsCheck, useFavorites, useIsFavorite, useLyrics } from '../lib/library';
import { getPositionMs, usePlayer } from '../lib/player';
import { isApp } from '../lib/platform';
import { toastError, useToast } from '../lib/playlists';
import { CoverArt } from './CoverArt';
import { DraftBadge } from './Draft';
import { HeartIcon, MoreIcon, NextIcon, OutputIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ScreenIcon, ShuffleIcon, SlidersIcon, SpeedIcon, UploadIcon, VolumeIcon } from './Icons';
import { BigWaveform, SpectrumView, ZoomWaveform } from './Visuals';
import { Heartbeat, useHeartbeatMotif } from './Brand';
import { useSkin } from '../lib/skin';
import { FxReminder } from './FxReminder';

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
  const motif = useHeartbeatMotif();
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
      className={`flex flex-none items-center justify-center rounded-full transition-colors ${on ? 'text-accent !opacity-100' : 'text-soft hover:text-ink-strong'} ${className}`}
    >
      {motif ? <Heartbeat width={Math.round(size * 2.2)} height={size} className={on ? '' : 'opacity-50'} /> : <HeartIcon filled={on} width={size} height={size} />}
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
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleCoverFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|avif|gif|tiff)$/i.test(file.type) && !/\.(jpe?g|png|webp|avif|gif|tiff?)$/i.test(file.name)) {
      useToast.getState().show('Velg en bildefil (JPG, PNG eller WebP)');
      return;
    }
    setUploading(true);
    try {
      const manifests = await uploadAssetCover(m.slug, file);
      usePlayer.getState().refreshManifests(manifests);
      useToast.getState().show(`Cover oppdatert for «${m.title}»`);
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <section aria-label="Låta som spilles" className="gv-panel flex min-w-0 flex-col gap-3 p-3">
      <div
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            if (!dragOver) setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = [...e.dataTransfer.files].find((x) => /^image\//i.test(x.type) || /\.(jpe?g|png|webp|avif|gif|tiff?)$/i.test(x.name)) ?? e.dataTransfer.files[0];
          void handleCoverFile(f);
        }}
        title="Dra og slipp et bilde her for å sette cover på låta"
        className={`group relative overflow-hidden rounded-xl transition-all ${
          dragOver ? 'ring-2 ring-accent shadow-[0_0_24px_var(--glow)]' : ''
        }`}
      >
        <CoverArt src={assetUrl(cur, m.files.cover)} palette={m.palette} title={m.title} size={600} rounded={12} fluid draft={isDraft(m)} />
        {/* Del 23: generert Vault-cover – et ekte cover (dra-og-slipp) erstatter det */}
        {m.coverSource === 'generated' && !dragOver && (
          <span title="Laget av Vault fra toneart, bølgeform og spektrum. Slipp et bilde her for ekte cover." className="absolute bottom-2.5 left-2.5 rounded-full bg-sunken/85 px-2.5 py-1 font-label text-[9px] font-bold uppercase tracking-[0.14em] text-soft">
            Vault-cover
          </span>
        )}

        {/* Subtil knapp ved hover for å velge cover (eller vise at dra-og-slipp støttes) */}
        {!dragOver && !uploading && (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            aria-label={`Bytt cover for ${m.title}`}
            className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-sunken/85 px-2.5 py-1 text-[11px] font-medium text-soft opacity-0 transition-opacity hover:text-ink-strong focus-visible:opacity-100 group-hover:opacity-100"
          >
            <UploadIcon width={13} height={13} />
            <span>{m.files.cover && m.coverSource !== 'generated' ? 'Bytt cover' : 'Slipp ekte cover her'}</span>
          </button>
        )}

        {/* Aktiv dra-og-slipp-sone */}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-obsidian/85 p-4 text-center backdrop-blur-sm">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-accent/60 bg-accent/15 text-accent">
              <UploadIcon width={22} height={22} />
            </span>
            <span className="text-xs font-semibold text-ink-strong">Slipp bildet for å sette cover</span>
            <span className="max-w-[180px] truncate text-[11px] text-soft">{m.title}</span>
          </div>
        )}

        {/* Opplastingsindikator */}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-obsidian/80 text-xs font-semibold text-ink-strong backdrop-blur-sm">
            Lagrer cover …
          </div>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="sr-only"
          tabIndex={-1}
          aria-label={`Velg coverbilde for ${m.title}`}
          onChange={(e) => void handleCoverFile(e.target.files?.[0])}
        />
      </div>
      <div className="flex items-start gap-2 px-1 pb-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="gv-display truncate text-[22px] font-semibold leading-tight text-ink-strong">
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
  // Del 22: ikonene 15–20 % større og uten sirkel rundt; treffflate minst 44 px
  const icon = big ? 33 : 30;
  const subIcon = big ? 26 : 24;
  const btn = 'flex h-12 w-12 items-center justify-center text-soft transition-colors hover:text-ink-strong';
  const repeatLabel = repeat === 'off' ? 'Gjenta: av' : repeat === 'all' ? 'Gjenta: hele køen' : 'Gjenta: denne låta';
  return (
    <div className={`flex items-center justify-center py-1 ${big ? 'gap-5' : 'gap-7'}`}>
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
        <ShuffleIcon width={subIcon} height={subIcon} />
      </button>
      <button type="button" aria-label="Forrige spor" onClick={prev} className={btn}>
        <PrevIcon width={icon} height={icon} />
      </button>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Spill'}
        data-playing={playing ? 'true' : 'false'}
        onClick={() => (!queue.length && idle ? idle() : toggle())}
        className={`gv-play flex flex-none items-center justify-center rounded-full ${big ? 'h-[76px] w-[76px]' : 'h-[66px] w-[66px]'}`}
      >
        {playing ? <PauseIcon width={big ? 32 : 28} height={big ? 32 : 28} /> : <PlayIcon width={big ? 32 : 28} height={big ? 32 : 28} className="ml-1" />}
      </button>
      <button type="button" aria-label="Neste spor" onClick={next} className={btn}>
        <NextIcon width={icon} height={icon} />
      </button>
      <button type="button" aria-label={repeatLabel} title={repeatLabel} aria-pressed={repeat !== 'off'} onClick={cycleRepeat} className={`${btn} ${repeat !== 'off' ? '!text-accent gv-neon-text' : ''}`}>
        <RepeatIcon one={repeat === 'one'} width={subIcon} height={subIcon} />
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
        state === 'on' ? 'border-transparent bg-accent/[0.16] text-accent shadow-[0_0_18px_-4px_var(--glow)]' : state === 'a' ? 'border-transparent bg-accent/[0.08] text-ink-strong' : 'border-transparent bg-white/[0.05] text-soft hover:bg-white/[0.09] hover:text-ink-strong'
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
        <div role="dialog" aria-label="Hastighet" className="gv-panel absolute bottom-11 right-0 z-30 flex w-60 flex-col gap-2 !bg-surface p-3">
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
        <div role="dialog" aria-label="Lydinnstillinger" className="gv-panel absolute bottom-11 right-0 z-30 flex w-64 flex-col gap-2 !bg-surface p-3 text-[12px]">
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

/**
 * Del 22: låtinfo som rutenett av pills (2 kolonner). Etikett over i Syncopate, verdi i Geist Mono, aksent 8–12 % bak.
 * Camelot-pillen farges etter harmonien mot låta som kommer etter i køen (farger fra skin-variablene).
 */
export function TrackInfoRows({ cur, compact = false }: { cur: LoadedAsset; compact?: boolean }) {
  const m = cur.manifest;
  const nextM = usePlayer((s) => (s.queue[s.index]?.manifest.id === m.id ? s.queue[s.index + 1]?.manifest : undefined));
  const rel = nextM ? camelotRelation(m.key?.camelot ?? null, nextM.key?.camelot ?? null) : null;
  const harmony = rel == null || rel === 'unknown' ? undefined : rel === 'same' || rel === 'adjacent' || rel === 'relative' ? 'good' : rel === 'clash' ? 'clash' : 'boost';
  const minus = (n: number) => n.toFixed(1).replace('-', '\u2212');
  const pills: Array<{ k: string; v: string; title?: string; harmony?: string }> = [
    { k: 'BPM', v: m.bpm != null ? m.bpm.toFixed(1) : '–' },
    {
      k: 'Toneart',
    v: m.key ? `${keyShort(m.key.name)} · ${m.key.camelot}` : '–',
      harmony,
      title: nextM && rel ? `Mot «${nextM.title}» (${nextM.key?.camelot ?? '?'}): ${RELATION_TEXT[rel]}` : undefined
    },
    { k: 'LUFS', v: minus(m.loudness.integratedLufs) },
    // Del 16: utkast spilles normalisert (loudnorm); originalnivået står over
    ...(m.loudness.normalizedLufs != null ? [{ k: 'Avspilling', v: `${minus(m.loudness.normalizedLufs)} norm.` }] : []),
    { k: 'Tid', v: formatTime(m.durationMs) },
    { k: 'Format', v: m.sourceFormat?.label ?? '–', title: 'Strømmes som AAC 256 kbps' }
  ];
  return (
    <dl className={`m-0 grid grid-cols-2 ${compact ? 'gap-1.5' : 'gap-2'}`}>
        {pills.map((p, i) => (
        <div key={p.k} className={`gv-pill ${compact ? 'gv-pill-compact' : ''} ${i === pills.length - 1 && pills.length % 2 === 1 ? 'col-span-2' : ''}`} data-harmony={p.harmony} title={p.title}>
          <dt>{p.k}</dt>
          <dd>{p.v}</dd>
          </div>
        ))}
      </dl>
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
    ['Versjon', `${versionName(m)}${m.versionLabel && displayLabel(m.versionLabel) !== versionName(m) ? ` · ${displayLabel(m.versionLabel)}` : ''}`],
    ['Status', isDraft(m) ? 'Umastret' : 'Release-klar'],
    // Del 23: hvor coveret kommer fra (distributører spør om AI-generert innhold)
    ['Cover', m.coverSource === 'ai' ? `AI-generert${m.coverAi?.provider ? ` (${m.coverAi.provider}${m.coverAi.model ? ` · ${m.coverAi.model}` : ''})` : ''}` : m.coverSource === 'generated' ? 'Vault-cover (generert)' : m.files.cover ? 'Eget cover' : 'Mangler'],
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

/**
 * Tekst & Karaoke-synk (WhisperX ord-tidsstempler + LRC):
 * - Lytter kontinuerlig på avspillingstiden med millisekundpresisjon, men oppdaterer React-state
 *   KUN når aktivt ord (activeWordIdx) eller aktiv linje (activeLineIdx) faktisk bytter (null unødvendige re-renders).
 * - Klikk/touch på hvilket som helst ord spoler rett til ordets tidsstempel.
 * - Vertikal fade-maske i topp/bunn og 45 % viewport-padding i bunnen så siste linje kan rulle helt opp til midten.
 */
export function LyricsView({ cur, className = '', stage = false, idle }: { cur: LoadedAsset; className?: string; stage?: boolean; idle?: (atMs?: number) => void }) {
  const data = useLyrics(cur.manifest.slug);
  const { playing, positionMs, seek, queue, index } = usePlayer();
  const isPlayingThis = queue[index]?.manifest.id === cur.manifest.id;
  const box = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);

  const wordData = useMemo(() => (data ? parseLyricWords(data.text, cur.manifest.durationMs) : null), [data, cur.manifest.durationMs]);
  const [activeWordIdx, setActiveWordIdx] = useState(-1);
  const [activeLineIdx, setActiveLineIdx] = useState(-1);

  // Kontinuerlig tidssynkronisering (kun state-oppdatering når indeks skifter)
  useEffect(() => {
    if (!wordData?.synced || ! data) {
      setActiveWordIdx(-1);
      setActiveLineIdx(-1);
      return;
    }
    const updateForTime = (ms: number) => {
      const lookahead = ms + 90;
      const wIdx = wordIndexAt(wordData.words, lookahead);
      const lIdx = wIdx >= 0 ? wordData.words[wIdx]!.lineIndex : lyricIndexAt(data.parsed.lines, lookahead);
      setActiveWordIdx((prev) => (prev === wIdx ? prev : wIdx));
      setActiveLineIdx((prev) => (prev === lIdx ? prev : lIdx));
    };

    updateForTime(isPlayingThis ? getPositionMs() || positionMs : 0);
    if (!isPlayingThis || !playing) return;

    let raf = 0;
    const tick = () => {
      updateForTime(getPositionMs());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wordData, data, isPlayingThis, playing, positionMs]);

  // Auto-scroll KUN når activeWordIdx eller activeLineIdx endres
  useEffect(() => {
    const target = activeWordRef.current ?? activeLineRef.current;
    if (!target || (activeWordIdx === -1 && activeLineIdx === -1)) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest'
    });
  }, [activeWordIdx, activeLineIdx]);

  const jumpTo = (ms: number) => {
    if (idle) idle(ms);
    else seek(ms);
  };

  if (data === undefined) return <p className="m-0 text-sm text-muted">Henter tekst …</p>;
  if (data === null || !wordData)
    return (
      <p className="m-0 text-sm text-muted">
        Ingen tekst ennå –{' '}
        <a href={`/studio#arkiv-${cur.manifest.slug}`} className="text-accent no-underline hover:underline">
          legg til eller auto-transkriber i Studio
        </a>
      </p>
    );

  return (
    <div
      ref={box}
      style={{
        maskImage: 'linear-gradient(to bottom, transparent, black 14%, black 84%, transparent)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 14%, black 84%, transparent)'
      }}
      className={`gv-scroll relative w-full overflow-y-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
        stage ? 'pb-[48vh] pt-[8vh] text-xl font-bold leading-snug md:text-3xl md:leading-relaxed' : 'pb-[45%] pt-4 text-[16px] font-semibold leading-relaxed'
      } ${className}`}
    >
      {needsCheck(data) && (
        <p className="sticky top-0 z-10 m-0 mb-2 inline-block rounded-full bg-accent-2/[0.18] px-2.5 py-0.5 text-[11px] font-semibold text-ink-strong" title="Transkribert automatisk fra lyden. Godkjennes i Studio.">
          Auto – sjekk teksten
        </p>
      )}
      {wordData.lines.map((line, li) => {
        const isLineActive = li === activeLineIdx;
        if (!wordData.synced || line.words.length === 0) {
          return (
            <p
              key={li}
              ref={isLineActive ? activeLineRef : null}
              onClick={() => line.ms != null && jumpTo(line.ms)}
              className={`m-0 py-1 transition-colors ${
                !wordData.synced
                  ? 'text-ink'
                  : isLineActive
                    ? 'gv-neon-text font-bold text-accent'
                    : li < activeLineIdx
                      ? 'cursor-pointer text-soft/65 hover:text-ink'
                      : 'cursor-pointer text-muted hover:text-soft'
              }`}
            >
              {line.text || '\u00A0'}
            </p>
          );
        }

        return (
          <p
            key={li}
            ref={isLineActive ? activeLineRef : null}
            className={`m-0 py-1 transition-opacity duration-200 ${isLineActive ? 'opacity-100' : li < activeLineIdx ? 'opacity-70' : 'opacity-55 hover:opacity-90'}`}
          >
            {line.words.map((w) => {
              const isWordActive = w.index === activeWordIdx;
              const isWordPast = w.index < activeWordIdx;
              return (
                <span
                  key={w.index}
                  ref={isWordActive ? activeWordRef : null}
                  role="button"
                  tabIndex={0}
                  onClick={() => jumpTo(w.startMs)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      jumpTo(w.startMs);
                    }
                  }}
                  title={`Hopp til ${formatTime(w.startMs)}`}
                  className={`inline-block cursor-pointer rounded-md py-1 pr-2 transition-all duration-200 ${
                    isWordActive
                      ? 'gv-neon-text scale-105 font-extrabold text-accent'
                      : isWordPast
                        ? 'text-ink/80 hover:text-ink-strong'
                        : 'text-soft/60 hover:text-ink'
                  }`}
                >
                  {w.word}
                </span>
              );
            })}
          </p>
        );
      })}
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
              className={`flex w-full items-center gap-3 rounded-r-lg px-2 py-1.5 text-left ${cur ? 'gv-row-active' : 'hover:bg-white/[0.04]'}`}
            >
              <span className="w-6 flex-none text-right font-mono text-[13px] text-muted">{cur ? <span className="text-accent">{playing ? '▶' : '❚❚'}</span> : i + 1}</span>
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={32} rounded={5} />
              <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${cur ? 'text-accent' : 'text-ink-strong'}`}>{m.title}</span>
              <span className="font-mono text-[13px] text-soft">{m.bpm ? Math.round(m.bpm) : '–'}</span>
              <span className="w-12 text-right font-mono text-[13px] text-muted">{formatTime(m.durationMs)}</span>
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
    <div
      role="tablist"
      aria-label={label}
      className={`inline-flex min-w-0 items-center gap-1 rounded-xl bg-white/[0.035] p-1 ${segmented ? 'flex w-full' : ''}`}
    >
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
          className={`h-8 whitespace-nowrap rounded-lg px-3.5 text-[13px] transition-all ${segmented ? 'flex-1' : ''} ${
            value === id ? 'bg-accent/[0.14] font-semibold text-accent shadow-[0_0_18px_-4px_var(--glow)]' : 'text-soft hover:bg-white/[0.04] hover:text-ink-strong'
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
  const motif = useHeartbeatMotif();
  const labels = useSkin((st) => st.skin.brand?.labels);
  const m = cur.manifest;
  return (
    <section aria-label="Spilles nå" className="gv-panel flex min-w-0 flex-col gap-3 p-4">
      {motif && (
        <div className="flex items-center gap-2" aria-hidden="true">
          <Heartbeat width={54} height={16} animate />
          {labels && <span className="gv-brand-label">{labels}</span>}
        </div>
      )}
      <FxReminder compact />
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
          <div className="-mx-4 flex h-full flex-col justify-center">
            {/* Del 22: kant til kant i panelet; tidene ligger oppå bølgeformen nederst i hjørnene */}
            <BigWaveform asset={cur} height={168} loop={loop} onSeek={(ms) => (idle ? idle(ms) : seek(ms))} onLoop={(a, b, snap) => !idle && setLoop(a, b, snap)}>
              <LiveTime className="pb-1 pl-4" />
              {loop && <span className="pb-1 text-[11px] text-accent">A·B {formatTimeMs(loop.a)} – {formatTimeMs(loop.b)}</span>}
              <span className="pb-1 pr-4">{formatTimeMs(m.durationMs)}</span>
            </BigWaveform>
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
        <Transport idle={idle} />
      <div className="gv-well px-3 py-2">
        <BottomControls cur={cur} />
      </div>
      {extra}
    </section>
  );
}

// ---------------------------------------------------------------- Høyre kolonne (konsolidert analysekort)

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

/** Konsolidert høyre sidefelt: Låtinfo øverst og felles fanevisning for Bølgeform-zoom / Spektrum i ett rammeverk. */
export function AnalysisSidebarCard({ cur }: { cur: LoadedAsset }) {
  const [graphTab, setGraphTab] = useState<'both' | 'zoom' | 'spectrum'>('both');
  const seek = usePlayer((s) => s.seek);
  return (
    <section aria-label="Låtanalyse" className="gv-panel flex min-w-0 flex-col gap-4 p-4">
      <div>
        <header className="mb-2 flex items-center justify-between gap-2">
          <h2 className="gv-label m-0">Låtinfo</h2>
        </header>
        <TrackInfoRows cur={cur} />
      </div>

      <div className="flex flex-col gap-3 pt-1">
        <div className="flex items-center justify-between gap-2">
          <Tabs
            label="Grafvisning"
            segmented
            tabs={[
              ['both', 'Begge'],
              ['zoom', 'Zoom'],
              ['spectrum', 'Spektrum']
            ]}
            value={graphTab}
            onChange={setGraphTab}
          />
        </div>
        {(graphTab === 'both' || graphTab === 'zoom') && (
          <div className="gv-well flex flex-col gap-1.5 p-3">
            <span className="gv-label">Bølgeform-zoom</span>
            <ZoomWaveform asset={cur} onSeek={seek} />
          </div>
        )}
        {(graphTab === 'both' || graphTab === 'spectrum') && (
          <div className="gv-well flex flex-col gap-1.5 p-3">
            <span className="gv-label">Spektrum (Hz)</span>
            <SpectrumView asset={cur} />
          </div>
        )}
      </div>
    </section>
  );
}

/** 1024–1279 px: høyre kolonne blir faner under bølgeformen. */
export function SideTabs({ cur }: { cur: LoadedAsset }) {
  const [tab, setTab] = useState<'info' | 'zoom' | 'spectrum'>('info');
  const seek = usePlayer((s) => s.seek);
  return (
    <div className="flex flex-col gap-3 pt-2">
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
