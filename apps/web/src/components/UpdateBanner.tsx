import { useState } from 'react';
import { installApk, useUpdate } from '../lib/updater';

/**
 * Del 15: diskret banner når Vault har en nyere APK. Første gang må Android få lov til å installere
 * apper fra Groovehouse Vault – det forklares før innstillingen åpnes.
 */
export function UpdateBanner() {
  const { apk, busy, error, canInstall, dismissed } = useUpdate();
  const [explain, setExplain] = useState(false);
  if (!apk || dismissed) return null;
  const go = async () => {
    const r = await installApk();
    if (r === 'permission') setExplain(true);
  };
  return (
    <div role="status" className="fixed inset-x-3 top-[max(10px,env(safe-area-inset-top))] z-50 rounded-2xl border border-accent/40 bg-[#0C0E13]/97 p-3 shadow-[0_10px_30px_rgba(0,0,0,0.5),0_0_20px_var(--glow-2)]">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold text-ink-strong">Ny app-versjon</span>
          <span className="truncate font-mono text-[11px] text-muted">
            {apk.versionName} · {apk.versionCode} · {(apk.size / 1e6).toFixed(1)} MB
          </span>
        </span>
        <button type="button" onClick={() => useUpdate.setState({ dismissed: true })} className="h-10 rounded-full px-3 text-sm text-muted">
          Senere
        </button>
        <button type="button" disabled={busy !== 'idle'} onClick={() => (canInstall ? void go() : setExplain(true))} className="gv-neon-soft h-10 rounded-full border border-accent px-4 text-sm font-semibold text-accent disabled:opacity-50">
          {busy === 'downloading' ? 'Laster ned …' : busy === 'installing' ? 'Åpner …' : 'Oppdater'}
        </button>
      </div>
      {explain && (
        <div className="mt-3 border-t border-white/[0.07] pt-3 text-[13px] text-soft">
          <p className="m-0">
            Android spør første gang om Groovehouse Vault får <b className="text-ink">installere ukjente apper</b>. Slå på «Tillat fra denne kilden», gå tilbake hit og trykk Oppdater igjen. Oppdateringen
            kommer bare fra din egen PC (sjekket med sha256).
          </p>
          <button
            type="button"
            onClick={() => {
              setExplain(false);
              void go();
            }}
            className="mt-2 h-9 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent"
          >
            Fortsett
          </button>
        </div>
      )}
      {error && <p className="m-0 mt-2 text-xs text-[#FF8A7A]">{error}</p>}
    </div>
  );
}
