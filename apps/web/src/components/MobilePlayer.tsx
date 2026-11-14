import { useEffect, useRef, useState } from 'react';
import { formatTimeMs, keyShort, sectionAt } from '@gv/shared/web';
import { assetUrl, variantName, type LoadedAsset, type Track } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';
import { BottomControls, Credits, DECK_TABS, HeartButton, LiveTime, LyricsView, Tabs, TrackInfoRows, Transport, type DeckTab } from './Deck';
import { ChevronDownIcon, MoreIcon } from './Icons';
import { BigWaveform, SpectrumView, ZoomWaveform } from './Visuals';

/**
 * Del 14 pkt. 10: fullskjermspilleren på mobil og i Android-appen, ovenfra og ned:
 * cover · tittel/artist/hjerte/⋯ · brikker (BPM, toneart, LUFS) · bølgeform med tider · transport ·
 * volum (ikke i appen) / A·B / hastighet · sveipbare kort (Låtinfo / Spektrum / Zoom) · faner som
 * segmentert kontroll (Spilles nå · Kø · Tekst · Kreditering). Ingen backdrop-filter.
 */
export function FullPlayer({ cur, track, tracks, onClose, onPlay, onMore }: { cur: LoadedAsset; track?: Track; tracks: Track[]; onClose: () => void; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void; onMore: () => void }) {
  const { positionMs, seek, switchVariant, loop, setLoop } = usePlayer();
  const [tab, setTab] = useState<DeckTab>('now');
  const m = cur.manifest;
  const now = sectionAt(m.markers, positionMs);
  const single = m.kind === 'set' && now?.refSlug ? tracks.find((x) => x.slug === now.refSlug && x.main.manifest.kind === 'track') : undefined;
  const coverSize = Math.round(Math.min(window.innerWidth - 48, window.innerHeight * 0.4, 420));
  return (
    <div role="dialog" aria-modal="true" aria-label={`Spiller: ${m.title}`} className="gv-scroll fixed inset-0 z-40 flex flex-col overflow-y-auto bg-obsidian px-5 [&>*]:shrink-0 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(12px,env(safe-area-inset-top))] lg:hidden">
      <div aria-hidden="true" className="pointer-events-none fixed left-1/2 top-[24%] h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: 'radial-gradient(closest-side, var(--glow), var(--glow-2) 55%, transparent)', opacity: 'calc(0.55 + var(--sub, 0) * 0.35)' }} />
      <div className="relative flex items-center justify-between">
        <button type="button" onClick={onClose} aria-label="Lukk spilleren" className="flex h-11 w-11 items-center justify-center rounded-full text-soft">
          <ChevronDownIcon width={26} height={26} />
        </button>
        <span className="gv-label !text-[10px]">{m.kind === 'set' ? 'Live-sett' : 'Spilles nå'}</span>
        <span className="h-11 w-11" />
      </div>

      <div className="relative mt-3 flex justify-center">
        <div className="gv-panel overflow-hidden !rounded-2xl p-0" style={{ width: coverSize }}>
          <CoverArt src={assetUrl(cur, m.files.cover)} palette={m.palette} title={m.title} size={coverSize} rounded={16} />
        </div>
      </div>

      <div className="relative mt-5 flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 truncate text-[24px] font-bold leading-tight text-ink-strong">{m.title}</h2>
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

      <ul aria-label="Låtdata" className="relative m-0 mt-3 flex list-none gap-2 p-0 font-mono text-[12px]">
        {[
          ['BPM', m.bpm != null ? m.bpm.toFixed(1) : '–'],
          ['KEY', m.key ? `${keyShort(m.key.name)} ${m.key.camelot}` : '–'],
          ['LUFS', m.loudness.integratedLufs.toFixed(1)]
        ].map(([k, v]) => (
          <li key={k} className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/[0.06] px-2.5 py-1.5">
            <span className="text-muted">{k}</span>
            <span className="text-ink-strong">{v}</span>
          </li>
        ))}
      </ul>

      {track && track.variants.length > 1 && (
        <div role="group" aria-label="Variant" className="relative mt-3 flex flex-wrap gap-1.5">
          {track.variants.map((v) => (
            <button
              key={v.manifest.id}
              type="button"
              aria-pressed={v.manifest.id === m.id}
              onClick={() => switchVariant(v)}
              className={`h-9 rounded-full px-3.5 text-xs font-semibold ${v.manifest.id === m.id ? 'gv-neon-soft border border-accent/70 bg-accent/[0.12] text-ink-strong' : 'border border-white/10 text-muted'}`}
            >
              {variantName(v)}
            </button>
          ))}
        </div>
      )}

      <div className="relative mt-4">
        <BigWaveform asset={cur} height={72} loop={loop} onSeek={seek} onLoop={(a, b, snap) => setLoop(a, b, snap)} />
        <div className="mt-1.5 flex justify-between text-[11px] text-soft">
          <LiveTime />
          {now?.label && <span className="font-semibold text-accent">{now.label}</span>}
          <span className="font-mono">{formatTimeMs(m.durationMs)}</span>
        </div>
      </div>
      {single && (
        <button type="button" onClick={() => onPlay(single)} className="relative mt-2 h-10 self-start rounded-full border border-white/15 px-4 text-xs text-ink">
          Gå til enkeltlåt: {single.main.manifest.title} →
        </button>
      )}

      <div className="relative mt-4">
        <Transport size="lg" />
      </div>
      <div className="relative mt-4 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-1.5">
        <BottomControls cur={cur} />
      </div>

      <div className="relative mt-4 min-h-[220px]">
        {tab === 'now' && <Cards cur={cur} onSeek={seek} />}
        {tab === 'queue' && <MobileQueue />}
        {tab === 'lyrics' && (
          <div className="gv-panel p-4">
            <LyricsView cur={cur} className="max-h-[300px]" />
          </div>
        )}
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

/** Sveipbare kort: Låtinfo / Spektrum / Zoom (scroll-snap, prikker under). */
function Cards({ cur, onSeek }: { cur: LoadedAsset; onSeek: (ms: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const names = ['Låtinfo', 'Spektrum (Hz)', 'Bølgeform-zoom'];
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
            {i === 0 && <TrackInfoRows cur={cur} />}
            {i === 1 && active === 1 && <SpectrumView asset={cur} height={130} />}
            {i === 1 && active !== 1 && <div className="h-[146px]" />}
            {i === 2 && active === 2 && <ZoomWaveform asset={cur} height={110} onSeek={onSeek} />}
            {i === 2 && active !== 2 && <div className="h-[126px]" />}
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
            <button type="button" onClick={() => playIndex(i)} aria-current={cur ? 'true' : undefined} className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left ${cur ? 'bg-accent/[0.12]' : ''}`}>
              <span className="w-5 text-right font-mono text-xs text-muted">{cur ? <span className="text-accent">{playing ? '▶' : '❚❚'}</span> : i + 1}</span>
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
