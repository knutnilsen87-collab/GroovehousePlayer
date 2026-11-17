import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { EMPTY_RELEASE, parseReleaseLink, RELEASE_PLATFORMS, type ReleaseInfo as Info, type ReleasePlatform } from '@gv/shared/web';
import { toastError, useToast } from '../lib/playlists';

/**
 * Del 25 pkt. 5–6: utgivelsesinfo under Kreditering. Lagres på PC-en (data/releases.json).
 * «Lim inn lenke»: tjenesten gjenkjennes fra adressen og lenken legges på riktig plass (ingen oppslag på nett).
 */
interface Store {
  releases: Record<string, Info> | null;
  load: () => Promise<void>;
  save: (slug: string, info: Info) => Promise<void>;
}
export const useReleases = create<Store>((set, get) => ({
  releases: null,
  load: async () => {
    if (get().releases) return;
    const r = await fetch('/api/releases', { cache: 'no-store' }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { releases?: Record<string, Info> } | null) : null;
    set({ releases: j?.releases ?? {} });
  },
  save: async (slug, info) => {
    const r = await fetch(`/api/releases/${encodeURIComponent(slug)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) });
    const j = (await r.json().catch(() => ({}))) as { release?: Info | null; error?: string };
    if (!r.ok) throw new Error(j.error ?? `Feil ${r.status}`);
    const next = { ...(get().releases ?? {}) };
    if (j.release) next[slug] = j.release;
    else delete next[slug];
    set({ releases: next });
  }
}));

const TYPE: Record<string, string> = { single: 'Singel', ep: 'EP', album: 'Album' };
const field = 'h-11 w-full rounded-lg border border-white/10 bg-sunken px-3 text-[13px] text-ink-strong focus:border-accent/60 focus:outline-none lg:h-9';

export function ReleaseCredits({ slug, released }: { slug: string; released: boolean }) {
  const releases = useReleases((s) => s.releases);
  useEffect(() => void useReleases.getState().load(), []);
  const info = releases?.[slug];
  const [edit, setEdit] = useState(false);
  if (!releases) return null;
  if (edit) return <ReleaseForm slug={slug} initial={info ?? EMPTY_RELEASE} onDone={() => setEdit(false)} />;
  const links = RELEASE_PLATFORMS.filter(([p]) => info?.links[p]);
  const facts: Array<[string, string]> = [
    ['Utgivelse', [info?.releaseTitle, info?.releaseType ? TYPE[info.releaseType] : null].filter(Boolean).join(' · ')],
    ['Utgitt', info?.date ? new Date(`${info.date}T12:00:00`).toLocaleDateString('nb-NO', { dateStyle: 'medium' }) : ''],
    ['Distributør', info?.distributor ?? ''],
    ['ISRC', info?.isrc ?? ''],
    ['UPC', info?.upc ?? '']
  ].filter(([, v]) => v) as Array<[string, string]>;
  return (
    <section aria-label="Utgivelse" className="mt-3 flex flex-col gap-2 border-t border-white/[0.06] pt-3">
      {facts.length > 0 && (
        <dl className="m-0 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className={`m-0 break-words text-ink-strong ${k === 'ISRC' || k === 'UPC' ? 'font-mono' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {links.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Lytt på">
          {links.map(([p, name]) => (
            <li key={p}>
              <a href={info!.links[p]} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center rounded-full bg-white/[0.06] px-3.5 text-[13px] font-semibold text-ink-strong no-underline hover:bg-accent/[0.14] lg:h-9">
                {name} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => setEdit(true)} className="w-fit text-left text-[13px] font-semibold text-accent hover:underline">
        {info ? 'Endre utgivelsesinfo' : released ? 'Legg til utgivelsesinfo og lenker' : 'Legg til utgivelsesinfo'}
      </button>
    </section>
  );
}

function ReleaseForm({ slug, initial, onDone }: { slug: string; initial: Info; onDone: () => void }) {
  const [v, setV] = useState<Info>({ ...initial, links: { ...initial.links } });
  const [paste, setPaste] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setLink = (p: ReleasePlatform, url: string) => setV((x) => ({ ...x, links: { ...x.links, [p]: url } }));
  const onPaste = (text: string) => {
    setPaste(text);
    const r = parseReleaseLink(text);
    if (!r) {
      setHint(text.trim() ? 'Kjenner ikke igjen lenken (Spotify, Apple Music, YouTube, Tidal eller Beatport).' : null);
      return;
    }
    setLink(r.platform, r.url);
    if (r.kind && !v.releaseType) setV((x) => ({ ...x, releaseType: x.releaseType ?? (r.kind === 'track' ? 'single' : x.releaseType) }));
    setHint(`Lagt inn som ${RELEASE_PLATFORMS.find(([p]) => p === r.platform)![1]}-lenke${r.kind ? ` (${r.kind === 'track' ? 'låt' : r.kind === 'album' ? 'album' : 'video'})` : ''}. Tittel og dato fylles ut her – Vault slår ikke opp på nettet.`);
    setPaste('');
  };
  const save = async () => {
    setBusy(true);
    try {
      await useReleases.getState().save(slug, v);
      useToast.getState().show('Utgivelsesinfo lagret');
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const text = (k: 'releaseTitle' | 'distributor' | 'isrc' | 'upc', label: string, ph: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-muted">
      {label}
      <input value={v[k] ?? ''} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value || null }))} placeholder={ph} className={field} />
    </label>
  );
  return (
    <form
      aria-label="Utgivelsesinfo"
      className="mt-3 flex flex-col gap-2.5 border-t border-white/[0.06] pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        Lim inn lenke (Spotify, Apple Music, YouTube, Tidal, Beatport)
        <input value={paste} onChange={(e) => onPaste(e.target.value)} inputMode="url" placeholder="https://open.spotify.com/track/…" className={field} />
      </label>
      {hint && (
        <p role="status" className="m-0 text-[12px] text-soft">
          {hint}
        </p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {text('releaseTitle', 'Utgivelse (tittel)', 'f.eks. Blue Fire')}
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Type
          <select value={v.releaseType ?? ''} onChange={(e) => setV((x) => ({ ...x, releaseType: (e.target.value || null) as Info['releaseType'] }))} className={field}>
            <option value="">–</option>
            <option value="single">Singel</option>
            <option value="ep">EP</option>
            <option value="album">Album</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Utgivelsesdato
          <input type="date" value={v.date ?? ''} onChange={(e) => setV((x) => ({ ...x, date: e.target.value || null }))} className={field} />
        </label>
        {text('distributor', 'Distributør', 'LANDR')}
        {text('isrc', 'ISRC', 'NO-XXX-26-00001')}
        {text('upc', 'UPC/EAN', '12 eller 13 sifre')}
      </div>
      {RELEASE_PLATFORMS.map(([p, name]) => (
        <label key={p} className="flex flex-col gap-1 text-[12px] text-muted">
          {name}
          <input value={v.links[p] ?? ''} onChange={(e) => setLink(p, e.target.value)} inputMode="url" className={field} />
        </label>
      ))}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50 lg:h-9">
          Lagre
        </button>
        <button type="button" onClick={onDone} className="h-11 rounded-full px-4 text-sm text-muted hover:text-ink lg:h-9">
          Avbryt
        </button>
      </div>
    </form>
  );
}
