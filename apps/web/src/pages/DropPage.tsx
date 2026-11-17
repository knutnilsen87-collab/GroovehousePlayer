import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { formatTime, paletteToCssVars, GOLD_FALLBACK } from '@gv/shared/web';
import { Logo } from '../components/Brand';
import { CoverArt } from '../components/CoverArt';
import { LockIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, ShieldIcon } from '../components/Icons';
import { Waveform } from '../components/Waveform';
import { assetUrl, findMain, useCatalog } from '../lib/catalog';
import { listener as t } from '../lib/i18n';
import { usePlayer } from '../lib/player';
import { findDrop } from '../lib/seed';

/**
 * Lyttersiden («gjest i Hvelvet»). Maksimal estetikk, minimal interaksjon.
 * Gull før avspilling; coverets farger tar over rommet når musikken starter.
 * Fase 1: drop og mottaker fra seed + ?r=<navn>. Fase 2: invitasjonstoken → Edge Function.
 */
export function DropPage({ dropSlug, recipient }: { dropSlug: string; recipient: string | null }) {
  const drop = findDrop(dropSlug);
  const { assets, loading, error, retry } = useCatalog();
  const { queue, index, playing, positionMs, started, setQueue, playIndex, toggle, next, prev, seek } = usePlayer();

  const dropAssets = useMemo(() => {
    if (!drop) return [];
    return drop.assetSlugs.map((s) => findMain(assets, s)).filter((a): a is NonNullable<typeof a> => !!a);
  }, [drop, assets]);

  useEffect(() => {
    if (dropAssets.length) setQueue(dropAssets);
  }, [dropAssets, setQueue]);

  const current = queue[index];
  const palette = current?.manifest.palette ?? GOLD_FALLBACK;
  const vars = paletteToCssVars(palette) as CSSProperties;
  const name = recipient?.trim() || null;

  if (!drop) return <Centered>{t.notFound}</Centered>;
  if (loading) return <Centered>{t.loading}</Centered>;
  if (error) return (
    <Centered>
      <span role="alert">Could not load this listening room.</span>
      <button type="button" onClick={retry} className="min-h-11 rounded-full border border-gold/50 px-5 text-sm font-semibold text-gold">Try again</button>
    </Centered>
  );
  if (drop.opensAt && new Date(drop.opensAt) > new Date()) return <Countdown opensAt={drop.opensAt} />;
  if (drop.expiresAt && new Date(drop.expiresAt) < new Date()) return <Centered>{t.notFound}</Centered>;
  if (!current) return <Centered>{t.empty}</Centered>;

  const m = current.manifest;
  const duration = m.durationMs;
  const progress = duration ? Math.min(1, positionMs / duration) : 0;
  const daysLeft = drop.expiresAt ? Math.ceil((new Date(drop.expiresAt).getTime() - Date.now()) / 86_400_000) : null;
  const dropMarkers = m.markers.filter((k) => k.kind === 'drop').map((k) => ({ pct: k.startMs / duration, label: 'DROP' }));
  const chapterMarkers = m.markers.filter((k) => k.kind === 'chapter');

  return (
    <div className="relative min-h-[100svh] overflow-hidden bg-obsidian text-ink" style={vars}>
      {name && <Watermark text={`${name.toUpperCase()} · PRIVATE LISTENING ROOM`} />}

      {/* Glød: gull før start, coverfarger etter start. To lag som tones over i hverandre. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[300px] h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-1000"
        style={{ background: 'radial-gradient(circle, rgba(240,192,48,0.30) 0%, rgba(176,96,0,0.10) 40%, transparent 70%)', opacity: started ? 0 : 1 }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[300px] h-[620px] w-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity duration-1000"
        style={{ background: 'radial-gradient(circle, var(--glow) 0%, var(--glow-2) 38%, transparent 68%)', opacity: started ? 1 : 0 }}
      />

      <main className="relative z-10 mx-auto flex min-h-[100svh] w-full max-w-[440px] flex-col px-[22px] pb-4 pt-[18px]">
        <header className="flex h-11 items-center justify-between">
          <Logo size={38} />
          <span className="flex h-7 items-center gap-1.5 rounded-full border border-gold/45 px-3 text-[11px] font-semibold tracking-[1.5px] text-gold">
            <LockIcon width={12} height={12} strokeWidth={2.2} />
            THE VAULT
          </span>
        </header>

        <div className="mt-3.5 flex items-baseline justify-between gap-3 text-[13px]">
          <span>
            {name ? (
              <>
                {t.privateRoomFor} <strong className="font-semibold">{name}</strong>
              </>
            ) : (
              t.privateRoom
            )}
          </span>
          {daysLeft !== null && <span className="shrink-0 text-xs text-muted">{t.expiresIn(daysLeft)}</span>}
        </div>

        <div className="mt-[18px] flex justify-center">
          <CoverArt src={assetUrl(current, m.files.cover)} palette={palette} title={m.title} size={248} />
        </div>

        <div className="mt-[18px] flex flex-col items-center gap-1 text-center">
          <h1 className="m-0 font-display text-[32px] font-semibold uppercase tracking-[1.5px] text-ink-strong">{m.title}</h1>
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span>{m.artist ?? 'Groovehouse Records'}</span>
            <span aria-hidden="true">·</span>
            <span className="text-[11px] font-semibold tracking-[1px] transition-colors duration-500" style={{ color: started ? 'var(--accent)' : '#F0C030' }}>
              {m.kind === 'set' ? t.set.toUpperCase() : t.unreleased.toUpperCase()}
            </span>
          </div>
        </div>

        <div className="mt-5">
          <Waveform
            peaks={current.analysis?.peaks ?? []}
            progress={progress}
            active={started}
            markers={dropMarkers}
            label={t.seek}
            onSeek={(r) => seek(r * duration)}
          />
          <div className="tabular mt-1.5 flex justify-between text-[11px] text-muted">
            <span>{formatTime(positionMs)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-center gap-[30px]">
          <button type="button" aria-label={t.prev} onClick={prev} className="flex h-12 w-12 items-center justify-center rounded-full text-champagne active:scale-95">
            <PrevIcon width={22} height={22} />
          </button>
          <button
            type="button"
            aria-label={playing ? t.pause : t.play}
            onClick={toggle}
            className="h-[72px] w-[72px] rounded-full bg-gold p-[3px] shadow-[0_10px_30px_rgba(240,192,48,0.25)] active:scale-95"
          >
            <span className="flex h-full w-full items-center justify-center rounded-full bg-[#0B0D12] text-gold">
              {playing ? <PauseIcon width={26} height={26} /> : <PlayIcon width={26} height={26} className="ml-[3px]" />}
            </span>
          </button>
          <button type="button" aria-label={t.next} onClick={next} className="flex h-12 w-12 items-center justify-center rounded-full text-champagne active:scale-95">
            <NextIcon width={22} height={22} />
          </button>
        </div>

        {chapterMarkers.length > 0 && (
          <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="Chapters">
            {chapterMarkers.map((c) => (
              <li key={c.startMs}>
                <button
                  type="button"
                  onClick={() => seek(c.startMs)}
                  className="flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[11px] text-ink hover:border-accent"
                >
                  <span className="tabular text-muted">{formatTime(c.startMs)}</span>
                  {c.label}
                </button>
              </li>
            ))}
          </ol>
        )}

        <ul className="mt-3 flex flex-col border-t border-white/[0.07] pt-1.5">
          {queue.map((a, i) => {
            const isCur = i === index;
            return (
              <li key={a.manifest.id}>
                <button
                  type="button"
                  onClick={() => playIndex(i)}
                  className="flex min-h-12 w-full items-center gap-3 rounded-[10px] px-2 text-left hover:bg-white/[0.04]"
                >
                  <span
                    aria-hidden="true"
                    className="h-[30px] w-[30px] flex-none rounded-md"
                    style={{
                      background: a.manifest.files.cover
                        ? `center/cover url(${assetUrl(a, a.manifest.files.coverThumb)})`
                        : `radial-gradient(circle at 50% 45%, ${a.manifest.palette.primary} 0 30%, ${a.manifest.palette.secondary} 31% 46%, #0B0D12 47%)`
                    }}
                  />
                  <span className="flex flex-1 flex-col">
                    <span className={`text-sm font-semibold ${isCur ? 'text-ink-strong' : 'text-[#C9C4B6]'}`}>{a.manifest.title}</span>
                    <span className="text-[11px] text-muted">{isCur ? (playing ? t.nowPlaying : t.selected) : t.track(i + 1)}</span>
                  </span>
                  <span className="tabular text-xs text-muted">{formatTime(a.manifest.durationMs)}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <p className="mt-auto flex items-center justify-center gap-1.5 pt-4 text-[10px] uppercase tracking-[1px] text-[#8E897D]">
          <ShieldIcon width={11} height={11} />
          {t.footer}
        </p>
      </main>
    </div>
  );
}

/** Psykologisk vannmerke. Det beskytter ikke lyden – det er avskrekking, ikke DRM. */
function Watermark({ text }: { text: string }) {
  const rows = Array.from({ length: 16 }, () => `${text} · ${text}`);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -inset-[200px] z-0 flex -rotate-[28deg] flex-col justify-center gap-[46px]">
      {rows.map((r, i) => (
        <div key={i} className="whitespace-nowrap font-display text-[22px] font-semibold tracking-[6px] text-white/[0.05]">
          {r}
        </div>
      ))}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100svh] flex-col items-center justify-center gap-6 bg-obsidian px-6 text-center text-muted">
      <Logo size={48} />
      <p className="text-sm">{children}</p>
    </div>
  );
}

function Countdown({ opensAt }: { opensAt: string }) {
  const ms = new Date(opensAt).getTime() - Date.now();
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return (
    <Centered>
      <span className="block text-xs uppercase tracking-[2px] text-champagne">{t.opensIn}</span>
      <span className="mt-2 block font-display text-5xl font-semibold tracking-[2px] text-gold">
        {d}d {h}h
      </span>
    </Centered>
  );
}
