import { useCallback, useEffect, useMemo, useState } from 'react';
import { isDraft, isReleased, parseReleaseLink, RELEASE_PLATFORMS, type ReleaseInfo } from '@gv/shared/web';
import type { LoadedAsset } from '../lib/catalog';
import { toastError, useToast } from '../lib/playlists';
import { STATUS_NAMES, sendToLandr, setStatus, useReleaseUi, type ReleaseStatus } from './ReleaseSheet';

/**
 * Del 24 pkt. 4–5 og del 25 pkt. 4: utgivelsene i Studio.
 *  - Kalender: planlagte (etter dato) og utgitte låter, og det som er på vei (til mastering, forberedt, sendt).
 *  - Status settes med ett trykk. «Ute» merker versjonen som Utgitt.
 *  - «Legg til utgitt låt uten lyd»: metadata og lenker for låter som ikke finnes i Vault («Mangler lyd»).
 */
interface StatusEntry {
  status: ReleaseStatus;
  date?: string;
  relDir?: string;
  at: string;
}

export function Releases({ assets }: { assets: LoadedAsset[] }) {
  const [status, setStatusMap] = useState<Record<string, StatusEntry>>({});
  const [releases, setReleases] = useState<Record<string, ReleaseInfo>>({});
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([fetch('/api/release-status', { cache: 'no-store' }).then((x) => x.json()), fetch('/api/releases', { cache: 'no-store' }).then((x) => x.json())]);
    setStatusMap((s as { items: Record<string, StatusEntry> }).items ?? {});
    setReleases((r as { releases: Record<string, ReleaseInfo> }).releases ?? {});
  }, []);
  useEffect(() => void load().catch(() => {}), [load]);
  const bySlug = useMemo(() => new Map(assets.filter((a) => a.manifest.kind !== 'set').map((a) => [a.manifest.slug, a])), [assets]);
  const rows = useMemo(() => {
    const slugs = new Set([...Object.keys(status), ...[...bySlug.values()].filter((a) => isReleased(a.manifest)).map((a) => a.manifest.slug)]);
    return [...slugs]
      .map((slug) => {
        const a = bySlug.get(slug);
        const st: ReleaseStatus = status[slug]?.status ?? (a && isReleased(a.manifest) ? 'out' : 'none');
        const date = status[slug]?.date ?? releases[slug]?.date ?? null;
        return { slug, a, st, date, title: a?.manifest.title ?? slug };
      })
      .filter((r) => r.a)
      .sort((x, y) => (x.date ?? '9999').localeCompare(y.date ?? '9999') || x.title.localeCompare(y.title));
  }, [status, releases, bySlug]);
  const noAudio = Object.entries(releases).filter(([, r]) => r.noAudio);
  const order: ReleaseStatus[] = ['planned', 'sent', 'prepared', 'mastering', 'out'];
  const one = async (a: LoadedAsset, s: ReleaseStatus) => {
    try {
      await setStatus(a, s, s === 'planned' || s === 'out' ? (status[a.manifest.slug]?.date ?? undefined) : undefined);
      await load();
    } catch (err) {
      toastError(err);
    }
  };
  const drafts = [...bySlug.values()].filter((a) => isDraft(a.manifest) && !status[a.manifest.slug]).slice(0, 8);
  return (
    <div className="flex max-w-[960px] flex-col gap-5">
      <h1 className="m-0 font-display text-[34px] font-semibold uppercase tracking-[1.5px] text-ink-strong">Utgivelser</h1>
      <p className="m-0 text-sm text-soft">LANDR har ingen åpen API for distribusjon. Vault lager pakken og holder oversikten; du sender inn på landr.com.</p>
      {order.map((st) => {
        const list = rows.filter((r) => r.st === st);
        if (!list.length) return null;
        return (
          <section key={st} aria-label={STATUS_NAMES[st]} className="flex flex-col gap-1.5">
            <h2 className="gv-label m-0 text-[11px] text-soft">
              {STATUS_NAMES[st]} ({list.length})
            </h2>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {list.map((r) => (
                <li key={r.slug} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-strong">{r.title}</span>
                  <span className="font-mono text-[12px] text-soft">{r.date ? new Date(`${r.date}T12:00:00`).toLocaleDateString('nb-NO', { dateStyle: 'medium' }) : 'ingen dato'}</span>
                  <select value={r.st} onChange={(e) => void one(r.a!, e.target.value as ReleaseStatus)} aria-label={`Status for ${r.title}`} className="h-11 rounded-lg border border-white/10 bg-sunken px-2 text-[13px] text-ink lg:h-8">
                    {(Object.keys(STATUS_NAMES) as ReleaseStatus[]).map((k) => (
                      <option key={k} value={k}>
                        {STATUS_NAMES[k]}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => useReleaseUi.getState().open([r.a!])} className="h-11 rounded-full bg-white/[0.06] px-3 text-[13px] text-ink lg:h-8">
                    Pakke …
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {rows.length === 0 && <p className="m-0 text-sm text-muted">Ingen utgivelser ennå. Velg «Forbered utgivelse …» i ⋯-menyen på en låt.</p>}
      {drafts.length > 0 && (
        <section aria-label="Klare for mastering" className="flex flex-col gap-1.5">
          <h2 className="gv-label m-0 text-[11px] text-soft">Umastrede – send til LANDR-mastering</h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {drafts.map((a) => (
              <li key={a.manifest.id} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink-strong">{a.manifest.title}</span>
                <button type="button" onClick={() => void sendToLandr(a).then(load)} className="h-11 rounded-full bg-white/[0.06] px-3 text-[13px] text-ink lg:h-8">
                  Send til LANDR-mastering
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <NoAudio list={noAudio} onSaved={load} />
    </div>
  );
}

/** Del 25 pkt. 4: utgitte låter som ikke finnes i Vault (metadata og lenker, kan ikke spilles). */
function NoAudio({ list, onSaved }: { list: Array<[string, ReleaseInfo]>; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [link, setLink] = useState('');
  const [date, setDate] = useState('');
  const save = async () => {
    const t = title.trim();
    if (!t) return;
    const slug = `uten-lyd-${t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'lat'}`;
    const p = link.trim() ? parseReleaseLink(link) : null;
    if (link.trim() && !p) return useToast.getState().show('Kjenner ikke igjen lenken');
    const r = await fetch(`/api/releases/${slug}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ noAudio: true, title: t, date: date || null, links: p ? { [p.platform]: p.url } : {} }) });
    if (!r.ok) return toastError(new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Feil ${r.status}`));
    setTitle('');
    setLink('');
    setDate('');
    useToast.getState().show(`Lagt til: ${t} (mangler lyd)`);
    onSaved();
  };
  return (
    <section aria-label="Utgitt uten lyd" className="flex flex-col gap-2">
      <h2 className="gv-label m-0 text-[11px] text-soft">Utgitt, men mangler lyd i Vault</h2>
      {list.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {list.map(([slug, r]) => (
            <li key={slug} className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink-strong">{r.title ?? slug}</span>
              <span className="rounded border border-dashed border-white/40 px-1 font-mono text-[11px] text-soft">MANGLER LYD</span>
              {r.date && <span className="font-mono text-[12px] text-soft">{r.date}</span>}
              {RELEASE_PLATFORMS.filter(([p]) => r.links[p]).map(([p, name]) => (
                <a key={p} href={r.links[p]} target="_blank" rel="noopener noreferrer" className="text-[13px] font-semibold text-accent no-underline hover:underline">
                  {name} ↗
                </a>
              ))}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Tittel
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="h-11 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink lg:h-9" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Lenke (Spotify, Apple …)
          <input value={link} onChange={(e) => setLink(e.target.value)} inputMode="url" className="h-11 w-64 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink lg:h-9" />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          Utgitt
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink lg:h-9" />
        </label>
        <button type="submit" className="h-11 rounded-full bg-white/[0.06] px-4 text-sm text-ink lg:h-9">
          Legg til utgitt låt uten lyd
        </button>
      </form>
    </section>
  );
}
