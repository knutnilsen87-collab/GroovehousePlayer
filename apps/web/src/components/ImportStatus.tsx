import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { isDraft } from '@gv/shared/web';
import { useDialog } from '../lib/dialog';
import { folderProblems, progressOf, recentImports, useImportStatus, type FolderStatus, type ImportStatus } from '../lib/importStatus';
import { go } from '../lib/nav';
import { lockVersionLabel } from '../lib/lock';
import { useUi } from '../lib/ui';
import type { LoadedAsset } from '../lib/catalog';
import { PlayIcon } from './Icons';

/** Del 27: følg importstatusen så lenge komponenten vises. */
export function useImportWatch(): ImportStatus | null {
  const acquire = useImportStatus((s) => s.acquire);
  useEffect(() => acquire(), [acquire]);
  return useImportStatus((s) => s.status);
}

/** «Velg eksportmappe»: Studio → Innstillinger, ved eksportfeltet. Endrer aldri mappa selv. */
export const openExportSettings = () => go('/studio/innstillinger#eksport');

const STATE_LABEL: Record<FolderStatus['state'], string> = {
  ok: 'Tilgjengelig',
  unset: 'Ikke valgt',
  'missing-drive': 'Disken er ikke tilkoblet',
  missing: 'Mappa finnes ikke',
  'not-dir': 'Ikke en mappe',
  locked: 'Låst av en annen prosess',
  denied: 'Ingen tilgang',
  error: 'Kan ikke leses'
};

function ProgressLine({ s }: { s: ImportStatus | null }) {
  const p = progressOf(s);
  if (!p.working) return null;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : null;
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-1.5">
      <span className="text-sm text-ink-strong">
        Ser etter låter …{p.total ? ` ${p.done} av ${p.total}` : p.queued ? ` ${p.queued} i kø` : ''}
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: pct != null ? `${Math.max(4, pct)}%` : '30%' }} />
      </div>
    </div>
  );
}

function FolderRow({ f, label }: { f: FolderStatus; label: string }) {
  const ok = f.state === 'ok';
  return (
    <li className="flex flex-col gap-1 rounded-xl bg-white/[0.03] px-3 py-2.5">
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-soft">{label}</span>
        <span className={`text-xs font-semibold ${ok ? 'text-soft' : 'text-[#FFB4A8]'}`}>{STATE_LABEL[f.state]}</span>
      </span>
      {f.dir && <span className="break-all font-mono text-[12px] text-ink">{f.dir}</span>}
      {!ok && f.reason && <span className="text-[13px] text-ink-strong">{f.reason}</span>}
      {!ok && f.fix && <span className="text-[13px] text-soft">{f.fix}</span>}
      {ok && f.watcher?.lastEvent && (
        <span className="text-[12px] text-muted">
          Siste: {f.watcher.lastEvent.text} ({new Date(f.watcher.lastEvent.at).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })})
        </span>
      )}
    </li>
  );
}

export function ImportStatusSheetHost({ assets, onPlay }: { assets: LoadedAsset[]; onPlay: (a: LoadedAsset) => void }) {
  const open = useUi((s) => s.importOpen);
  if (!open) return null;
  return <ImportStatusSheet assets={assets} onPlay={onPlay} />;
}

