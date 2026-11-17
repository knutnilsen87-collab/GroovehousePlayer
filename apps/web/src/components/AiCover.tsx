import { useDialog } from '../lib/dialog';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useToast } from '../lib/playlists';

/**
 * Del 23 nivå 2: AI-cover via bulkIMG / AURORA Asset Studio. Vault lager prompten automatisk (tittel,
 * stemning, sangtekst og stilmal), Knut kan redigere den, og Vault skriver en CSV til bulkIMGs innboks.
 * Knut kjører batchen i bulkIMG, velger vinneren og eksporterer; Vault henter coveret selv.
 * Kostnaden avgjøres i bulkIMG (leverandør og antall varianter velges der).
 */

export interface AiCoverStatus {
  inbox: string;
  exports: string;
  exportsFound: boolean;
  sent: number;
  received: number;
  waiting: Array<{ slug: string; title: string; sentAt: string; overdue: boolean }>;
  overdue: boolean;
}
interface PreviewItem {
  slug: string;
  variant: string | null;
  title: string;
  prompt: string;
}

export const useAiCover = create<{ req: { slugs?: string[]; all?: boolean } | null; open: (r: { slugs?: string[]; all?: boolean }) => void; close: () => void }>((set) => ({
  req: null,
  open: (req) => set({ req }),
  close: () => set({ req: null })
}));

const json = { 'Content-Type': 'application/json' };
async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** Status for bulkIMG (hentes hvert 30. sekund). */
export function useAiCoverStatus(): [AiCoverStatus | null, () => void] {
  const [s, setS] = useState<AiCoverStatus | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const r = await fetch('/api/ai-covers', { cache: 'no-store' }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => null)) as AiCoverStatus | null) : null;
      if (!stop) setS(j);
    };
    void tick();
    const t = setInterval(tick, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [n]);
  return [s, () => setN((x) => x + 1)];
}

/** «3 sendt til bulkIMG, 1 mottatt» + varsel etter 24 timer + «Lag for alle uten cover». */
export function AiCoverCard() {
  const [s, refresh] = useAiCoverStatus();
  const open = useAiCover((st) => st.open);
  const req = useAiCover((st) => st.req);
  useEffect(() => {
    if (!req) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);
  if (!s) return null;
  const waiting = s.waiting.length;
  return (
    <div role="status" aria-label="AI-cover" className="gv-panel flex min-h-32 flex-col gap-2 p-4">
      <span className="gv-label">AI-cover · bulkIMG</span>
      <span className="text-sm text-ink-strong">
        {s.sent} sendt til bulkIMG, {s.received} mottatt
      </span>
      {waiting > 0 && <span className="font-mono text-[13px] text-soft">Venter på {waiting}: {s.waiting.slice(0, 3).map((w) => w.title).join(', ')}{waiting > 3 ? ' …' : ''}</span>}
      {s.overdue && <span className="rounded-lg bg-accent-2/[0.16] px-2.5 py-1.5 text-[13px] text-ink-strong">Sendt for over 24 timer siden, og ingenting er kommet tilbake. Kjør batchen i bulkIMG og eksporter vinnerne.</span>}
      {!s.exportsFound && <span className="text-[13px] text-soft">Fant ikke eksportmappa ({s.exports}). Sjekk Innstillinger → Cover.</span>}
      <div className="mt-1 flex flex-wrap gap-2">
        <button type="button" onClick={() => open({ all: true })} className="h-9 rounded-full bg-accent/[0.16] px-4 text-[13px] font-semibold text-accent hover:bg-accent/25">
          Lag for alle uten cover …
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              const r = await post<{ received: number }>('/api/ai-covers/check', {});
              useToast.getState().show(r.received ? `${r.received} nye cover fra bulkIMG` : 'Ingen nye eksporter fra bulkIMG');
              refresh();
            } catch (err) {
              useToast.getState().show(err instanceof Error ? err.message : String(err));
            }
          }}
          className="h-9 rounded-full bg-white/[0.06] px-4 text-[13px] text-soft hover:text-ink-strong"
        >
          Sjekk eksporter nå
        </button>
      </div>
    </div>
  );
}

