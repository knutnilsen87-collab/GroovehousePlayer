import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../lib/playlists';

/**
 * «Hoppet over – finnes allerede»: filer i de overvåkede mappene som ligner en låt i Vault (samme slug,
 * samme tittel eller lik lyd). Ingenting importeres dobbelt uten at Knut velger det her.
 */
interface SkippedItem {
  id: string;
  file: string;
  fileName: string;
  status: 'release' | 'draft' | 'released';
  matchSlug: string;
  matchVariant: string | null;
  matchTitle: string;
  reason: 'samme-slug' | 'samme-tittel' | 'lik-lyd';
  similarity: number | null;
  at: string;
}
const REASON: Record<SkippedItem['reason'], string> = { 'samme-slug': 'samme filnavn/slug', 'samme-tittel': 'samme tittel', 'lik-lyd': 'lik lyd' };

export function SkippedImportsCard({ onImported }: { onImported?: () => void }) {
  const [items, setItems] = useState<SkippedItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch('/api/import-skipped', { cache: 'no-store' }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { items: SkippedItem[] } | null) : null;
    setItems(j?.items ?? null);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);
  if (!items?.length) return null;
  const act = async (it: SkippedItem, choice: 'version' | 'separate' | 'dismiss') => {
    setBusy(it.id);
    try {
      const r = await fetch(`/api/import-skipped/${it.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      useToast.getState().show(choice === 'dismiss' ? `Fjernet fra lista: ${it.fileName}` : choice === 'version' ? (it.status === 'released' ? `Koblet til «${it.matchTitle}» som Utgitt master` : `Importert som ny versjon av «${it.matchTitle}»`) : `Importert som egen låt: ${it.fileName}`);
      if (choice !== 'dismiss') onImported?.();
    } catch (err) {
      useToast.getState().show(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void load();
    }
  };
  // Del 25: usikre treff fra mappa for utgitte låter står for seg, med egne valg (ingenting kobles uten OK)
  const released = items.filter((it) => it.status === 'released');
  const others = items.filter((it) => it.status !== 'released');
  const row = (it: SkippedItem, labels: [string, string, string]) => (
    <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-white/[0.03] px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-strong" title={it.file}>
          {it.fileName}
        </span>
        <span className="block truncate text-[13px] text-soft">
          ligner «{it.matchTitle}»{it.matchVariant ? ` (${it.matchVariant})` : ''} · {REASON[it.reason]}
          {it.similarity != null ? ` ${Math.round(it.similarity * 100)} %` : ''} · {it.status === 'draft' ? 'umastret' : it.status === 'released' ? 'utgitt' : 'release-klar'}
        </span>
      </span>
      <span className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy === it.id} onClick={() => act(it, 'version')} className="h-11 rounded-full bg-accent/[0.16] px-3.5 text-[13px] font-semibold text-accent hover:bg-accent/25 disabled:opacity-40 lg:h-9">
          {labels[0]}
        </button>
        <button type="button" disabled={busy === it.id} onClick={() => act(it, 'separate')} className="h-11 rounded-full bg-white/[0.06] px-3.5 text-[13px] text-ink hover:bg-white/[0.1] disabled:opacity-40 lg:h-9">
          {labels[1]}
        </button>
        <button type="button" disabled={busy === it.id} onClick={() => act(it, 'dismiss')} className="h-11 rounded-full px-3 text-[13px] text-muted hover:text-ink-strong disabled:opacity-40 lg:h-9" title="Fjern fra lista (fila importeres ikke)">
          {labels[2]}
        </button>
      </span>
    </li>
  );
  return (
    <>
      {released.length > 0 && (
        <section aria-label="Utgitte låter – bekreft" className="gv-panel col-span-full flex flex-col gap-2 p-4">
          <span className="gv-label">Utgitte låter – bekreft ({released.length})</span>
          <p className="m-0 text-[13px] text-soft">Vault er ikke sikker på at disse er samme låt. Bekreft for å koble fila som «Utgitt master», eller avvis.</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{released.map((it) => row(it, ['Bekreft: samme låt', 'Ny utgitt låt', 'Avvis']))}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-label="Hoppet over – finnes allerede" className="gv-panel col-span-full flex flex-col gap-2 p-4">
          <span className="gv-label">Hoppet over – finnes allerede ({others.length})</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{others.map((it) => row(it, ['Importer som ny versjon', 'Importer som egen låt', 'Ignorer']))}</ul>
        </section>
      )}
    </>
  );
}