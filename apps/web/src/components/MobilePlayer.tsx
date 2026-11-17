import { useDialog } from '../lib/dialog';
import { useEffect, useRef, useState } from 'react';
import { formatTimeMs, isDraft, isReleased, sectionAt } from '@gv/shared/web';
import { assetUrl, useFullAsset, variantName, type LoadedAsset, type Track } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';
import { DraftBadge } from './Draft';
import { BottomControls, Credits, DECK_TABS, HeartButton, LiveTime, LyricsView, Tabs, TrackInfoRows, Transport, type DeckTab } from './Deck';
import { ChevronDownIcon, MoreIcon } from './Icons';
import { BigWaveform, SpectrumView, ZoomWaveform } from './Visuals';
import { FxReminder, IdeaButton } from './FxReminder';

/**
 * Del 14 pkt. 10: fullskjermspilleren på mobil og i Android-appen, ovenfra og ned:
 * cover · tittel/artist/hjerte/⋯ · brikker (BPM, toneart, LUFS) · bølgeform med tider · transport ·
 * volum (ikke i appen) / A·B / hastighet · sveipbare kort (Låtinfo / Spektrum / Zoom) · faner som
 * segmentert kontroll (Spilles nå · Kø · Tekst · Kreditering).
 * Del 22: låtinfo som pills øverst (ikke også som kort), bølgeformen kant til kant med tidene oppå, transport
 * uten sirkler. Blur bare på bunnpanelet i tekst-scenen (og minispilleren), av i OLED Svart.
 */
