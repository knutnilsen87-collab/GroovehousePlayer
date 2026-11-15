import { formatTime, resumeText } from '@gv/shared/web';
import type { Track } from '../lib/catalog';
import { claimResume, dismissResume, useResumeOffer } from '../lib/playbackSync';
import { usePlayer } from '../lib/player';

/** Del 5: «Spilte på PC-en – Live-sett 1:02:14. Fortsett her?» */
export function ResumeBanner({ tracks }: { tracks: Track[] }) {
  const offer = useResumeOffer();
  if (!offer) return null;
  const track = tracks.find((t) => t.slug === offer.slug);
  const asset = track?.variants.find((v) => (v.manifest.variant ?? 'main') === offer.variant) ?? track?.main ?? null;
  const title = asset?.manifest.title ?? offer.slug;
  const go = () => {
    if (!asset) {
      dismissResume();
      return;
    }
    void claimResume(offer).catch(() => undefined);
    usePlayer.getState().playFrom([asset], 0, offer.positionMs);
  };
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3">
      <p className="m-0 min-w-0 flex-1 text-sm text-ink">{resumeText(title, offer)}</p>
      <span className="font-mono text-xs text-muted">{formatTime(offer.positionMs)}</span>
      <button type="button" onClick={go} className="h-11 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
        Fortsett her
      </button>
      <button type="button" onClick={dismissResume} className="h-11 rounded-full px-3 text-sm text-muted">
        Ikke nå
      </button>
    </div>
  );
}
