import { useSeedSet } from '../lib/seedset';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { displayLabel, formatTime, isDraft, sectionsOf } from '@gv/shared/web';
import { assetUrl, loadVersion, useFullAsset, variantName, versionsOf, type IndexEntry, type LoadedAsset, type Track } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { toastError, useToast } from '../lib/playlists';
import { isDesktop, useUi, type ActionsRequest } from '../lib/ui';
import { useTouchReorder } from '../lib/useTouchReorder';
import { useDialog } from '../lib/dialog';
import { go } from '../lib/nav';
import { sendToLandr, useReleaseUi } from './ReleaseSheet';
import { CoverArt } from './CoverArt';
import { ChevronDownIcon, GripIcon, TrashIcon } from './Icons';
import { PresetRow } from './FxChip';
import { useAiCover } from './AiCover';
import { isApp } from '../lib/platform';
import { useFx } from '../lib/fx';

type Panel = 'main' | 'variant' | 'version' | 'section' | 'info' | 'fx' | { extra: number };

interface Item {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  sub?: boolean;
  run?: () => void;
}

/**
 * Del 11: ÉN meny for låthandlinger, brukt overalt (låtrader, fullskjerm, minispiller, dokken).
 * Mobil: ark nederfra med treffflater ≥ 48 px. Desktop: kontekstmeny ved pekeren med snarveier til høyre.
 * Gjelder alltid nøyaktig versjonen og varianten som vises eller spilles.
 */
