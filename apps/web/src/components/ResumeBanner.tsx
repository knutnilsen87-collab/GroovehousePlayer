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
    <div role="status" className="mb-4 flex flex-col gap-2 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
      {/* Mobil: teksten på egen linje over knappene, så den ikke brekkes i en smal kolonne */}
      <p className="m-0 min-w-0 text-sm text-ink sm:flex-1">{resumeText(title, offer)}</p>
      <div className="flex items-center gap-2">
        <span className="mr-auto font-mono text-xs text-muted sm:mr-1">{formatTime(offer.positionMs)}</span>
        <button type="button" onClick={go} className="h-11 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
          Fortsett her
        </button>
        <button type="button" onClick={dismissResume} className="h-11 rounded-full px-3 text-sm text-muted">
          Ikke nå
        </button>
      </div>
    </div>
  );
}