export function FullPlayer({ cur: curIn, track, tracks, onClose, onPlay, onMore }: { cur: LoadedAsset; track?: Track; tracks: Track[]; onClose: () => void; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void; onMore: () => void }) {
  const cur = useFullAsset(curIn);
  const { positionMs, seek, switchVariant, loop, setLoop } = usePlayer();
  const [tab, setTab] = useState<DeckTab>('now');
  const m = cur.manifest;
  const now = sectionAt(m.markers, positionMs);
  const single = m.kind === 'set' && now?.refSlug ? tracks.find((x) => x.slug === now.refSlug && x.main.manifest.kind === 'track') : undefined;
  const coverSize = Math.round(Math.min(window.innerWidth - 48, window.innerHeight * 0.34, 420));
  const isLyricsStage = tab === 'lyrics';
  // Del 27 pkt. 11: fokus inn i spilleren, Esc lukker, og fokus tilbake til minispilleren
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  if (isLyricsStage) {
    return (
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Spiller: ${m.title}`}
        className="fixed inset-0 z-40 flex h-[100dvh] flex-col overflow-hidden bg-obsidian pt-[max(12px,env(safe-area-inset-top))] lg:hidden"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-1/2 top-[28%] h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: 'radial-gradient(closest-side, var(--glow), var(--glow-2) 55%, transparent)', opacity: 'calc(0.45 + var(--sub, 0) * 0.3)' }}
        />

        {/* Topp-bar med kompakt sporinfo over tekst-scenen */}
        <div className="relative z-10 flex items-center gap-3 px-5 pb-2">
          <button type="button" onClick={onClose} aria-label="Lukk spilleren" className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-soft">
            <ChevronDownIcon width={26} height={26} />
          </button>
          <CoverArt src={assetUrl(cur, m.files.coverThumb)} palette={m.palette} title={m.title} size={38} rounded={8} draft={isDraft(m)} released={isReleased(m)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-bold leading-tight text-ink-strong">
              {m.title}
              <DraftBadge m={m} className="ml-1.5" />
            </span>
            <span className="truncate text-[12px] text-soft">
              {m.artist ?? 'Echo Groove'}
              {m.variant ? ` · ${variantName(cur)}` : ''}
            </span>
          </div>
          <HeartButton slug={m.slug} title={m.title} size={20} className="h-11 w-11" />
          <button type="button" onClick={onMore} aria-label="Valg for låta som spilles" className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-soft">
            <MoreIcon width={20} height={20} />
          </button>
        </div>

        {/* Visuell fokussone (0% - 62%): Tekst-scenen i z-0 som scroller under bunnpanelet */}
        <div className="relative z-0 flex min-h-0 flex-1 flex-col px-6">
          <LyricsView cur={cur} stage className="h-full" />
        </div>

        {/* Tommelsonen (65% - 100%): Flytende kontrollpanel i z-10 med bølgeform-scrubber og transport */}
        <div className="gv-glass fixed inset-x-0 bottom-0 z-10 flex flex-col gap-3 bg-gradient-to-t from-obsidian via-obsidian/90 to-transparent px-5 pt-10 pb-[max(20px,env(safe-area-inset-bottom))]">
          {/* Presisjonssone (65% - 75%): Bred bølgeform for scrubbing, kant til kant */}
          <div className="-mx-5">
            <BigWaveform asset={cur} height={64} loop={loop} onSeek={seek} onLoop={(a, b, snap) => setLoop(a, b, snap)}>
              <LiveTime className="pl-5" />
              {now?.label && <span className="font-sans font-semibold text-accent">{now.label}</span>}
              <span className="pr-5">{formatTimeMs(m.durationMs)}</span>
            </BigWaveform>
          </div>

          {/* Handlingssone (75% - 100%): Transportkontroller + faner */}
          <Transport size="lg" />
          <Tabs tabs={DECK_TABS} value={tab} onChange={setTab} label="Visning" segmented />
        </div>
      </div>
    );
  }

  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Spiller: ${m.title}`} className="focus:outline-none gv-scroll fixed inset-0 z-40 flex flex-col overflow-y-auto bg-obsidian px-5 [&>*]:shrink-0 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(12px,env(safe-area-inset-top))] lg:hidden">
      <div aria-hidden="true" className="pointer-events-none fixed left-1/2 top-[24%] h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: 'radial-gradient(closest-side, var(--glow), var(--glow-2) 55%, transparent)', opacity: 'calc(0.55 + var(--sub, 0) * 0.35)' }} />
      <div className="relative flex items-center justify-between">
        <button type="button" onClick={onClose} aria-label="Lukk spilleren" className="flex h-11 w-11 items-center justify-center rounded-full text-soft">
          <ChevronDownIcon width={26} height={26} />
        </button>
        <span className="gv-label">{m.kind === 'set' ? 'Live-sett' : 'Spilles nå'}</span>
        <span className="h-11 w-11" />
      </div>

      <div className="relative mt-3 flex justify-center">
        <div className="gv-panel overflow-hidden !rounded-2xl p-0" style={{ width: coverSize }}>
          <CoverArt src={assetUrl(cur, m.files.cover)} palette={m.palette} title={m.title} size={coverSize} rounded={16} draft={isDraft(m)} released={isReleased(m)} />
        </div>
      </div>

      <div className="relative mt-5 flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="gv-display m-0 truncate text-[26px] font-semibold leading-tight text-ink-strong">
            {m.title}<DraftBadge m={m} className="ml-1.5" />
          </h2>
          <span className="truncate text-[14px] text-soft">
            {m.artist ?? 'Echo Groove'}
            {m.variant ? ` · ${variantName(cur)}` : ''}
          </span>
        </div>
        <HeartButton slug={m.slug} title={m.title} size={22} className="h-11 w-11" />
        <button type="button" onClick={onMore} aria-label="Valg for låta som spilles" className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-soft">
          <MoreIcon width={22} height={22} />
        </button>
      </div>

      <div aria-label="Låtdata" className="relative mt-3">
        <TrackInfoRows cur={cur} compact />
      </div>

      {track && track.variants.length > 1 && (
        <div role="group" aria-label="Variant" className="relative mt-3 flex flex-wrap gap-1.5">
          {track.variants.map((v) => (
            <button
              key={v.manifest.id}
              type="button"
              aria-pressed={v.manifest.id === m.id}
              onClick={() => switchVariant(v)}
              className={`h-11 rounded-full px-3.5 text-xs font-semibold ${v.manifest.id === m.id ? 'bg-accent/[0.16] text-ink-strong shadow-[0_0_16px_-4px_var(--glow)]' : 'bg-white/[0.05] text-muted'}`}
            >
              {variantName(v)}
            </button>
          ))}
        </div>
      )}

      <div className="relative -mx-5 mt-4">
        <BigWaveform asset={cur} height={88} loop={loop} onSeek={seek} onLoop={(a, b, snap) => setLoop(a, b, snap)}>
          <LiveTime className="pl-5" />
          {now?.label && <span className="font-sans font-semibold text-accent">{now.label}</span>}
          <span className="pr-5">{formatTimeMs(m.durationMs)}</span>
        </BigWaveform>
      </div>
      {single && (
        <button type="button" onClick={() => onPlay(single)} className="relative mt-2 h-10 self-start rounded-full border border-white/15 px-4 text-xs text-ink">
          Gå til enkeltlåt: {single.main.manifest.title} →
        </button>
      )}

      <div className="relative mt-4 flex flex-col gap-2">
        <FxReminder />
        <Transport size="lg" />
      </div>
      <div className="gv-well relative mt-4 px-3 py-1.5">
        <BottomControls cur={cur} />
      </div>

      <div className="relative mt-4 min-h-[220px]">
        {tab === 'now' && (
          <div className="flex flex-col gap-3">
            <IdeaButton cur={cur} />
            <Cards cur={cur} onSeek={seek} />
          </div>
        )}
        {tab === 'queue' && <MobileQueue />}
        {/* Tekst-fanen vises som fullskjerm-scene (isLyricsStage over). */}
        {tab === 'credits' && (
          <div className="gv-panel p-4">
            <Credits cur={cur} />
          </div>
        )}
      </div>

      <div className="relative mt-4">
        <Tabs tabs={DECK_TABS} value={tab} onChange={setTab} label="Visning" segmented />
      </div>
    </div>
  );
}