export function TrackActionsHost({ tracks, index, onPlay }: { tracks: Track[]; index: IndexEntry[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void }) {
  const req = useUi((s) => s.actions);
  if (!req || !req.assets.length) return null;
  return <TrackActions key={req.assets.map((a) => a.manifest.id).join('|') + req.context} req={req} tracks={tracks} index={index} onPlay={onPlay} />;
}

function TrackActions({ req, tracks, index, onPlay }: { req: ActionsRequest; tracks: Track[]; index: IndexEntry[]; onPlay: (t: Track, v?: LoadedAsset, atMs?: number) => void }) {
  const close = useUi((s) => s.closeActions);
  const [panel, setPanel] = useState<Panel>('main');
  const desktop = isDesktop();
  // Del 27 pkt. 11: fokus fanges i menyen, Esc går ett nivå opp (eller lukker), og fokus går tilbake til ⋯-knappen
  const box = useDialog<HTMLDivElement>(() => (panel !== 'main' ? setPanel('main') : close()), { autoFocus: desktop });
  // Klikket som kommer etter et langt trykk (minispilleren) skal ikke lukke menyen det nettopp åpnet.
  const openedAt = useRef(Date.now());
  const multi = req.assets.length > 1;
  const a = req.assets[0]!;
  const m = a.manifest;
  const t = tracks.find((x) => x.slug === m.slug);
  const versions = versionsOf(index, m.slug, m.variant);
  const sections = sectionsOf(m.markers);
  const now = req.context === 'now';
  const toast = useToast.getState().show;
  const label = multi ? `${req.assets.length} låter` : m.title;

  // Piltaster flytter mellom valgene (Esc håndteres av useDialog)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled]),[role=menuitemradio]') ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]!.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, close]);
  useEffect(() => {
    if (desktop) box.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled]),[role=menuitemradio]')?.focus();
  }, [panel, desktop]);

  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const mainItems: Item[] = multi
    ? [
        { label: `Legg til i spilleliste (${req.assets.length})`, hint: 'Ctrl+Shift+P', run: () => useUi.getState().openAddSheet({ assets: req.assets, anchor: req.anchor }) },
        { label: `Spill neste (${req.assets.length})`, run: run(() => (usePlayer.getState().insertNext(req.assets), toast(`${req.assets.length} låter spilles neste`))) },
        { label: `Legg til i køen (${req.assets.length})`, run: run(() => (usePlayer.getState().enqueue(req.assets), toast(`${req.assets.length} låter lagt i køen`))) },
        // Del 24: release-pakke for flere låter (EP/album)
        ...(desktop && !isApp ? [{ label: `Forbered utgivelse (${req.assets.length})`, run: run(() => useReleaseUi.getState().open(req.assets)) }] : [])
      ]
    : [
        { label: 'Legg til i spilleliste', hint: 'Ctrl+Shift+P', run: () => useUi.getState().openAddSheet({ assets: [a], anchor: req.anchor }) },
        { label: 'Del…', run: () => useUi.getState().openShare(a) },
        ...(now
          ? [{ label: 'Vis køen', run: () => useUi.getState().setQueueOpen(true) }]
          : [
              { label: 'Spill neste', run: run(() => (usePlayer.getState().insertNext([a]), toast(`Spilles neste: ${m.title}`))) },
              { label: 'Legg til i køen', run: run(() => (usePlayer.getState().enqueue([a]), toast(`Lagt i køen: ${m.title}`))) }
            ]),
        ...(t && t.variants.length > 1 ? [{ label: 'Bytt variant', hint: variantName(a), sub: true, run: () => setPanel('variant') }] : []),
        ...(versions.length > 1 ? [{ label: 'Velg versjon', hint: `v${m.version}`, sub: true, run: () => setPanel('version') }] : []),
        ...(sections.length ? [{ label: 'Gå til seksjon', sub: true, run: () => setPanel('section') }] : []),
        // Del 18: rask idéfangst – ett trykk åpner presetraden, ett trykk til lagrer
        { label: 'Idé for overgang', sub: true, run: () => setPanel('fx') },
        { label: 'Info', sub: true, run: () => setPanel('info') },
        // Del 20 E: frølåt – ett trykk gir et sett med standardvalgene; «Mer som denne» gir en kø
        ...(m.kind !== 'set'
          ? [
              { label: 'Lag sett fra denne', run: run(() => useSeedSet.getState().openSeedSet({ slug: m.slug, variant: m.variant, id: m.id, title: m.title })) },
              { label: 'Mer som denne', run: run(() => useSeedSet.getState().openMoreLike({ slug: m.slug, variant: m.variant, id: m.id, title: m.title })) }
            ]
          : []),
        // Del 24: utgivelse via LANDR (forarbeidet) og mastering
        ...(desktop && !isApp && m.kind !== 'set' ? [{ label: 'Forbered utgivelse …', run: run(() => useReleaseUi.getState().open([a])) }] : []),
        ...(desktop && !isApp && isDraft(m) ? [{ label: 'Send til LANDR-mastering', run: run(() => void sendToLandr(a)) }] : []),
        ...(desktop ? [{ label: 'Åpne i Studio', run: run(() => go(`/studio#arkiv/${encodeURIComponent(m.slug)}`)) }] : []),
        // Del 23: AI-cover via bulkIMG (bare på PC-en, der bulkIMG kjører)
        ...(desktop && !isApp ? [{ label: 'Lag AI-cover …', run: run(() => useAiCover.getState().open({ slugs: [m.slug] })) }] : [])
      ];
  const extras: Item[] = (req.extra ?? []).map((x, i) =>
    'options' in x ? { label: x.label, sub: true, run: () => setPanel({ extra: i }) } : { label: x.label, danger: x.danger, run: run(x.run) }
  );

  let body: ReactNode;
  if (panel === 'main') {
    body = (
      <>
        <ItemList items={mainItems} desktop={desktop} />
        {extras.length > 0 && <div className="my-1" />}
        <ItemList items={extras} desktop={desktop} />
      </>
    );
  } else if (panel === 'variant' && t) {
    body = (
      <Radio
        desktop={desktop}
        options={t.variants.map((v) => ({
          label: `${variantName(v)} · ${formatTime(v.manifest.durationMs)}`,
          checked: v.manifest.variant === m.variant,
          run: run(() => (now ? usePlayer.getState().switchVariant(v) : onPlay(t, v)))
        }))}
      />
    );
  } else if (panel === 'version') {
    body = (
      <Radio
        desktop={desktop}
        options={versions.map((e, i) => ({
          label: `v${e.version}${i === 0 ? ' (nyeste)' : ''}`,
          checked: e.version === m.version,
          run: run(() =>
            void loadVersion(e)
              .then((v) => (now ? usePlayer.getState().switchVariant(v) : t ? onPlay(t, v) : usePlayer.getState().playFrom([v], 0)))
              .catch(toastError)
          )
        }))}
      />
    );
  } else if (panel === 'section') {
    body = (
      <Radio
        desktop={desktop}
        options={sections.map((s) => ({
          label: `${formatTime(s.startMs)}  ${s.label}`,
          checked: false,
          run: run(() => (now && usePlayer.getState().queue[usePlayer.getState().index]?.manifest.id === m.id ? usePlayer.getState().seek(s.startMs) : t ? onPlay(t, a, s.startMs) : usePlayer.getState().playFrom([a], 0, s.startMs)))
        }))}
      />
    );
  } else if (panel === 'info') {
    body = <InfoPanel a={a} />;
  } else if (panel === 'fx') {
    body = (
      <div className="flex flex-col gap-2 p-2">
        <IdeaTarget a={a} />
        <PresetRow onPick={(p) => run(() => void captureIdea(a, p.id))()} />
      </div>
    );
  } else if (typeof panel === 'object') {
    const x = req.extra?.[panel.extra];
    body = x && 'options' in x ? <Radio desktop={desktop} options={x.options.map((o) => ({ ...o, run: run(o.run) }))} /> : null;
  }

  const title = panel === 'main' ? null : panel === 'variant' ? 'Bytt variant' : panel === 'version' ? 'Velg versjon' : panel === 'section' ? 'Gå til seksjon' : panel === 'info' ? 'Info' : panel === 'fx' ? 'Idé for overgang' : (req.extra?.[(panel as { extra: number }).extra]?.label ?? '');
  const pos: CSSProperties | undefined =
    desktop && req.anchor ? { left: Math.max(8, Math.min(req.anchor.x, window.innerWidth - 300)), top: Math.max(8, Math.min(req.anchor.y, window.innerHeight - 420)) } : undefined;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 lg:bg-transparent" onMouseDown={(e) => e.target === e.currentTarget && Date.now() - openedAt.current > 400 && close()} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div
        ref={box}
        role="menu"
        aria-label={`Valg for ${label}`}
        style={pos}
        className={`fixed inset-x-0 bottom-0 max-h-[80svh] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-surface px-2 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 shadow-2xl lg:bottom-auto lg:w-[288px] lg:rounded-xl lg:border lg:bg-[#15181F] lg:p-1.5 ${pos ? 'lg:inset-x-auto' : 'lg:left-1/2 lg:top-[20vh] lg:-translate-x-1/2'}`}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15 lg:hidden" />
        {panel === 'main' ? (
          <div className="flex items-center gap-3 px-3 pb-2 lg:hidden">
            {!multi && <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={44} rounded={6} />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] font-semibold text-ink-strong">{label}</span>
              {!multi && <span className="truncate text-xs text-muted">{[m.variant ? variantName(a) : null, `v${m.version}`, now ? 'spilles nå' : null].filter(Boolean).join(' · ')}</span>}
            </span>
          </div>
        ) : (
          <button type="button" onClick={() => setPanel('main')} className="flex min-h-12 w-full items-center gap-1 rounded-lg px-2 text-left text-sm font-semibold text-ink-strong hover:bg-white/[0.06] lg:min-h-9">
            <ChevronDownIcon width={16} height={16} className="rotate-90 text-muted" />
            {title}
          </button>
        )}
        {body}
      </div>
    </div>,
    document.body
  );
}

