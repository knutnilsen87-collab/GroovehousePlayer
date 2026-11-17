import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  ALBUM_CHARACTER_NAMES,
  ALBUM_FORMATS,
  albumReplacements,
  arcAt,
  buildAlbumAlternatives,
  formatTime,
  hookMs,
  lowConfidence,
  rescoreAlbum,
  toSbTracks,
  type AlbumFormat,
  type AlbumOptions,
  type AlbumResult,
  type AlbumTrack
} from '@gv/shared/web';
import { assetUrl, dupeGroups, type LoadedAsset } from '../lib/catalog';
import { fetchListens, useFavorites } from '../lib/library';
import { usePlayer } from '../lib/player';
import { toastError, usePlaylists, useToast } from '../lib/playlists';
import { CoverArt } from './CoverArt';
import { Panel } from './Deck';

/**
 * Del 26: albumbygger. Velg format og pool, få tre forslag («Sterkest først», «Beste bue», «Mest sammenheng»),
 * lås, flytt, bytt ut, forhåndslytt (20 s rundt hooken per låt) og lagre det du velger som Album-plan.
 * Ingenting lagres automatisk. Release-pakken (del 24) kommer senere.
 */

/** Åpnes fra «⋯» på en Album-plan i spilleren (som et ark) eller fra Studio → Album. */
export const useAlbumUi = create<{ open: { planId: string | null } | null; show: (o: { planId: string | null }) => void; close: () => void }>((set) => ({
  open: null,
  show: (o) => set({ open: o }),
  close: () => set({ open: null })
}));

type Flags = { exclude: string[]; singles: string[] };
async function saveFlags(f: Partial<Flags>): Promise<Flags> {
  const r = await fetch('/api/album', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
  if (!r.ok) throw new Error(`Lagring feilet (${r.status})`);
  return (await r.json()) as Flags;
}

export function AlbumBuilderSheet({ assets }: { assets: LoadedAsset[] }) {
  const open = useAlbumUi((s) => s.open);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Bygg album" className="fixed inset-0 z-[70] overflow-y-auto bg-obsidian px-4 pb-28 pt-4 lg:px-8">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="gv-display m-0 text-[28px] font-semibold text-ink-strong">Bygg album</h1>
          <button type="button" onClick={() => useAlbumUi.getState().close()} className="h-11 rounded-full bg-white/[0.06] px-4 text-sm text-ink">
            Lukk
          </button>
        </div>
        <AlbumBuilder assets={assets} planId={open.planId} />
      </div>
    </div>
  );
}