/** Ark: antall låter, kostnad (avgjøres i bulkIMG), stilmal og redigerbar prompt. Sender først etter OK. */
export function AiCoverDialog() {
  const { req, close } = useAiCover();
  const dialogRef = useDialog<HTMLDivElement>(close, { active: !!req });
  const [items, setItems] = useState<PreviewItem[] | null>(null);
  const [styles, setStyles] = useState<Array<{ id: string; name: string }>>([]);
  const [style, setStyle] = useState('echo-groove-nights');
  const [inbox, setInbox] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  useEffect(() => {
    if (!req) return;
    setItems(null);
    setErr(null);
    void post<{ items: PreviewItem[]; styles: Array<{ id: string; name: string }>; inbox: string }>('/api/ai-covers/preview', { ...req, style })
      .then((r) => {
        setItems(r.items);
        setStyles(r.styles);
        setInbox(r.inbox);
        setOpenIdx(r.items.length === 1 ? 0 : null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [req, style]);
  if (!req) return null;
  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Lag AI-cover" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none" onClick={close}>
      <div className="gv-panel gv-glass flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 overflow-hidden bg-sunken/90 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="gv-display m-0 text-[22px] font-semibold text-ink-strong">Lag AI-cover</h2>
        {err && <p className="m-0 text-sm text-ink-strong">{err}</p>}
        {!items && !err && <p className="m-0 text-sm text-soft">Bygger prompter …</p>}
        {items && (
          <>
            <p className="m-0 text-sm text-soft">
              <strong className="text-ink-strong">{items.length} {items.length === 1 ? 'låt' : 'låter'}</strong> sendes som én CSV til bulkIMG. Kostnaden avgjøres i bulkIMG: den avhenger av hvilke
              generatorer og hvor mange varianter du velger der. Bildet lages uten tekst; Vault legger ikke inn noe før du har eksportert vinneren.
            </p>
            <label className="flex items-center gap-2 text-[13px] text-soft">
              Stilmal
              <select value={style} onChange={(e) => setStyle(e.target.value)} className="h-9 rounded-lg border border-white/10 bg-sunken px-2 text-ink">
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <ul className="gv-scroll m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
              {items.map((it, i) => (
                <li key={`${it.slug}-${it.variant}`} className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <button type="button" onClick={() => setOpenIdx(openIdx === i ? null : i)} className="flex w-full items-center justify-between gap-2 text-left text-sm text-ink-strong">
                    <span className="truncate">{it.title}{it.variant ? ` · ${it.variant}` : ''}</span>
                    <span className="flex-none text-[11px] text-muted">{openIdx === i ? 'Skjul prompt' : 'Rediger prompt'}</span>
                  </button>
                  {openIdx === i && (
                    <textarea
                      value={it.prompt}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))}
                      rows={6}
                      className="mt-2 w-full rounded-lg border border-white/10 bg-sunken p-2 font-mono text-[12px] text-ink"
                      aria-label={`Prompt for ${it.title}`}
                    />
                  )}
                </li>
              ))}
            </ul>
            <p className="m-0 font-mono text-[11px] text-muted">CSV til: {inbox}</p>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className="h-10 rounded-full bg-white/[0.06] px-4 text-sm text-soft">
            Avbryt
          </button>
          <button
            type="button"
            disabled={!items?.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<{ csv: string; count: number }>('/api/ai-covers/send', { items });
                useToast.getState().show(`${r.count} sendt til bulkIMG`);
                close();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
            className="h-10 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-40"
          >
            {busy ? 'Sender …' : `Send ${items?.length ?? ''} til bulkIMG`}
          </button>
        </div>
      </div>
    </div>
  );
}