function ItemList({ items, desktop }: { items: Item[]; desktop: boolean }) {
  return (
    <>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          aria-haspopup={it.sub ? 'menu' : undefined}
          onClick={it.run}
          className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] focus:bg-white/[0.08] focus:outline-none lg:min-h-9 lg:text-[13px] ${it.disabled ? 'cursor-default text-muted/60' : it.danger ? 'text-[#FF8A7A] hover:bg-white/[0.06]' : 'text-ink-strong hover:bg-white/[0.06]'}`}
        >
          <span className="min-w-0 flex-1 truncate">{it.label}</span>
          {it.hint && <span className={`flex-none text-xs ${it.disabled ? 'italic' : ''} text-muted ${!desktop && it.hint.startsWith('Ctrl') ? 'hidden' : ''}`}>{it.hint}</span>}
          {it.sub && <ChevronDownIcon width={14} height={14} className="-rotate-90 text-muted" />}
        </button>
      ))}
    </>
  );
}

function Radio({ options }: { options: Array<{ label: string; checked: boolean; run: () => void }>; desktop: boolean }) {
  return (
    <>
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          role="menuitemradio"
          aria-checked={o.checked}
          onClick={o.run}
          className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-ink-strong hover:bg-white/[0.06] focus:bg-white/[0.08] focus:outline-none lg:min-h-9 lg:text-[13px]"
        >
          <span aria-hidden="true" className={`h-3.5 w-3.5 flex-none rounded-full border ${o.checked ? 'border-accent bg-accent' : 'border-white/30'}`} />
          <span className="tabular min-w-0 flex-1 truncate">{o.label}</span>
        </button>
      ))}
    </>
  );
}

/** Info: BPM, toneart/Camelot, LUFS, varighet, kildefil (privat, data/sources.json) og ingest-dato. */
function InfoPanel({ a: aIn }: { a: LoadedAsset }) {
  const a = useFullAsset(aIn);
  const m = a.manifest;
  const [source, setSource] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch(`/api/sources/${encodeURIComponent(m.slug)}/${encodeURIComponent(m.variant ?? 'main')}/${m.version}`)
      .then(async (r) => (r.ok ? ((await r.json()) as { fileName: string }).fileName : null))
      .catch(() => null)
      .then((f) => alive && setSource(f));
    return () => {
      alive = false;
    };
  }, [m.slug, m.variant, m.version]);
  const rows: Array<[string, ReactNode]> = [
    ['Tittel', m.title],
    ['Variant', m.variant ? variantName(a) : 'Original'],
    ['Versjon', `v${m.version}${m.versionLabel ? ` · ${displayLabel(m.versionLabel)}` : ''}`],
    ['BPM', m.bpm ?? '–'],
    ['Toneart', m.key ? `${m.key.name} · ${m.key.camelot}` : '–'],
    ['Lydstyrke', `${m.loudness.integratedLufs} LUFS`],
    ['Varighet', formatTime(m.durationMs)],
    ['Kildefil', source === undefined ? '…' : (source ?? 'ukjent')],
    ['Ingestet', new Date(m.createdAt).toLocaleString('nb-NO', { dateStyle: 'medium', timeStyle: 'short' })]
  ];
  return (
    <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 px-3 py-2 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="m-0 break-words text-ink-strong">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- Køen

/** «Vis køen»: dra for å flytte (hold inne på mobil), sveip/Delete for å fjerne. Låta som spilles står fast. */
export function QueuePanel() {
  const open = useUi((s) => s.queueOpen);
  const setOpen = useUi((s) => s.setQueueOpen);
  const { queue, index, playing, playIndex, moveInQueue, removeFromQueue } = usePlayer();
  const listRef = useRef<HTMLOListElement>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const moveTo = (from: number, beforeIdx: number | null) => {
    const target = beforeIdx === null ? queue.length - 1 : beforeIdx > from ? beforeIdx - 1 : beforeIdx;
    moveInQueue(from, target);
  };
  const remove = (i: number) => {
    if (i === index) return useToast.getState().show('Låta som spilles kan ikke fjernes fra køen');
    const a = queue[i]!;
    removeFromQueue(i);
    useToast.getState().show(`Fjernet ${a.manifest.title} fra køen`, { label: 'Angre', run: () => usePlayer.getState().insertNext([a]) });
  };
  const touch = useTouchReorder(listRef, { attr: 'q', onMove: (id, before) => moveTo(Number(id), before === null ? null : Number(before)), onSwipe: (id) => remove(Number(id)), setDropBefore }, [open]);

  const dialogRef = useDialog<HTMLElement>(() => setOpen(false), { active: open });
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/45 lg:bg-transparent" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Køen"
        className="fixed inset-x-0 bottom-0 flex max-h-[82svh] flex-col rounded-t-2xl border-t border-white/10 bg-surface pb-[max(12px,env(safe-area-inset-bottom))] pt-2 shadow-2xl lg:bottom-[124px] lg:left-auto lg:right-6 lg:w-[400px] lg:rounded-2xl lg:border"
      >
        <div aria-hidden="true" className="mx-auto mb-1 h-1 w-10 rounded-full bg-white/15 lg:hidden" />
        <header className="flex items-center justify-between px-4 py-2">
          <h2 className="m-0 text-sm font-semibold text-ink-strong">Køen · {queue.length}</h2>
          <button type="button" onClick={() => setOpen(false)} className="h-10 rounded-full px-3 text-sm text-muted hover:text-ink">
            Lukk
          </button>
        </header>
        <p className="m-0 px-4 pb-2 text-[11px] text-muted">
          <span className="lg:hidden">↑ flytter opp, søppelbøtta fjerner · eller hold inne og dra, sveip til venstre</span>
          <span className="hidden lg:inline">Dra eller ↑ for å flytte · søppelbøtta fjerner · klikk spiller</span>
        </p>
        <ol ref={listRef} className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-2 py-0">
          {queue.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted">Køen er tom.</li>}
          {queue.map((a, i) => {
            const m = a.manifest;
            const cur = i === index;
            const t = touch?.id === String(i) ? touch : null;
            const style: CSSProperties | undefined = t ? { transform: t.mode === 'drag' ? `translateY(${t.dy}px) scale(1.02)` : `translateX(${t.dx}px)`, position: 'relative', zIndex: 5, background: '#15181F', borderRadius: 12 } : undefined;
            return (
              <li
                key={`${m.id}-${i}`}
                data-q={i}
                draggable={!cur}
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(i));
                }}
                onDragEnd={() => (setDragFrom(null), setDropBefore(undefined))}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropBefore(e.clientY < r.top + r.height / 2 ? String(i) : i + 1 < queue.length ? String(i + 1) : null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null && dropBefore !== undefined) moveTo(dragFrom, dropBefore === null ? null : Number(dropBefore));
                  setDragFrom(null);
                  setDropBefore(undefined);
                }}
                className={`relative ${dragFrom === i ? 'opacity-40' : ''}`}
                style={style}
              >
                {(dragFrom !== null || touch?.mode === 'drag') && dropBefore === String(i) && <span aria-hidden="true" className="absolute inset-x-2 -top-px h-0.5 rounded bg-accent" />}
                <div className={`flex min-h-14 items-center gap-3 rounded-xl px-2 ${cur ? 'bg-white/[0.06]' : ''}`}>
                  <button type="button" onClick={() => playIndex(i)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Spill ${m.title}`} aria-current={cur ? 'true' : undefined}>
                    <span className="tabular w-5 flex-none text-right text-xs text-muted">{cur ? <span className="text-accent">{playing ? '▶' : '❚❚'}</span> : i + 1}</span>
                    <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={40} rounded={6} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate text-sm font-semibold ${cur ? 'text-accent' : 'text-ink-strong'}`}>{m.title}</span>
                      <span className="truncate text-[11px] text-muted">{[m.variant ? variantName(a) : null, `v${m.version}`, formatTime(m.durationMs)].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                  {/* Del 27 pkt. 13: synlige knapper i tillegg til dra og sveip */}
                  {!cur && i > 0 && i - 1 !== index && (
                    <button type="button" onClick={() => moveTo(i, i - 1)} aria-label={`Flytt ${m.title} opp`} className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-muted hover:bg-white/[0.06] hover:text-ink lg:h-9 lg:w-9">
                      <span aria-hidden="true" className="text-base leading-none">↑</span>
                    </button>
                  )}
                  {!cur && (
                    <button type="button" onClick={() => remove(i)} aria-label={`Fjern ${m.title} fra køen`} className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-muted hover:bg-white/[0.06] hover:text-[#FF8A7A] lg:h-9 lg:w-9">
                      <TrashIcon width={15} height={15} />
                    </button>
                  )}
                  {!cur && (
                    <span aria-hidden="true" className="flex h-9 w-6 items-center justify-center text-muted/70 lg:cursor-grab">
                      <GripIcon width={15} height={15} />
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>,
    document.body
  );
}

/** Del 18: hvilken overgang idéen havner på – ut av låta som spilles, inn i neste i køen (eller «ut av denne»). */
function ideaTargetOf(a: LoadedAsset): { from: string; to: string | null; toTitle: string | null } {
  const { queue, index } = usePlayer.getState();
  const isNow = queue[index]?.manifest.id === a.manifest.id;
  const next = isNow ? queue[index + 1] : undefined;
  return { from: a.manifest.slug, to: next?.manifest.slug ?? null, toTitle: next?.manifest.title ?? null };
}
function IdeaTarget({ a }: { a: LoadedAsset }) {
  const t = ideaTargetOf(a);
  return <p className="m-0 px-1 text-xs text-muted">{t.to ? `${a.manifest.title} → ${t.toTitle}` : `Ut av ${a.manifest.title} (foreslås når låta havner i et sett)`}</p>;
}
/** Lagrer uten dialog; meldingen har «Angre». */
export async function captureIdea(a: LoadedAsset, preset: string) {
  const t = ideaTargetOf(a);
  const idea = await useFx.getState().saveIdea(t.from, t.to, preset);
  const name = useFx.getState().lastSaved?.text ?? 'Idé lagret';
  if (!idea) return void useToast.getState().show('Kunne ikke lagre idéen');
  useToast.getState().show(name, { label: 'Angre', run: () => void useFx.getState().undo(idea.id) });
}
