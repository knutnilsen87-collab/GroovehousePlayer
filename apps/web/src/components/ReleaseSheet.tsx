import { useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { isDraft } from '@gv/shared/web';
import type { LoadedAsset } from '../lib/catalog';
import { useDialog } from '../lib/dialog';
import { toastError, useToast } from '../lib/playlists';

/**
 * Del 24: «Forbered utgivelse». Vault lager release-pakken på PC-en (WAV, cover 3000×3000, metadata, sjekkliste),
 * og viser feltene med kopier-knapper i samme rekkefølge som LANDRs skjema. Ingenting sendes noe sted –
 * Knut laster opp selv på landr.com («Åpne LANDR»). Umastrede blokkeres med mindre han velger «Utgi likevel».
 */
export const STATUS_NAMES = { none: 'Ikke planlagt', mastering: 'Til mastering', prepared: 'Forberedt', sent: 'Sendt til LANDR', planned: 'Planlagt', out: 'Ute' } as const;
export type ReleaseStatus = keyof typeof STATUS_NAMES;

interface PackResult {
  relDir: string;
  title: string;
  tracks: Array<{ n: number; title: string; file: string; truePeakDb: number | null; clipped: boolean }>;
  cover: { file: string | null; source: string; warning: string | null };
  fields: Array<{ label: string; value: string }>;
  checklist: Array<{ item: string; ok: boolean; note?: string }>;
  warnings: string[];
}

export const useReleaseUi = create<{ assets: LoadedAsset[] | null; title: string | null; open: (a: LoadedAsset[], title?: string) => void; close: () => void }>((set) => ({
  assets: null,
  title: null,
  open: (assets, title) => set({ assets, title: title ?? null }),
  close: () => set({ assets: null, title: null })
}));

const ref = (a: LoadedAsset) => ({ slug: a.manifest.slug, variant: a.manifest.variant ?? null, version: a.manifest.version });

export async function sendToLandr(a: LoadedAsset) {
  try {
    const r = await fetch('/api/landr/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ref(a)) });
    const j = (await r.json().catch(() => ({}))) as { file?: string; folder?: string; error?: string };
    if (!r.ok) throw new Error(j.error ?? `Feil ${r.status}`);
    useToast.getState().show(`Lagt i ${j.folder}: ${j.file}. Last den opp på landr.com – masteren kobles til låta når den kommer i Mastere.`);
  } catch (err) {
    toastError(err);
  }
}

export async function setStatus(a: LoadedAsset, status: ReleaseStatus, date?: string) {
  const r = await fetch(`/api/release-status/${encodeURIComponent(a.manifest.slug)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, date, variant: a.manifest.variant, version: a.manifest.version }) });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Feil ${r.status}`);
}

export function ReleaseSheetHost() {
  const assets = useReleaseUi((s) => s.assets);
  if (!assets) return null;
  return <ReleaseSheet assets={assets} />;
}

function ReleaseSheet({ assets }: { assets: LoadedAsset[] }) {
  const close = () => useReleaseUi.getState().close();
  const ref0 = useDialog<HTMLDivElement>(close);
  const [title, setTitle] = useState(() => useReleaseUi.getState().title ?? (assets.length === 1 ? assets[0]!.manifest.title : ''));
  const [genre, setGenre] = useState('Tech House');
  const [aiMusic, setAiMusic] = useState('');
  const [aiCover, setAiCover] = useState('');
  const [busy, setBusy] = useState(false);
  const [needConfirm, setNeedConfirm] = useState(false);
  const [res, setRes] = useState<PackResult | null>(null);
  const [date, setDate] = useState('');
  const drafts = assets.filter((a) => isDraft(a.manifest));
  const prepare = async (confirmDraft = false) => {
    setBusy(true);
    try {
      const r = await fetch('/api/releases/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: assets.map(ref), title: title || undefined, genre, confirmDraft, aiMusic: aiMusic || null, aiCover: aiCover || null }) });
      const j = (await r.json().catch(() => ({}))) as PackResult & { error?: string };
      if (r.status === 409 && !confirmDraft && drafts.length) return setNeedConfirm(true);
      if (!r.ok) throw new Error(j.error ?? `Feil ${r.status}`);
      setRes(j);
      setNeedConfirm(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const copy = (v: string, label: string) => void navigator.clipboard.writeText(v).then(() => useToast.getState().show(`Kopiert: ${label}`)).catch(() => useToast.getState().show('Kunne ikke kopiere'));
  const mark = async (s: ReleaseStatus) => {
    try {
      for (const a of assets) await setStatus(a, s, s === 'planned' || s === 'out' ? date || undefined : undefined);
      useToast.getState().show(`Status: ${STATUS_NAMES[s]}${s === 'out' ? ' – låta er merket Utgitt' : ''}`);
    } catch (err) {
      toastError(err);
    }
  };
  const field = 'h-11 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink lg:h-9';
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref0} role="dialog" aria-modal="true" aria-labelledby="gv-rel-title" tabIndex={-1} className="fixed inset-x-0 bottom-0 max-h-[90svh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 focus:outline-none lg:bottom-auto lg:left-1/2 lg:top-[6vh] lg:w-[640px] lg:-translate-x-1/2 lg:rounded-2xl lg:border">
        <h2 id="gv-rel-title" className="m-0 text-base font-semibold text-ink-strong">
          Forbered utgivelse {assets.length > 1 ? `(${assets.length} låter)` : ''}
        </h2>
        <p className="m-0 mb-3 text-[13px] text-soft">Lager mappa med lyd, cover og metadata på PC-en. Du sender selv inn på landr.com.</p>
        {!res && (
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              Tittel på utgivelsen
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={assets[0]!.manifest.title} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              Sjanger
              <input value={genre} onChange={(e) => setGenre(e.target.value)} className={field} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[12px] text-muted">
                AI brukt i musikken?
                <select value={aiMusic} onChange={(e) => setAiMusic(e.target.value)} className={field}>
                  <option value="">Velg selv</option>
                  <option value="ja">Ja</option>
                  <option value="nei">Nei</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-muted">
                AI brukt i coveret?
                <select value={aiCover} onChange={(e) => setAiCover(e.target.value)} className={field}>
                  <option value="">Velg selv</option>
                  <option value="ja">Ja</option>
                  <option value="nei">Nei</option>
                </select>
              </label>
            </div>
            {needConfirm && (
              <div role="alert" className="rounded-xl border border-[#FF8A7A]/40 bg-[#FF8A7A]/[0.07] px-3 py-2 text-sm text-ink">
                <b>Umastret:</b> {drafts.map((d) => d.manifest.title).join(', ')}. Send til LANDR-mastering først, eller utgi likevel.
                <div className="mt-2 flex flex-wrap gap-2">
                  {drafts.map((d) => (
                    <button key={d.manifest.id} type="button" onClick={() => void sendToLandr(d)} className="h-11 rounded-full bg-white/[0.06] px-3 text-[13px] lg:h-9">
                      Send «{d.manifest.title}» til mastering
                    </button>
                  ))}
                  <button type="button" onClick={() => void prepare(true)} className="h-11 rounded-full border border-[#FF8A7A]/60 px-3 text-[13px] text-[#FFB4A8] lg:h-9">
                    Utgi likevel
                  </button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void prepare(false)} className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50">
                {busy ? 'Lager pakken …' : 'Forbered utgivelse'}
              </button>
              <button type="button" onClick={close} className="h-11 rounded-full px-4 text-sm text-muted">
                Avbryt
              </button>
            </div>
          </div>
        )}
        {res && (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-sm text-ink-strong">
              Ferdig: <span className="font-mono text-[12px]">{res.relDir}</span>
            </p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" aria-label="Sjekkliste">
              {res.checklist.map((c, i) => (
                <li key={i} className={c.ok ? 'text-soft' : 'text-ink'}>
                  {c.ok ? '✓' : '○'} {c.item}
                  {c.note ? <span className="text-muted"> – {c.note}</span> : null}
                </li>
              ))}
            </ul>
            <section aria-label="Felter til LANDR" className="flex flex-col gap-1">
              <h3 className="gv-label m-0 text-[11px] text-soft">Til LANDR-skjemaet (i samme rekkefølge)</h3>
              {res.fields.map((f, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2 py-1">
                  <span className="w-40 flex-none text-[12px] text-muted">{f.label}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-strong">{f.value || '–'}</span>
                  <button type="button" disabled={!f.value} onClick={() => copy(f.value, f.label)} className="h-11 rounded-full px-3 text-[12px] font-semibold text-accent disabled:opacity-30 lg:h-8">
                    Kopier
                  </button>
                </div>
              ))}
            </section>
            <div className="flex flex-wrap items-center gap-2">
              <a href="https://www.landr.com/" target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-on-accent no-underline">
                Åpne LANDR ↗
              </a>
              <button type="button" onClick={() => void mark('sent')} className="h-11 rounded-full bg-white/[0.06] px-4 text-sm text-ink">
                Sendt til LANDR
              </button>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Utgivelsesdato" className={field} />
              <button type="button" onClick={() => void mark('planned')} className="h-11 rounded-full bg-white/[0.06] px-4 text-sm text-ink">
                Planlagt
              </button>
              <button type="button" onClick={() => void mark('out')} className="h-11 rounded-full bg-white/[0.06] px-4 text-sm text-ink">
                Ute
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