function ImportStatusSheet({ assets, onPlay }: { assets: LoadedAsset[]; onPlay: (a: LoadedAsset) => void }) {
  const close = () => useUi.getState().setImportOpen(false);
  const ref = useDialog<HTMLDivElement>(close);
  const s = useImportWatch();
  const error = useImportStatus((x) => x.error);
  const retry = useImportStatus((x) => x.retry);
  const [busy, setBusy] = useState(false);
  const problems = folderProblems(s);
  const recent = recentImports(s).slice(0, 5);
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gv-import-title"
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 max-h-[85svh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 shadow-2xl focus:outline-none lg:bottom-auto lg:left-1/2 lg:top-[10vh] lg:w-[520px] lg:-translate-x-1/2 lg:rounded-2xl lg:border"
      >
        <h2 id="gv-import-title" className="m-0 mb-1 text-base font-semibold text-ink-strong">
          Importstatus
        </h2>
        <p className="m-0 mb-3 text-[13px] text-soft">Vault leser mappene på PC-en og flytter eller sletter aldri noe der.</p>
        {!s && !error && <p className="text-sm text-muted">Henter status …</p>}
        {error && !s && (
          <p role="alert" className="text-sm text-[#FFB4A8]">
            Fikk ikke status fra PC-en ({error}).
          </p>
        )}
        {s && (
          <div className="flex flex-col gap-3">
            <ProgressLine s={s} />
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              <FolderRow f={s.export} label="Eksportmappe (Reason)" />
              {s.drafts.map((d, i) => (
                <FolderRow key={d.dir ?? i} f={d} label="Mappe for umastrede låter" />
              ))}
            </ul>
            {recent.length > 0 && (
              <section aria-labelledby="gv-import-recent" className="flex flex-col gap-1.5">
                <h3 id="gv-import-recent" className="gv-label m-0 text-[11px] text-soft">
                  Sist importert
                </h3>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {recent.map((r) => {
                    const a = assets.find((x) => x.manifest.slug === r.slug && (x.manifest.variant ?? null) === r.variant);
                    return (
                      <li key={`${r.slug}:${r.variant}:${r.version}:${r.at}`} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-semibold text-ink-strong">{r.title}</span>
                          <span className="text-[12px] text-muted">
                            {a && isDraft(a.manifest) ? 'Ny umastret' : 'Ny eksport'} · {lockVersionLabel(r.version).replace('umastret ', '')} · {new Date(r.at).toLocaleTimeString('nb-NO', { timeStyle: 'short' })}
                          </span>
                        </span>
                        {a && (
                          <button type="button" onClick={() => (onPlay(a), close())} className="flex h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-on-accent">
                            <PlayIcon width={14} height={14} /> Spill
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {problems.some((p) => p.state !== 'unset') && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await retry();
                setBusy(false);
              }}
              className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50"
            >
              {busy ? 'Prøver …' : 'Prøv igjen'}
            </button>
          )}
          <button type="button" onClick={openExportSettings} className="h-11 rounded-full border border-white/15 px-5 text-sm text-ink hover:border-white/30">
            Velg eksportmappe
          </button>
          <button type="button" onClick={close} className="ml-auto h-11 rounded-full px-4 text-sm text-muted hover:text-ink">
            Lukk
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const DISMISS_KEY = 'gv:import:seen';
const readSeen = (): string | null => {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
};

/**
 * Øverst i spilleren: «Ser etter låter …», en mappe som ikke er tilgjengelig (med årsak), og første ferdige
 * fil som «Ny eksport · v3» med Spill. Vises ikke når alt er i orden og ingenting er nytt.
 */
export function ImportBanner({ assets, onPlay, emptyLibrary }: { assets: LoadedAsset[]; onPlay: (a: LoadedAsset) => void; emptyLibrary: boolean }) {
  const s = useImportWatch();
  const [seen, setSeen] = useState<string | null>(readSeen);
  const p = progressOf(s);
  // Ikke valgt eksportmappe vises bare i tomt bibliotek (der står valget allerede)
  const problem = folderProblems(s).find((f) => f.state !== 'unset');
  const newest = recentImports(s)[0];
  const newKey = newest ? `${newest.slug}:${newest.variant}:${newest.version}` : null;
  const fresh = newest && Date.now() - Date.parse(newest.at) < 30 * 60_000 && newKey !== seen ? newest : null;
  const asset = useMemo(() => (fresh ? assets.find((a) => a.manifest.slug === fresh.slug && (a.manifest.variant ?? null) === fresh.variant && a.manifest.version === fresh.version) : undefined), [assets, fresh]);
  const dismiss = () => {
    if (!newKey) return;
    setSeen(newKey);
    try {
      localStorage.setItem(DISMISS_KEY, newKey);
    } catch {
      /* uten lagring */
    }
  };
  if (!p.working && !problem && !(fresh && asset)) return null;
  const open = () => useUi.getState().setImportOpen(true);
  return (
    <div className="mb-4 flex flex-col gap-2">
      {p.working && !emptyLibrary && (
        <button type="button" onClick={open} className="gv-panel-quiet w-full px-4 py-3 text-left">
          <ProgressLine s={s} />
        </button>
      )}
      {problem && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#FF8A7A]/35 bg-[#FF8A7A]/[0.06] px-4 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-semibold text-ink-strong">Mappe utilgjengelig: {problem.reason}</span>
            {problem.fix && <span className="text-[13px] text-soft">{problem.fix}</span>}
          </span>
          <button type="button" onClick={open} className="h-11 rounded-full border border-white/15 px-4 text-sm text-ink">
            Vis importstatus
          </button>
        </div>
      )}
      {fresh && asset && (
        <div className="gv-panel flex items-center gap-3 px-4 py-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="gv-label text-[11px] text-accent">{isDraft(asset.manifest) ? 'Ny umastret' : 'Ny eksport'} · {lockVersionLabel(fresh.version).replace('umastret ', '')}</span>
            <span className="truncate text-[15px] font-semibold text-ink-strong">{fresh.title}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onPlay(asset);
              dismiss();
            }}
            className="flex h-11 items-center gap-1.5 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent"
          >
            <PlayIcon width={14} height={14} /> Spill
          </button>
          <button type="button" onClick={dismiss} aria-label="Skjul" className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:text-ink">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** Tomt bibliotek (eller tom Umastret-gruppe): ingen terminal, bare valget av mappe og importstatusen. */
export function EmptyLibrary({ kind = 'all' }: { kind?: 'all' | 'draft' }) {
  const s = useImportWatch();
  const p = progressOf(s);
  const folder = kind === 'draft' ? s?.drafts.find((d) => d.state === 'ok') ?? s?.drafts[0] : s?.export;
  return (
    <section aria-labelledby="gv-empty-title" className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-accent/30 p-6 sm:p-8">
      <h2 id="gv-empty-title" className="m-0 text-lg font-semibold text-ink-strong">
        {kind === 'draft' ? 'Umastrede låter samles her' : 'Musikken din samles her'}
      </h2>
      <p className="m-0 max-w-[520px] text-sm text-soft">
        {kind === 'draft'
          ? 'Låter i mappene for umastrede låter dukker opp her av seg selv. De holdes atskilt fra de release-klare.'
          : 'Når Reason bouncer til eksportmappa, dukker låta opp her av seg selv. Vault leser bare mappa og endrer ingenting der.'}
      </p>
      {p.working && <ProgressLine s={s} />}
      {folder && (
        <p className="m-0 text-[13px] text-soft">
          {folder.dir ? (
            <>
              {kind === 'draft' ? 'Mappe' : 'Eksportmappe'}: <span className="break-all font-mono text-ink">{folder.dir}</span>
              {folder.state !== 'ok' && <span className="text-[#FFB4A8]"> · {folder.reason}</span>}
            </>
          ) : kind === 'draft' ? (
            'Ingen mappe for umastrede låter er valgt ennå.'
          ) : (
            'Ingen eksportmappe er valgt ennå.'
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={openExportSettings} className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent">
          {kind === 'draft' ? 'Velg mapper' : 'Velg eksportmappe'}
        </button>
        <button type="button" onClick={() => useUi.getState().setImportOpen(true)} className="h-11 rounded-full border border-white/15 px-5 text-sm text-ink hover:border-white/30">
          Åpne importstatus
        </button>
      </div>
    </section>
  );
}