/** Sveipbare kort: Spektrum / Zoom (scroll-snap, prikker under). Låtinfo står som pills øverst. */
function Cards({ cur, onSeek }: { cur: LoadedAsset; onSeek: (ms: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const names = ['Spektrum (Hz)', 'Bølgeform-zoom'];
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setActive(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <div ref={box} aria-label="Kort: sveip for flere" className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {names.map((n, i) => (
          <section key={n} aria-label={n} className="gv-panel w-[calc(100%-8px)] flex-none snap-center p-4">
            <h3 className="gv-label m-0 mb-3">{n}</h3>
            {i === 0 && active === 0 && <SpectrumView asset={cur} height={130} />}
            {i === 0 && active !== 0 && <div className="h-[146px]" />}
            {i === 1 && active === 1 && <ZoomWaveform asset={cur} height={110} onSeek={onSeek} />}
            {i === 1 && active !== 1 && <div className="h-[126px]" />}
          </section>
        ))}
      </div>
      <div className="flex justify-center gap-1.5" aria-hidden="true">
        {names.map((n, i) => (
          <button
            key={n}
            type="button"
            tabIndex={-1}
            onClick={() => box.current?.scrollTo({ left: i * box.current.clientWidth, behavior: 'smooth' })}
            className={`h-1.5 rounded-full transition-all ${active === i ? 'gv-neon w-5 bg-accent' : 'w-1.5 bg-white/25'}`}
          />
        ))}
      </div>
    </div>
  );
}

function MobileQueue() {
  const { queue, index, playing, playIndex } = usePlayer();
  return (
    <ol className="gv-panel m-0 flex list-none flex-col p-2">
      {queue.map((a, i) => {
        const m = a.manifest;
        const cur = i === index;
        return (
          <li key={`${m.id}-${i}`}>
            <button type="button" onClick={() => playIndex(i)} aria-current={cur ? 'true' : undefined} className={`flex min-h-12 w-full items-center gap-3 rounded-r-lg px-2 text-left ${cur ? 'gv-row-active' : ''}`}>
              <span className="w-5 text-right font-mono text-[13px] text-muted">{cur ? <span className="text-accent">{playing ? '▶' : '❚❚'}</span> : i + 1}</span>
              <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={36} rounded={6} />
              <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${cur ? 'text-accent' : 'text-ink-strong'}`}>{m.title}</span>
              <span className="font-mono text-[11px] text-muted">{m.bpm ? Math.round(m.bpm) : '–'}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
