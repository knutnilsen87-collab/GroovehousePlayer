import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { estimateShareBytes, formatBytes, shareFileName, type ShareKind } from '@gv/shared/web';
import { assetUrl, variantName } from '../lib/catalog';
import { toastError, useToast } from '../lib/playlists';
import { canReveal, canShareFiles, fetchShareFile, logShare, revealInExplorer, shareFetched, type Fetched } from '../lib/share';
import { isApp } from '../lib/platform';
import { isDesktop, useUi } from '../lib/ui';
import { CoverArt } from './CoverArt';

const KINDS: Array<{ kind: ShareKind; label: string; hint: string }> = [
  { kind: 'full', label: 'Hele låten', hint: 'AAC 256 kbps · med cover' },
  { kind: 'preview', label: 'Smakebit 30 s', hint: 'kort klipp' },
  { kind: 'wav', label: 'Original WAV', hint: 'tapsfri, for samarbeid' }
];

/**
 * Del 10: «Del…» for én låt. To steg: hent fila (med framdrift), så «Del nå» i et nytt trykk.
 * Mobil: ark nederfra. Desktop: lite vindu, med «Vis i Utforsker» når du sitter ved PC-en.
 */
export function ShareSheetHost() {
  const a = useUi((s) => s.share);
  if (!a) return null;
  return <ShareSheet key={a.manifest.id} />;
}

function ShareSheet() {
  const a = useUi((s) => s.share)!;
  const close = useUi((s) => s.closeShare);
  const m = a.manifest;
  const [kind, setKind] = useState<ShareKind>('full');
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const shareable = isApp || canShareFiles();
  const desktop = isDesktop();
  const fileName = shareFileName({ artist: m.artist, title: m.title, variantLabel: m.variantLabel, kind });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      abort.current?.abort();
    };
  }, [close]);

  const choose = (k: ShareKind) => {
    abort.current?.abort();
    setKind(k);
    setFetched(null);
    setProgress(null);
    setError(null);
  };

  const fetchIt = async () => {
    setError(null);
    abort.current = new AbortController();
    setProgress({ loaded: 0, total: null });
    try {
      setFetched(await fetchShareFile(a, kind, (loaded, total) => setProgress({ loaded, total }), abort.current.signal));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  // Må kjøres direkte i trykket (Web Share-regelen) – derfor eget steg etter at fila er hentet.
  const shareNow = async () => {
    if (!fetched) return;
    try {
      const outcome = await shareFetched(fetched);
      if (outcome === 'cancelled') return;
      logShare(a, kind);
      useToast.getState().show(outcome === 'shared' ? `Delt: ${fetched.file.name}` : `Lastet ned: ${fetched.file.name}`);
      close();
    } catch (err) {
      toastError(err);
    }
  };

  const pct = progress?.total ? Math.round((progress.loaded / progress.total) * 100) : null;
  const sheetPos: CSSProperties | undefined = undefined;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Del ${m.title}`}
        style={sheetPos}
        className="fixed inset-x-0 bottom-0 max-h-[85svh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2 shadow-2xl lg:bottom-auto lg:left-1/2 lg:top-[14vh] lg:w-[420px] lg:-translate-x-1/2 lg:rounded-2xl lg:border"
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15 lg:hidden" />
        <div className="mb-3 flex items-center gap-3">
          <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={48} rounded={8} />
          <div className="flex min-w-0 flex-col">
            <h2 className="m-0 truncate text-[15px] font-semibold text-ink-strong">Del «{m.title}»</h2>
            <span className="truncate text-xs text-muted">{[m.variant ? variantName(a) : null, `v${m.version}`].filter(Boolean).join(' · ')}</span>
          </div>
        </div>

        <div role="radiogroup" aria-label="Hva vil du dele?" className="flex flex-col gap-1.5">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              onClick={() => choose(k.kind)}
              className={`flex min-h-14 items-center gap-3 rounded-xl border px-3 text-left ${kind === k.kind ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/10 hover:border-white/20'}`}
            >
              <span aria-hidden="true" className={`h-4 w-4 flex-none rounded-full border ${kind === k.kind ? 'border-accent bg-accent' : 'border-white/30'}`} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15px] font-semibold text-ink-strong lg:text-sm">{k.label}</span>
                <span className="text-xs text-muted">{k.hint}</span>
              </span>
              <span className="tabular text-xs text-muted">ca. {formatBytes(estimateShareBytes(k.kind, m))}</span>
            </button>
          ))}
        </div>

        <p className="m-0 mt-3 break-words text-xs text-muted">
          Fila heter: <span className="text-ink">{fileName}</span>
        </p>
        {!shareable && (
          <p className="m-0 mt-2 rounded-lg bg-white/[0.05] px-3 py-2 text-xs text-[#E7D9AE]">
            Deling krever HTTPS – bruk Tailscale-adressen, eller send den nedlastede fila.
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 mt-2 rounded-lg border border-[#FF8A7A]/40 bg-[#FF8A7A]/[0.07] px-3 py-2 text-sm text-[#FFB4A8]">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {progress ? (
            <div aria-live="polite" className="flex flex-col gap-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: pct != null ? `${pct}%` : '30%' }} />
              </div>
              <span className="text-xs text-muted">{pct != null ? `Henter … ${pct} %` : `Lager fila … ${formatBytes(progress.loaded)}`}</span>
            </div>
          ) : fetched ? (
            <button type="button" onClick={() => void shareNow()} className="h-12 rounded-full bg-accent text-sm font-semibold text-on-accent">
              {shareable ? 'Del nå' : 'Last ned'}
            </button>
          ) : (
            <button type="button" onClick={() => void fetchIt()} className="h-12 rounded-full bg-accent text-sm font-semibold text-on-accent">
              {shareable ? 'Gjør klar til deling' : 'Gjør klar til nedlasting'}
            </button>
          )}
          {desktop && canReveal() && (
            <button
              type="button"
              onClick={() =>
                void revealInExplorer(a, kind)
                  .then(() => (logShare(a, kind), useToast.getState().show('Åpnet i Utforsker')))
                  .catch(toastError)
              }
              className="h-11 rounded-full border border-white/15 text-sm text-ink hover:border-white/30"
            >
              Vis i Utforsker
            </button>
          )}
          <button type="button" onClick={close} className="h-11 rounded-full text-sm text-muted hover:text-ink">
            Avbryt
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