export function AlbumBuilder({ assets, planId = null }: { assets: LoadedAsset[]; planId?: string | null }) {
  const songs = useMemo(() => assets.filter((a) => a.manifest.kind !== 'set' && !a.manifest.hidden), [assets]);
  const byId = useMemo(() => new Map(songs.map((a) => [a.manifest.id, a])), [songs]);
  const favorites = useFavorites((s) => s.slugs);
  const playlists = usePlaylists((s) => s.playlists);
  const albumPlans = playlists.filter((p) => p.plan === 'album');
  const [plays, setPlays] = useState<Record<string, number>>({});
  const [flags, setFlags] = useState<Flags>({ exclude: [], singles: [] });
  useEffect(() => {
    void fetchListens().then((l) => l && setPlays(Object.fromEntries(Object.entries(l.bySlug).map(([k, v]) => [k, v.plays]))));
    void fetch('/api/album', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Flags | null) => j && setFlags(j))
      .catch(() => {});
  }, []);

  const all: AlbumTrack[] = useMemo(() => {
    const sb = toSbTracks(songs, dupeGroups());
    return sb.map((t) => {
      const m = byId.get(t.id)!.manifest;
      return { ...t, favorite: favorites.includes(t.slug), plays: plays[t.slug] ?? 0, singleCandidate: flags.singles.includes(t.slug), titleNeedsReview: !!m.titleNeedsReview, hookMs: hookMs(m) };
    });
  }, [songs, byId, favorites, plays, flags.singles]);

  const [format, setFormat] = useState<AlbumFormat>('album');
  const [count, setCount] = useState(ALBUM_FORMATS.album.dflt);
  const [vinyl, setVinyl] = useState(false);
  const [pool, setPool] = useState<string>(planId ? `plan:${planId}` : 'all');
  const [seedId, setSeedId] = useState('');
  const [includeDrafts, setIncludeDrafts] = useState(true);
  const [showExclude, setShowExclude] = useState(false);
  const [alts, setAlts] = useState<AlbumResult[] | null>(null);
  const [active, setActive] = useState(0);
  const [locked, setLocked] = useState<Set<number>>(new Set());
  const [swapAt, setSwapAt] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [took, setTook] = useState<number | null>(null);
  const [seed, setSeed] = useState(1);

  const poolIds = useMemo(() => {
    if (!pool.startsWith('plan:')) return null;
    const p = playlists.find((x) => x.id === pool.slice(5));
    if (!p) return null;
    const slugs = new Set(p.entries.map((e) => e.slug));
    return all.filter((t) => slugs.has(t.slug)).map((t) => t.id);
  }, [pool, playlists, all]);

  const options = (extra: Partial<AlbumOptions> = {}): AlbumOptions => ({ format, count, vinyl, pool: poolIds, exclude: flags.exclude, includeDrafts, seedId: seedId || null, seed, ...extra });
  const cur = alts?.[active];

  const build = () => {
    const t0 = performance.now();
    const r = buildAlbumAlternatives(all, options());
    setTook(performance.now() - t0);
    setAlts(r);
    setActive(0);
    setLocked(new Set());
    setSwapAt(null);
    setName(`${ALBUM_FORMATS[format].name} ${new Date().toLocaleDateString('nb-NO')}`);
  };
  /** «Bygg på nytt»: låste plasser beholdes. */
  const rebuild = () => {
    if (!cur) return;
    const lockedList = [...locked].map((i) => ({ id: cur.tracks[i]!.id, position: i }));
    const r = buildAlbumAlternatives(all, options({ locked: lockedList, seed: seed + 1, count: cur.tracks.length }));
    setSeed((s) => s + 1);
    if (r[active]) setAlts(alts!.map((a, i) => (i === active ? r[active]! : a)));
  };
  const update = (tracks: AlbumTrack[]) => setAlts(alts!.map((a, i) => (i === active ? rescoreAlbum(tracks, all, options(), a.character) : a)));
  const move = (i: number, d: -1 | 1) => {
    if (!cur) return;
    const j = i + d;
    if (j < 0 || j >= cur.tracks.length || locked.has(i) || locked.has(j)) return;
    const t = [...cur.tracks];
    [t[i], t[j]] = [t[j]!, t[i]!];
    update(t);
  };
  const toggleSingle = async (slug: string) => {
    try {
      setFlags(await saveFlags({ singles: flags.singles.includes(slug) ? flags.singles.filter((s) => s !== slug) : [...flags.singles, slug] }));
    } catch (err) {
      toastError(err);
    }
  };
  const toggleExclude = async (slug: string) => {
    try {
      setFlags(await saveFlags({ exclude: flags.exclude.includes(slug) ? flags.exclude.filter((s) => s !== slug) : [...flags.exclude, slug] }));
    } catch (err) {
      toastError(err);
    }
  };

  // ---- Forhåndslytting: 20 s rundt hooken per låt
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const stopPreview = () => {
    window.clearTimeout(timer.current);
    setPreviewAt(null);
    if (usePlayer.getState().playing) usePlayer.getState().toggle();
  };
  const playSnippet = (tracks: AlbumTrack[], i: number) => {
    const t = tracks[i];
    const a = t && byId.get(t.id);
    if (!t || !a) return stopPreview();
    usePlayer.getState().playFrom([a], 0, t.hookMs);
    setPreviewAt(i);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => playSnippet(tracks, i + 1), 20_000);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = async () => {
    if (!cur) return;
    try {
      const st = usePlaylists.getState();
      const created = await st.create(
        name || `${ALBUM_FORMATS[format].name}`,
        cur.tracks.map((t) => ({ slug: t.slug, variant: t.variant, version: t.draft ? (byId.get(t.id)?.manifest.version ?? null) : null }))
      );
      const p = await st.setPlan(created.id, 'album');
      const mastered = cur.tracks.filter((t) => !t.draft).length;
      useToast.getState().show(`Lagret som Album-plan: «${p.name}» – ${mastered} av ${cur.tracks.length} mastret`);
    } catch (err) {
      toastError(err);
    }
  };

  const fmt = ALBUM_FORMATS[format];
  const seg = 'h-11 rounded-full px-4 text-sm lg:h-9';
  const on = (b: boolean) => (b ? 'bg-accent text-on-accent font-semibold' : 'bg-white/[0.05] text-soft hover:text-ink');
  const sorted = useMemo(() => [...all].sort((a, b) => a.title.localeCompare(b.title, 'nb')), [all]);
  const [filter, setFilter] = useState('');

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Album">
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Format" className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted">Format</span>
            {(Object.keys(ALBUM_FORMATS) as AlbumFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={format === f}
                onClick={() => {
                  setFormat(f);
                  setCount(ALBUM_FORMATS[f].dflt);
                }}
                className={`${seg} ${on(format === f)}`}
              >
                {ALBUM_FORMATS[f].name}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted">Antall låter</span>
            <input type="number" min={fmt.min} max={fmt.max} value={count} onChange={(e) => setCount(Math.max(fmt.min, Math.min(fmt.max, Number(e.target.value) || fmt.dflt)))} className="h-11 w-20 rounded-lg border border-white/10 bg-sunken px-2 font-mono text-sm text-ink lg:h-9" aria-label="Antall låter" />
            <span className="text-[11px] text-muted">
              {fmt.min}–{fmt.max} låter{fmt.minMs ? `, ca. ${fmt.minMs / 60_000}–${fmt.maxMs / 60_000} min` : ''}
            </span>
            <label className="ml-2 flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={vinyl} onChange={(e) => setVinyl(e.target.checked)} className="h-5 w-5" /> Vinyl (side A/B, maks 22 min per side)
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-xs text-muted">Utvalg fra</span>
            <select value={pool} onChange={(e) => setPool(e.target.value)} className="h-11 max-w-full rounded-lg border border-white/10 bg-sunken px-2 text-sm text-ink lg:h-9" aria-label="Utvalg fra">
              <option value="all">Hele biblioteket</option>
              {albumPlans.map((p) => (
                <option key={p.id} value={`plan:${p.id}`}>
                  Album-plan: {p.name}
                </option>
              ))}
            </select>
            <select value={seedId} onChange={(e) => setSeedId(e.target.value)} className="h-11 max-w-full rounded-lg border border-white/10 bg-sunken px-2 text-sm text-ink lg:h-9" aria-label="Album rundt denne låta">
              <option value="">Ingen frølåt</option>
              {sorted.map((t) => (
                <option key={t.id} value={t.id}>
                  Rundt: {t.title}
                </option>
              ))}
            </select>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} className="h-5 w-5" /> Ta med umastrede
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setShowExclude((x) => !x)} aria-expanded={showExclude} className={`${seg} bg-white/[0.05] text-ink`}>
              Utelat disse låtene ({flags.exclude.length})
            </button>
            <button type="button" onClick={build} className={`${seg} bg-accent font-semibold text-on-accent`}>
              Bygg album
            </button>
            {took != null && <span className="font-mono text-[11px] text-muted">tre forslag på {(took / 1000).toFixed(1)} s</span>}
          </div>
          {showExclude && (
            <div className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-3">
              <p className="m-0 text-[11px] text-muted">Huk av låter som skal holdes utenfor, f.eks. det som allerede er gitt ut. Valget lagres i Vault.</p>
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Søk" className="h-11 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink" aria-label="Søk i låter" />
              <ul className="m-0 flex max-h-72 list-none flex-col overflow-y-auto p-0">
                {sorted
                  .filter((t) => !filter || t.title.toLowerCase().includes(filter.toLowerCase()))
                  .filter((t, i, arr) => arr.findIndex((x) => x.slug === t.slug) === i)
                  .map((t) => (
                    <li key={t.slug}>
                      <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
                        <input type="checkbox" checked={flags.exclude.includes(t.slug)} onChange={() => void toggleExclude(t.slug)} className="h-5 w-5" />
                        {t.title}
                      </label>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      </Panel>

      {alts && alts.length === 0 && <p className="text-sm text-muted">Fant ingen låter i utvalget.</p>}
      {alts && cur && (
        <Panel
          title="Forslag"
          right={
            <span className="font-mono text-[11px] text-muted">
              {cur.tracks.length} låter · {formatTime(cur.totalMs)} · {cur.tracks.filter((t) => !t.draft).length} av {cur.tracks.length} mastret
            </span>
          }
        >
          <div className="flex flex-col gap-3">
            <div role="tablist" aria-label="Forslag" className="flex flex-wrap gap-2">
              {alts.map((a, i) => (
                <button key={a.character} type="button" role="tab" aria-selected={active === i} onClick={() => (setActive(i), setLocked(new Set()), setSwapAt(null))} className={`${seg} ${on(active === i)}`}>
                  {ALBUM_CHARACTER_NAMES[a.character]}
                </button>
              ))}
            </div>
            <EnergyArc tracks={cur.tracks} sideB={cur.sideB} />
            {cur.warnings.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-1 rounded-xl bg-[#F5C84B]/[0.08] p-3 text-[13px] text-ink">
                {cur.warnings.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
            )}
            <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Sporliste">
              {cur.tracks.map((t, i) => {
                const a = byId.get(t.id);
                const check = [t.titleNeedsReview ? 'sjekk tittel' : null, lowConfidence(t) ? 'lav analyse-sikkerhet' : null].filter(Boolean) as string[];
                return (
                  <li key={t.id} className="flex flex-col">
                    {cur.sideB === i && <p className="gv-label m-0 mt-2 text-[11px] text-soft">Side B</p>}
                    {i === 0 && cur.sideB != null && <p className="gv-label m-0 text-[11px] text-soft">Side A</p>}
                    <div className={`flex items-center gap-3 rounded-xl px-2 py-2 ${previewAt === i ? 'gv-row-active' : ''}`}>
                      <span className="w-6 text-right font-mono text-[13px] text-muted">{i + 1}</span>
                      {a && <CoverArt src={assetUrl(a, a.manifest.files.coverThumb)} palette={a.manifest.palette} title={t.title} size={44} rounded={8} draft={t.draft} />}
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink-strong">
                          <span className="truncate">{t.title}</span>
                          {t.draft && <span className="rounded border border-dashed border-white/40 px-1 font-mono text-[11px] text-soft">UMASTRET</span>}
                          {check.map((c) => (
                            <span key={c} title="Bør sjekkes før utgivelse" className="rounded bg-[#F5C84B]/[0.15] px-1.5 text-[11px] font-normal text-[#F5C84B]">
                              {c}
                            </span>
                          ))}
                        </span>
                        <span className="truncate text-[12px] text-muted">
                          {formatTime(t.durationMs)} · {cur.notes[i]}
                        </span>
                      </div>
                      <button type="button" onClick={() => void toggleSingle(t.slug)} aria-pressed={t.singleCandidate} title="Singel-kandidat" aria-label={`Singel-kandidat: ${t.title}`} className={`h-11 w-11 rounded-full text-lg ${t.singleCandidate ? 'text-accent' : 'text-muted'}`}>
                        ★
                      </button>
                      <button type="button" onClick={() => setLocked((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))} aria-pressed={locked.has(i)} aria-label={`Lås plass ${i + 1}`} title="Lås plassen" className={`h-11 w-11 rounded-full ${locked.has(i) ? 'text-accent' : 'text-muted'}`}>
                        {locked.has(i) ? '🔒' : '🔓'}
                      </button>
                      <button type="button" onClick={() => move(i, -1)} aria-label={`Flytt ${t.title} opp`} className="h-11 w-9 rounded-full text-muted hover:text-ink">
                        ↑
                      </button>
                      <button type="button" onClick={() => move(i, 1)} aria-label={`Flytt ${t.title} ned`} className="h-11 w-9 rounded-full text-muted hover:text-ink">
                        ↓
                      </button>
                      <button type="button" onClick={() => setSwapAt(swapAt === i ? null : i)} aria-expanded={swapAt === i} className="h-11 rounded-full px-3 text-xs text-soft hover:text-ink">
                        Bytt ut
                      </button>
                    </div>
                    {swapAt === i && (
                      <ul className="m-0 ml-9 flex list-none flex-col gap-1 p-0" aria-label="Alternativer">
                        {albumReplacements(cur, i, all, options()).map((r) => (
                          <li key={r.id}>
                            <button
                              type="button"
                              onClick={() => {
                                const tr = [...cur.tracks];
                                tr[i] = r;
                                update(tr);
                                setSwapAt(null);
                              }}
                              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-ink hover:bg-white/[0.05]"
                            >
                              {r.title}
                              <span className="font-mono text-[11px] text-muted">
                                {r.camelot ?? '–'} · energi {r.energy.toFixed(1)} · {formatTime(r.durationMs)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {i < cur.tracks.length - 1 && <span className="ml-9 font-mono text-[11px] text-muted">{cur.gapsMs[i] === 0 ? '↧ gapless' : `↧ ${cur.gapsMs[i]! / 1000} s pause`}</span>}
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              {previewAt == null ? (
                <button type="button" onClick={() => playSnippet(cur.tracks, 0)} className={`${seg} bg-white/[0.06] text-ink`}>
                  Forhåndslytt (20 s per låt)
                </button>
              ) : (
                <button type="button" onClick={stopPreview} className={`${seg} bg-white/[0.06] text-ink`}>
                  Stopp forhåndslytting ({previewAt + 1}/{cur.tracks.length})
                </button>
              )}
              <button type="button" onClick={rebuild} className={`${seg} bg-white/[0.06] text-ink`}>
                Bygg på nytt{locked.size ? ` (beholder ${locked.size} låste)` : ''}
              </button>
              <input value={name} onChange={(e) => setName(e.target.value)} className="h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-sunken px-3 text-sm text-ink lg:h-9" aria-label="Navn på Album-planen" />
              <button type="button" onClick={() => void save()} className={`${seg} bg-accent font-semibold text-on-accent`}>
                Lagre som Album-plan
              </button>
            </div>
            <p className="m-0 text-[11px] text-muted">Release-pakke for albumet kommer med del 24.</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

/** Energikurven for albumet mot buen (stiplet). Farger fra skin-variablene. */
function EnergyArc({ tracks, sideB }: { tracks: AlbumTrack[]; sideB: number | null }) {
  const W = 600;
  const H = 90;
  const n = tracks.length;
  if (n < 2) return null;
  const x = (i: number) => 12 + (i * (W - 24)) / (n - 1);
  const y = (e: number) => H - 8 - ((e - 1) / 9) * (H - 16);
  const line = tracks.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t.energy).toFixed(1)}`).join(' ');
  const arc = Array.from({ length: 41 }, (_, k) => `${k ? 'L' : 'M'}${(12 + (k * (W - 24)) / 40).toFixed(1)},${y(arcAt(k / 40)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[90px] w-full" role="img" aria-label="Energikurve: albumet (heltrukket) mot buen (stiplet)">
      <path d={arc} fill="none" stroke="var(--accent-2)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="4 4" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      {tracks.map((t, i) => (
        <circle key={t.id} cx={x(i)} cy={y(t.energy)} r={3.5} fill="var(--accent)" />
      ))}
      {sideB != null && <line x1={(x(sideB - 1) + x(sideB)) / 2} x2={(x(sideB - 1) + x(sideB)) / 2} y1={4} y2={H - 4} stroke="var(--accent-2)" strokeOpacity="0.6" />}
    </svg>
  );
}
