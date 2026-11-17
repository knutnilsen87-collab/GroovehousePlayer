import { useEffect, useState } from 'react';
import type { LoadedAsset } from '../lib/catalog';
import { captureIdeaFor } from '../lib/fx';
import { makeRender, sendFeedback, usePreview, type RenderInfo } from '../lib/renders';
import { toastError, useToast } from '../lib/playlists';

/**
 * Del 20 C/D: «Hør overgangen» – lager overgangen fra A til B (med presetet) og spiller den. Viser kvalitetssjekken
 * (grønn, eller rød med grunn og et alternativ), og tommel opp/ned som går inn i læringen.
 */
export function TransitionPreview({ from, to, preset, compact = false, initial }: { from: LoadedAsset; to: LoadedAsset; preset: string | null; compact?: boolean; /** Ferdig laget (f.eks. av «Lag alle overganger»). */ initial?: RenderInfo }) {
  const [r, setR] = useState<RenderInfo | null>(initial ?? null);
  useEffect(() => {
    if (initial) setR(initial);
  }, [initial]);
  const [busy, setBusy] = useState(false);
  const [vote, setVote] = useState<1 | -1 | null>(null);
  const playingId = usePreview((s) => s.playingId);
  const loadingId = usePreview((s) => s.loadingId);
  const listen = async (x: { id: string; url: string }) => {
    if (playingId === x.id) return usePreview.getState().stop();
    await usePreview.getState().play(x).catch(toastError);
  };
  const go = async () => {
    setBusy(true);
    try {
      const res = r ?? (await makeRender(from, to, preset));
      setR(res);
      await listen(res);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const feedback = async (v: 1 | -1) => {
    if (!r) return;
    setVote(v);
    await sendFeedback(from, to, r.preset, v).catch(() => {});
    // Tommel opp: presetet huskes for denne overgangen (læringen fra del 17/18)
    if (v === 1) await captureIdeaFor(from.manifest.slug, to.manifest.slug, r.preset).catch(() => {});
    useToast.getState().show(v === 1 ? `Lagret: ${r.presetName} passer her` : 'Notert – Vault foreslår noe annet her neste gang');
  };
  const btn = `inline-flex items-center gap-1.5 rounded-full px-3 font-semibold ${compact ? 'h-11 text-[12px] lg:h-8' : 'h-11 text-[13px] lg:h-9'}`;
  const playing = r && playingId === r.id;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => void go()} disabled={busy || loadingId === r?.id} aria-pressed={!!playing} className={`${btn} bg-accent/[0.14] text-accent hover:bg-accent/25 disabled:opacity-50`}>
        {busy ? 'Lager overgangen …' : playing ? '■ Stopp' : '▶ Hør overgangen'}
      </button>
      {r && (
        <>
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.quality.ok ? 'bg-accent/[0.12] text-ink-strong' : 'bg-[#FF6B5A]/20 text-[#FFB4A8]'}`} title={r.quality.notes.join(' · ') || `Takt-avvik ${r.quality.offsetMs ?? '–'} ms`}>
            {r.quality.ok ? `OK · ${r.presetName}` : `Sjekk: ${r.quality.notes[0]}`}
          </span>
          {r.alternative && (
            <button type="button" onClick={() => void listen(r.alternative!)} className={`${btn} bg-white/[0.06] text-ink`}>
              {playingId === r.alternative.id ? '■ Stopp' : `▶ Alternativ: ${r.alternative.presetName}`}
            </button>
          )}
          <button type="button" aria-label="Tommel opp" aria-pressed={vote === 1} onClick={() => void feedback(1)} className={`h-11 w-11 rounded-full lg:h-8 lg:w-8 ${vote === 1 ? 'bg-accent/[0.2] text-accent' : 'text-muted hover:text-ink'}`}>
            👍
          </button>
          <button type="button" aria-label="Tommel ned" aria-pressed={vote === -1} onClick={() => void feedback(-1)} className={`h-11 w-11 rounded-full lg:h-8 lg:w-8 ${vote === -1 ? 'bg-white/[0.12] text-ink' : 'text-muted hover:text-ink'}`}>
            👎
          </button>
        </>
      )}
    </span>
  );
}
