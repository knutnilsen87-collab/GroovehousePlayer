import { AlbumBuilder, AlbumBuilderSheet } from '../components/AlbumBuilder';
import { FullAsset } from '../components/FullAsset';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { computeCoverage, formatTime, paletteToCssVars, withAlpha, type AccessTier, type AssetManifest, type Palette, isDraft, skinPalette, versionName } from '@gv/shared/web';
import { Logo } from '../components/Brand';
import { CoverArt } from '../components/CoverArt';
import { ArchiveIcon, ChevronDownIcon, DropsIcon, LinkIcon, PauseIcon, PlayIcon, PlusIcon, PulseIcon, StudioIcon, UploadIcon } from '../components/Icons';
import { AssetLook } from '../components/AssetLook';
import { LyricsEditor } from '../components/LyricsEditor';
import { MarkerEditor } from '../components/MarkerEditor';
import { DraftBadge } from '../components/Draft';
import { loadPlaybackSettings } from '../lib/settings';
import { SettingsView } from './Settings';
import { Waveform } from '../components/Waveform';
import { assetUrl, downsample, findMain, lastLogFor, loadVersion, saveAssetMeta, uploadAssetCover, useCatalog, useFullAsset, useIngestLog, useIngestProgress, versionsOf, type IndexEntry, type IngestLogEntry, type LoadedAsset } from '../lib/catalog';
import { useLyricsQueue } from '../lib/library';
import { AiCoverCard } from '../components/AiCover';
import { SkippedImportsCard } from '../components/SkippedImports';
import { admin as t } from '../lib/i18n';
import { usePlayer } from '../lib/player';
import { useSkin, useSkinId } from '../lib/skin';
import { SEED_DROPS, type SeedDrop, type SeedRecipient } from '../lib/seed';
import { skinTrackVars } from '../lib/skin';

type View = 'drops' | 'archive' | 'sets' | 'album' | 'mobile' | 'settings';

/** Ditt arbeidsbord. Gull er systemfarge her, men data og kontroll har prioritet. */
export function CommandCenter() {
  const { assets, index, loading, reload } = useCatalog();
  const [tick, setTick] = useState(0);
  const log = useIngestLog(tick);
  const refresh = () => {
    reload();
    setTick((x) => x + 1);
  };
  // /studio#mobil åpner Mobil-visningen direkte.
  // /studio#arkiv/<slug> (fra «⋯ → Åpne i Studio» i spilleren) åpner Arkiv og markerer låta.
  // /studio/innstillinger (del 8) er en egen adresse.
  const [view, setViewState] = useState<View>(() =>
    typeof location === 'undefined' ? 'drops' : location.pathname.startsWith('/studio/innstillinger') ? 'settings' : location.hash === '#mobil' ? 'mobile' : location.hash === '#album' ? 'album' : location.hash.startsWith('#arkiv') ? 'archive' : 'drops'
  );
  const setView = (v: View) => {
    setViewState(v);
    const want = v === 'settings' ? '/studio/innstillinger' : '/studio';
    if (location.pathname !== want) history.pushState(null, '', want);
  };
  useEffect(() => {
    void loadPlaybackSettings();
    const onPop = () => setViewState(location.pathname.startsWith('/studio/innstillinger') ? 'settings' : 'drops');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return (
    <div className="flex min-h-screen flex-wrap items-stretch bg-obsidian text-ink">
      <Sidebar view={view} setView={setView} />
      <main className="min-w-0 flex-[999_1_560px] px-8 pb-28 pt-7">
        {view === 'settings' ? (
          <SettingsView />
        ) : loading ? (
          <p className="text-muted">Laster katalog…</p>
        ) : view === 'drops' ? (
          <DropsView assets={assets} log={log} onRefresh={refresh} />
        ) : view === 'mobile' ? (
          <MobileView />
        ) : view === 'album' ? (
          <>
            <AlbumBuilder assets={assets} />
            <AlbumBuilderSheet assets={assets} />
          </>
        ) : (
          <ArchiveView assets={view === 'sets' ? assets.filter((a) => a.manifest.kind === 'set') : assets} title={view === 'sets' ? t.sets : t.archive} log={log} onSaved={refresh} index={index} />
        )}
      </main>
      <MiniPlayer />
    </div>
  );
}

function Sidebar({ view, setView }: { view: View; setView: (v: View) => void }) {
  const items: Array<{ id: View; label: string; Icon: typeof DropsIcon }> = [
    { id: 'drops', label: t.drops, Icon: DropsIcon },
    { id: 'archive', label: t.archive, Icon: ArchiveIcon },
    { id: 'sets', label: t.sets, Icon: PulseIcon },
    { id: 'album', label: 'Album', Icon: ArchiveIcon },
    { id: 'mobile', label: t.mobile, Icon: LinkIcon },
    { id: 'settings', label: 'Innstillinger', Icon: StudioIcon }
  ];
  return (
    <aside className="flex max-w-[260px] flex-[1_1_220px] flex-col gap-7 bg-sunken px-[18px] py-6">
      <Logo size={48} subtitle="COMMAND CENTER" />
      <nav aria-label="Hovedmeny" className="flex flex-col gap-0.5">
        {items.map(({ id, label, Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => setView(id)}
              className={`flex min-h-11 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm ${active ? 'bg-accent/[0.08] font-semibold text-accent' : 'text-muted hover:text-ink-strong'}`}
            >
              <Icon width={18} height={18} />
              {label}
            </button>
          );
        })}
      </nav>
      <a href="/" className="flex min-h-11 items-center gap-2.5 rounded-[10px] px-3 text-sm text-muted no-underline hover:text-ink-strong">
        ← Tilbake til spilleren
      </a>
      <div className="mt-auto flex flex-col gap-1.5 rounded-xl bg-surface p-3.5">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_var(--glow)]" />
          {t.watcher}
        </div>
        <span className="text-[11px] text-muted">{t.watcherHint}</span>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- Mobil (LAN)

interface LanStatus {
  enabled: boolean;
  port: number;
  urls: string[];
  qr: string | null;
  networks: string[];
}

/** QR-kode og adresse for å åpne spilleren på mobilen over hjemmenettet. */
function MobileView() {
  const [status, setStatus] = useState<LanStatus | null | 'unavailable'>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/lan/status', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<LanStatus>) : Promise.reject(new Error(String(r.status)))))
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus('unavailable'));
    return () => {
      alive = false;
    };
  }, []);
  const publicNets = status && status !== 'unavailable' ? status.networks.filter((n) => /\|Public$/i.test(n)).map((n) => n.split('|')[0]) : [];

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <h1 className="m-0 font-display text-[34px] font-semibold uppercase tracking-[1.5px] text-ink-strong">{t.mobile}</h1>
      {status === null && <p className="text-sm text-muted">Henter status…</p>}
      {status === 'unavailable' && <p className="text-sm text-muted">{t.mobileDevOnly}</p>}
      {status && status !== 'unavailable' && !status.enabled && (
        <div className="flex flex-col gap-2 rounded-2xl bg-surface p-5 text-sm">
          <p className="m-0 font-semibold">{t.mobileOff}</p>
          <p className="m-0 text-muted">
            Kjør <code className="text-ink">pnpm vault:lan on</code> i prosjektmappa. Du velger en PIN, og Windows spør om brannmurregel for private nettverk.
          </p>
        </div>
      )}
      {status && status !== 'unavailable' && status.enabled && (
        <div className="flex flex-wrap items-start gap-6 rounded-2xl bg-surface p-5">
          {status.qr ? (
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(status.qr)}`}
              alt={`QR-kode til ${status.urls[0]}`}
              width={220}
              height={220}
              className="rounded-xl"
            />
          ) : (
            <p className="text-sm text-muted">{t.mobileNoIp}</p>
          )}
          <div className="flex min-w-[240px] flex-1 flex-col gap-3 text-sm">
            <p className="m-0 font-semibold text-accent">{t.mobileOn}</p>
            <ol className="m-0 flex flex-col gap-1.5 pl-5 text-[#C9C4B6]">
              <li>Koble mobilen til samme Wi-Fi som PC-en.</li>
              <li>Pek kameraet på QR-koden og åpne lenken.</li>
              <li>Tast PIN-koden. Mobilen huskes i 30 dager.</li>
            </ol>
            {status.urls.map((u) => (
              <code key={u} className="tabular w-fit rounded-lg bg-sunken px-2.5 py-1.5 text-ink">
                {u}
              </code>
            ))}
            {publicNets.length > 0 && (
              <p role="alert" className="m-0 text-[12px] text-[#F2A08F]">
                Windows har satt {publicNets.join(', ')} som «Offentlig» nettverk – da slipper ikke brannmuren mobilen inn. Endre til «Privat» i Innstillinger → Nettverk og Internett.
              </p>
            )}
            <p className="m-0 text-[11px] text-muted">{t.mobileWarning}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Drops

function DropsView({ assets, log, onRefresh }: { assets: LoadedAsset[]; log: IngestLogEntry[]; onRefresh?: () => void }) {
  const [dropSlug, setDropSlug] = useState(SEED_DROPS[0]!.slug);
  const drop = SEED_DROPS.find((d) => d.slug === dropSlug)!;

  return (
    <div className="flex flex-col gap-[22px]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 font-display text-[34px] font-semibold uppercase tracking-[1.5px] text-ink-strong">{t.drops}</h1>
          <p className="mt-1 text-[13px] text-muted">
            {SEED_DROPS.length} drops · {assets.length} assets i katalogen · {t.sampleData}
          </p>
        </div>
        <button type="button" disabled title={t.phase2} className="flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-60">
          <PlusIcon width={16} height={16} />
          {t.newDrop}
        </button>
      </header>

      <IngestStrip
        assets={assets}
        log={log}
        onDone={onRefresh}
      />

      <section className="flex flex-wrap items-start gap-5">
        <div className="flex max-w-[360px] flex-[1_1_280px] flex-col gap-2.5">
          <h2 className="mb-0.5 text-[11px] font-semibold tracking-[2px] text-muted">{t.activeDrops.toUpperCase()}</h2>
          {SEED_DROPS.map((d) => (
            <DropCard key={d.slug} drop={d} assets={assets} selected={d.slug === dropSlug} onSelect={() => setDropSlug(d.slug)} />
          ))}
        </div>
        <DropDetail key={drop.slug} drop={drop} assets={assets} />
      </section>
    </div>
  );
}

/**
 * Del 16: «Importer som utkast». Filene kopieres til data/drafts-inbox/ på PC-en, og utkast-watcheren
 * ingester dem som UTKAST (holdes atskilt fra release-klare). Bare lyd (WAV/AIFF/FLAC) og cover-bilder.
 */
function DraftImport() {
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => /\.(wav|wave|aif|aiff|flac|png|jpe?g|webp)$/i.test(f.name));
    if (!list.length) return setMsg({ ok: false, text: 'Bare WAV, AIFF, FLAC og cover-bilder kan importeres.' });
    setBusy(true);
    setMsg(null);
    try {
      for (const f of list) {
        const r = await fetch(`/api/drafts/import?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'X-GV-Import': '1', 'Content-Type': f.type || 'application/octet-stream' }, body: f });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      setMsg({ ok: true, text: `${list.length} fil${list.length > 1 ? 'er' : ''} importert som umastret – ingestes nå.` });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
      className={`flex min-h-32 flex-col items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-dashed p-4 text-center ${over ? 'border-accent bg-accent/[0.08]' : 'border-accent/35 bg-accent/[0.03]'}`}
    >
      <UploadIcon width={26} height={26} className="text-accent" strokeWidth={1.8} />
      <span className="text-sm font-semibold">Importer som umastret</span>
      <span className="text-xs text-muted">Dra umastrede låter hit (WAV/AIFF/FLAC + cover). De holdes atskilt fra de release-klare.</span>
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="mt-1 h-8 rounded-full bg-white/[0.04] px-3 text-xs text-ink hover:border-accent/50 disabled:opacity-50">
        {busy ? 'Laster opp …' : 'Velg filer …'}
      </button>
      <input ref={input} type="file" multiple accept=".wav,.wave,.aif,.aiff,.flac,image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Velg filer som skal importeres som umastret" onChange={(e) => e.target.files && void upload(e.target.files)} />
      {msg && <span className={`text-xs ${msg.ok ? 'text-accent' : 'text-[#FF8A7A]'}`}>{msg.text}</span>}
    </div>
  );
}

/** Del 16: et utkast blir release-klart bare ved et eksplisitt valg (eller når master kommer i REASONDONE). */
function MakeRelease({ a, onDone }: { a: LoadedAsset; onDone: () => void }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = a.manifest;
  if (!isDraft(m)) return null;
  if (!ask)
    return (
      <button type="button" onClick={() => setAsk(true)} className="min-h-11 rounded-full border border-dashed border-white/30 px-4 text-xs font-semibold text-soft hover:border-accent/50 hover:text-ink">
        Gjør release-klar …
      </button>
    );
  return (
    <span role="alertdialog" aria-label="Gjør release-klar" className="flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-1.5 text-xs text-soft">
      Gjøre «{m.title}» ({versionName(m)}) release-klar uten master fra REASONDONE?
      <button
        type="button"
        onClick={async () => {
          const r = await fetch(`/api/assets/${encodeURIComponent(m.slug)}/${encodeURIComponent(m.variant ?? 'main')}/v${m.version}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'release', confirm: true }) });
          if (r.ok) {
            setAsk(false);
            onDone();
          } else setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
        }}
        className="h-8 rounded-full bg-accent px-3 font-semibold text-on-accent"
      >
        Ja, gjør release-klar
      </button>
      <button type="button" onClick={() => setAsk(false)} className="h-8 rounded-full px-2 text-muted">
        Avbryt
      </button>
      {err && <span className="text-[#FF8A7A]">{err}</span>}
    </span>
  );
}

function IngestStrip({ assets, log, onDone }: { assets: LoadedAsset[]; log: IngestLogEntry[]; onDone?: () => void }) {
  // Del 4: lange sett viser prosent mens de ingestes
  const progress = useIngestProgress(onDone);
  const recent = [...assets].sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt)).slice(0, 2);
  return (
    <section aria-label="Ingest" className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
      <DraftImport />
      {progress && (
        <div role="status" aria-label={`Ingester ${progress.title}`} className="flex min-h-32 flex-col justify-center gap-2 rounded-2xl border border-accent/40 bg-accent/[0.05] p-4">
          <span className="gv-label">Ingester nå</span>
          <span className="truncate text-sm font-semibold text-ink-strong">{progress.title}</span>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
            <div className="gv-neon h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${progress.percent}%` }} />
          </div>
          <span className="font-mono text-xs text-soft">{progress.percent} % · HLS, analyse og LUFS kjører samtidig</span>
        </div>
      )}
      <SkippedImportsCard onImported={onDone} />
      <LyricsQueueCard />
      <AiCoverCard />
      {recent.map((a) => (
        <IngestCard key={a.manifest.id} a={a} entry={lastLogFor(log, a)} />
      ))}
    </section>
  );
}

const LYRICS_STAGE: Record<string, string> = { start: 'starter', demucs: 'isolerer vokal (Demucs)', language: 'finner språk', transcribe: 'transkriberer (WhisperX)', align: 'beregner ordtider', write: 'lagrer' };

/** Tekstkøen etter ingest: hva som kjører nå, hva som venter, og de siste ferdige. */
function LyricsQueueCard() {
  const q = useLyricsQueue();
  if (!q) return null;
  const running = q.jobs.find((j) => j.status === 'running');
  const waiting = q.jobs.filter((j) => j.status === 'waiting');
  const finished = q.jobs.filter((j) => j.status !== 'running' && j.status !== 'waiting').slice(-3).reverse();
  const b = q.batch;
  const batchAct = async (action: 'start' | 'pause' | 'resume' | 'stop') => {
    await fetch('/api/lyrics-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).catch(() => null);
  };
  return (
    <div role="status" aria-label="Tekstkø" className="gv-panel flex min-h-32 flex-col gap-2 p-4">
      <span className="gv-label">Tekst {q.enabled ? '' : '· automatikk av'}</span>
      {b ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-white/[0.03] p-2.5">
          <span className="text-[13px] text-ink-strong">
            Nattkjøring: {b.done} av {b.total} {b.paused ? '· på pause' : b.inWindow ? '· kjører nå' : `· starter kl. ${String(b.window.from).padStart(2, '0')}`}
          </span>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full rounded-full bg-accent" style={{ width: `${b.total ? (b.done / b.total) * 100 : 0}%` }} />
          </div>
          {b.next && <span className="truncate font-mono text-[13px] text-muted">Neste: {b.next}</span>}
          <span className="flex gap-1.5">
            <button type="button" onClick={() => batchAct(b.paused ? 'resume' : 'pause')} className="h-8 rounded-full bg-accent/[0.16] px-3 text-[13px] font-semibold text-accent">
              {b.paused ? 'Fortsett' : 'Pause'}
            </button>
            <button type="button" onClick={() => batchAct('stop')} className="h-8 rounded-full bg-white/[0.06] px-3 text-[13px] text-soft">
              Stopp
            </button>
          </span>
        </div>
      ) : (
        <button type="button" onClick={() => batchAct('start')} className="h-8 self-start rounded-full bg-white/[0.06] px-3 text-[13px] text-soft hover:text-ink-strong" title="Tekst på alle låter (ikke live-sett) mellom kl. 01 og 07, med lav prioritet">
          Tekst på alle låter i natt …
        </button>
      )}
      {!q.python && <span className="text-xs text-soft">Fant ikke .venv-lyrics (demucs/whisperx). Bruker «python» fra PATH.</span>}
      {running ? (
        <>
          <span className="truncate text-sm font-semibold text-ink-strong">{running.title}</span>
          <span className="font-mono text-[13px] text-soft">{LYRICS_STAGE[running.stage ?? 'start'] ?? running.stage}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
        </>
      ) : (
        <span className="text-sm text-soft">{waiting.length ? 'Starter snart …' : 'Ingenting i kø.'}</span>
      )}
      {waiting.length > 0 && <span className="font-mono text-[13px] text-muted">{waiting.length} i kø: {waiting.slice(0, 3).map((j) => j.title).join(', ')}{waiting.length > 3 ? ' …' : ''}</span>}
      {finished.map((j) => (
        <span key={`${j.slug}-${j.finishedAt}`} className="truncate text-[13px] text-soft" title={j.note ?? undefined}>
          {j.status === 'done' ? '✓' : j.status === 'skipped' ? '↷' : '✗'} {j.title}
          <span className="font-mono text-muted">
            {' '}
            · {j.status === 'done' ? (j.mode === 'instrumental' ? 'instrumental' : `${j.words} ord, ${j.mode === 'auto' ? 'auto – sjekk' : 'ordtider'}`) : j.note} · {Math.round((j.ms ?? 0) / 1000)} s
          </span>
        </span>
      ))}
    </div>
  );
}

function IngestCard({ a, entry }: { a: LoadedAsset; entry?: IngestLogEntry }) {
  const m = a.manifest;
  const steps = pipelineSteps(m);
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface px-[18px] py-4">
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={36} rounded={8} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-ink-strong">
              {m.title}
              {m.variantLabel ? ` (${m.variantLabel})` : ''}
            </span>
            <span className="font-mono text-[11px] text-soft">
              {m.kind} · v{m.version} · {formatTime(m.durationMs)}
            </span>
          </div>
        </div>
        <span className="rounded-md bg-accent/15 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-[1.2px] text-accent">KLAR</span>
      </div>
      <SunoNotice entry={entry} />
      {m.titleNeedsReview && <p className="m-0 text-[11px] text-accent">{t.titleNeedsReview}</p>}
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Systemstatus for ferdigbehandlet fil">
        {steps.map((s) => (
          <li
            key={s.label}
            className={`inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] ${
              s.ok ? 'bg-[#121620] text-soft' : 'bg-[#171316] text-muted'
            }`}
          >
            <span aria-hidden="true" className={s.ok ? 'text-accent' : 'text-[#F2A08F]'}>
              {s.ok ? '✓' : '•'}
            </span>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tydelig varsel når ingest fant «suno» i filnavn, tags eller tekstfelt. */
function SunoNotice({ entry }: { entry?: IngestLogEntry }) {
  if (!entry || entry.suno.length === 0) return null;
  return (
    <div role="status" className="rounded-xl border border-accent/50 bg-accent/[0.08] px-3 py-2 text-[12px] text-ink">
      <p className="m-0 font-semibold text-accent">{t.sunoFound(entry.suno.length)}</p>
      <ul className="m-0 mt-1 list-disc pl-4 text-[11px] text-[#C9C4B6]">
        {entry.suno.map((s) => (
          <li key={s} className="break-all">
            {s}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-1 text-[11px] text-muted">{t.sunoRemoved}</p>
    </div>
  );
}

function pipelineSteps(m: AssetManifest) {
  return [
    { label: 'HLS 256k', ok: !!m.files.hls },
    { label: 'Bølgeform', ok: !!m.files.analysis },
    { label: m.palette.source === 'cover' ? 'Palett' : 'Palett (standard grønn)', ok: m.palette.source === 'cover' },
    { label: `${m.loudness.integratedLufs} LUFS`, ok: true },
    { label: 'Preview 30 s', ok: !!m.files.preview },
    { label: `${m.markers.length} markører`, ok: true },
    { label: 'Master til R2 (fase 2)', ok: false }
  ];
}

const TIER_STYLE: Record<AccessTier, string> = {
  partner: 'border-[#E5B84B]/50 bg-[#E5B84B]/12 text-[#F3CF7A]',
  inner: 'border-[#38BDF8]/50 bg-[#38BDF8]/12 text-[#7DD3FC]',
  supporter: 'border-[#A855F7]/50 bg-[#A855F7]/12 text-[#D8B4FE]',
  teaser: 'border-white/20 bg-white/[0.04] text-soft'
};

const TIER_BADGE_TEXT: Record<AccessTier, string> = {
  partner: 'text-[#F3CF7A]',
  inner: 'text-[#7DD3FC]',
  supporter: 'text-[#D8B4FE]',
  teaser: 'text-soft'
};

function DropCard({ drop, assets, selected, onSelect }: { drop: SeedDrop; assets: LoadedAsset[]; selected: boolean; onSelect: () => void }) {
  const first = (drop.assetSlugs[0] ? findMain(assets, drop.assetSlugs[0]) : undefined);
  const opens = drop.opensAt && new Date(drop.opensAt) > new Date();
  const meta = opens
    ? `Åpner ${new Date(drop.opensAt!).toLocaleDateString('nb-NO')}`
    : `${drop.recipients.length} mottakere${drop.expiresAt ? ` · utløper ${new Date(drop.expiresAt).toLocaleDateString('nb-NO')}` : ''}`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-[14px] border p-3.5 text-left transition-all ${
        selected ? 'border-accent/60 bg-white/[0.04] shadow-[inset_3px_0_0_var(--accent)]' : 'border-white/[0.06] bg-surface hover:border-white/15 hover:bg-white/[0.025]'
      }`}
    >
      {first ? (
        <CoverArt src={assetUrl(first, first.manifest.files.coverThumb)} palette={first.manifest.palette} title={first.manifest.title} size={44} rounded={9} />
      ) : (
        <span className="h-11 w-11 rounded-[9px] bg-white/5" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-ink-strong">{drop.title}</span>
        <span className="text-[11px] text-soft">{meta}</span>
      </span>
      <span className={`rounded-md border px-2 py-1 font-mono text-[11px] font-semibold tracking-[1.2px] ${TIER_STYLE[drop.tier]}`}>{drop.tier.toUpperCase()}</span>
    </button>
  );
}

function DropDetail({ drop, assets }: { drop: SeedDrop; assets: LoadedAsset[] }) {
  const dropAssets = drop.assetSlugs.map((s) => findMain(assets, s)).filter((a): a is LoadedAsset => !!a);
  const [assetSlug, setAssetSlug] = useState(dropAssets[0]?.manifest.slug ?? '');
  const asset = dropAssets.find((a) => a.manifest.slug === assetSlug) ?? dropAssets[0];
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState(false);

  if (!asset) {
    return (
      <div className="min-w-0 flex-[999_1_520px] rounded-[18px] bg-surface p-6 text-sm text-muted">
        Ingen av assetene i denne dropen er ingestet ennå. Kjør <code className="text-ink">pnpm gh-ingest fixtures/{drop.assetSlugs[0]}</code>.
      </div>
    );
  }
  const m = asset.manifest;
  const vars = skinTrackVars(m.palette) as CSSProperties;
  const recipient = drop.recipients[sel];
  const dropMs = m.markers.find((k) => k.kind === 'drop')?.startMs ?? null;

  const copy = async () => {
    if (!recipient) return;
    const url = `${location.origin}/drop/${drop.slug}?r=${encodeURIComponent(recipient.name)}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative min-w-0 flex-[999_1_520px] overflow-hidden rounded-[18px] bg-surface p-[24px]" style={vars}>
      <div aria-hidden="true" className="pointer-events-none absolute -right-[120px] -top-[160px] h-[420px] w-[420px] rounded-full" style={{ background: 'radial-gradient(circle, var(--glow) 0%, var(--glow-2) 45%, transparent 70%)', opacity: 0.45 }} />

      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <CoverArt src={assetUrl(asset, m.files.coverThumb)} palette={m.palette} title={m.title} size={72} rounded={12} />
          <div className="flex flex-col gap-1">
            <span className={`font-mono text-[11px] font-semibold tracking-[2px] ${TIER_BADGE_TEXT[drop.tier]}`}>{drop.tier.toUpperCase()}-DROP</span>
            <h2 className="m-0 font-display text-[26px] font-semibold uppercase tracking-[1px] text-ink-strong">{drop.title}</h2>
            <span className="text-xs text-soft">
              {dropAssets.length} assets · {drop.recipients.length} mottakere · maks {drop.maxDevices} enheter per lenke
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={copy}
            disabled={!recipient}
            className="flex min-h-10 items-center gap-2 rounded-full bg-accent px-5 text-[13px] font-semibold text-on-accent shadow-[0_0_18px_var(--glow)] transition-transform active:scale-95 disabled:opacity-50"
          >
            <LinkIcon width={15} height={15} />
            {copied ? t.copied : t.copyLink}
          </button>
          <a
            href={`/drop/${drop.slug}${recipient ? `?r=${encodeURIComponent(recipient.name)}` : ''}`}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-10 items-center rounded-full px-3.5 text-[13px] font-medium text-soft no-underline transition-colors hover:bg-white/[0.06] hover:text-ink-strong"
          >
            Åpne lyttervisning
          </a>
          <button type="button" disabled title={t.phase2} className="flex min-h-10 items-center rounded-full px-3.5 text-[13px] font-medium text-soft transition-colors hover:bg-white/[0.06] hover:text-ink-strong disabled:opacity-40">
            {t.addRecipient}
          </button>
          <button type="button" disabled title={t.phase2} className="flex min-h-10 items-center rounded-full px-3.5 text-[13px] font-medium text-soft transition-colors hover:bg-white/[0.06] hover:text-[#FF8A7A] disabled:opacity-40">
            {t.revoke}
          </button>
        </div>
      </div>

      {dropAssets.length > 1 && (
        <div role="tablist" aria-label="Asset" className="relative mt-5 inline-flex flex-wrap gap-1 rounded-xl bg-sunken/70 p-1">
          {dropAssets.map((a) => (
            <button
              key={a.manifest.slug}
              type="button"
              role="tab"
              aria-selected={a.manifest.slug === m.slug}
              onClick={() => setAssetSlug(a.manifest.slug)}
              className={`h-8 rounded-lg px-3.5 text-xs font-medium transition-colors ${a.manifest.slug === m.slug ? 'bg-accent/[0.15] font-semibold text-accent' : 'text-soft hover:text-ink-strong'}`}
            >
              {a.manifest.title}
            </button>
          ))}
        </div>
      )}

      {drop.recipients.length === 0 ? (
        <p className="relative mt-6 text-sm text-muted">Ingen mottakere på denne dropen ennå.</p>
      ) : (
        <>
          <div className="relative mt-5 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left font-mono text-[11px] font-semibold tracking-[1.5px] text-soft">
                  <th scope="col" className="pb-2.5 pl-3 pr-2.5 font-semibold">{t.recipient.toUpperCase()}</th>
                  <th scope="col" className="px-2.5 pb-2.5 font-semibold">{t.opened.toUpperCase()}</th>
                  <th scope="col" className="px-2.5 pb-2.5 font-semibold">
                    {t.coverage.toUpperCase()} · {m.title.toUpperCase()}
                  </th>
                  <th scope="col" className="px-2.5 pb-2.5 font-semibold">{t.status.toUpperCase()}</th>
                  <th scope="col" className="pb-2.5 pl-2.5 font-semibold">{t.devices.toUpperCase()}</th>
                </tr>
              </thead>
              <tbody>
                {drop.recipients.map((r, i) => (
                  <RecipientRow key={r.id} r={r} asset={asset} dropMs={dropMs} maxDevices={drop.maxDevices} selected={i === sel} onSelect={() => setSel(i)} />
                ))}
              </tbody>
            </table>
            <p className="mt-2.5 text-[11px] text-soft">Bakgrunnsriss = sporets faktiske bølgeform. Vertikal linje = DROP-markør. Sterk grønn = spilt flere ganger.</p>
          </div>
          {recipient && <ListenLog r={recipient} asset={asset} dropMs={dropMs} />}
        </>
      )}
    </div>
  );
}

function RecipientRow({ r, asset, dropMs, maxDevices, selected, onSelect }: { r: SeedRecipient; asset: LoadedAsset; dropMs: number | null; maxDevices: number; selected: boolean; onSelect: () => void }) {
  const m = asset.manifest;
  const events = r.events[m.slug] ?? [];
  const cov = useMemo(() => computeCoverage(events, m.durationMs, 48), [events, m.durationMs]);
  const opens = events.filter((e) => e.event === 'open').length;
  const heights = useMemo(() => downsample(asset.analysis?.peaks ?? [], 48), [asset.analysis]);
  const envelopePoints = useMemo(() => {
    if (!heights.length) return '';
    const top = heights.map((h, i) => `${((i / (heights.length - 1)) * 300).toFixed(1)},${(19 - Math.max(2, h * 16)).toFixed(1)}`);
    const bot = [...heights].reverse().map((h, idx) => {
      const i = heights.length - 1 - idx;
      return `${((i / (heights.length - 1)) * 300).toFixed(1)},${(19 + Math.max(2, h * 16)).toFixed(1)}`;
    });
    return `M ${top.join(' L ')} L ${bot.join(' L ')} Z`;
  }, [heights]);
  const status =
    events.length === 0
      ? { text: 'Ikke åpnet', cls: 'text-muted' }
      : cov.finished
        ? { text: 'Lyttet ferdig', cls: 'text-accent' }
        : { text: `Falt av ${formatTime(cov.stoppedAtMs ?? 0)}`, cls: 'text-ink-strong' };
  const overLimit = r.devices > maxDevices;

  return (
    <tr
      onClick={onSelect}
      className={`cursor-pointer border-t border-white/[0.06] transition-colors ${
        selected ? 'bg-white/[0.06] shadow-[inset_3px_0_0_var(--accent)]' : 'hover:bg-white/[0.025]'
      }`}
    >
      <td className="py-1.5 pl-3 pr-2.5">
        <button type="button" aria-pressed={selected} onClick={onSelect} className="flex min-h-14 w-full flex-col justify-center rounded-lg px-2 text-left">
          <span className={`font-semibold ${selected ? 'text-accent' : 'text-ink-strong'}`}>{r.name}</span>
          <span className="text-[11px] text-soft">{r.org}</span>
        </button>
      </td>
      <td className="tabular px-2.5 font-mono text-soft">{opens ? `${opens}×` : '—'}</td>
      <td className="px-2.5 py-2">
        <div className="relative flex h-[38px] w-[300px] items-center gap-[2px] rounded-lg bg-obsidian px-2 py-1" aria-label={`Hørt ${Math.round(cov.heardRatio * 100)} %`} role="img">
          {/* Subtilt mørkegrått bakgrunnsriss av sporets faktiske bølgeform-konvolutt */}
          {envelopePoints && (
            <svg viewBox="0 0 300 38" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-x-2 inset-y-0 h-full w-[calc(100%-16px)]">
              <path d={envelopePoints} fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)" strokeWidth="0.8" />
            </svg>
          )}
          {heights.map((h, i) => {
            const plays = cov.plays[i] ?? 0;
            const bg = plays >= 2 ? 'var(--accent)' : plays === 1 ? 'color-mix(in srgb, var(--accent) 62%, transparent)' : 'rgba(255,255,255,0.13)';
            return <span key={i} aria-hidden="true" className="relative z-10 flex-1 rounded-[1.5px]" style={{ height: Math.max(4, Math.round(h * 28)), backgroundColor: bg }} />;
          })}
          {dropMs !== null && (
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-20 w-[1.5px] bg-[#E5B84B]" style={{ left: `${(dropMs / m.durationMs) * 100}%` }}>
              <span className="absolute -top-2 -translate-x-1/2 rounded bg-obsidian px-1 font-mono text-[11px] font-bold tracking-wider text-[#F3CF7A]">DROP</span>
            </span>
          )}
        </div>
      </td>
      <td className={`whitespace-nowrap px-2.5 font-medium ${status.cls}`}>{status.text}</td>
      <td className={`whitespace-nowrap pl-2.5 font-mono text-xs ${overLimit ? 'text-accent' : 'text-soft'}`}>
        {r.devices === 0 ? '—' : `${r.devices} ${r.devices === 1 ? 'enhet' : 'enheter'}`}
        {overLimit && ' · sjekk'}
      </td>
    </tr>
  );
}

function ListenLog({ r, asset, dropMs }: { r: SeedRecipient; asset: LoadedAsset; dropMs: number | null }) {
  const events = r.events[asset.manifest.slug] ?? [];
  const lines = describeEvents(events, asset.manifest, dropMs);
  return (
    <div className="relative mt-4 flex flex-col gap-3 rounded-[14px] border border-accent/35 bg-sunken/90 p-[18px] shadow-[inset_3px_0_0_var(--accent)]">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="m-0 flex items-center gap-2 text-[15px] font-semibold text-ink-strong">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
          {t.listenLog} · <span className="text-accent">{r.name}</span> · <span className="font-normal text-soft">{r.org}</span>
        </h3>
        <span className="font-mono text-xs text-soft">{r.device}</span>
      </div>
      {lines.length === 0 ? (
        <p className="m-0 text-[13px] text-soft">Ingen aktivitet ennå. Lenken er sendt.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {lines.map((l, i) => (
            <li key={i} className="flex items-baseline gap-3.5">
              <span className="tabular w-[52px] flex-none font-mono text-xs text-soft">{l.at}</span>
              <span aria-hidden="true" className="h-2 w-2 flex-none -translate-y-px rounded-full" style={{ background: l.accent ? 'var(--accent)' : 'rgba(255,255,255,0.35)' }} />
              <span className="text-[13px] text-ink">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Gjør rå hendelser om til menneskelige linjer: «Spilte 0:00 → 0:40», «Spolte tilbake til 0:21 (DROP)». */
function describeEvents(events: SeedRecipient['events'][string], m: AssetManifest, dropMs: number | null) {
  const out: Array<{ at: string; text: string; accent: boolean }> = [];
  const time = (iso: string) => new Date(iso).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
  const nearDrop = (ms: number) => (dropMs !== null && Math.abs(ms - dropMs) < 6000 ? ' (DROP)' : '');
  let from: number | null = null;
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.event === 'open') out.push({ at: time(e.at), text: 'Åpnet lenken', accent: false });
    else if (e.event === 'play') from = e.positionMs;
    else if (e.event === 'seek') {
      if (from !== null) out.push({ at: time(e.at), text: `Spilte ${m.title} ${formatTime(from)} → ${formatTime(e.positionMs)}`, accent: true });
      const to = e.toMs ?? e.positionMs;
      out.push({ at: time(e.at), text: `Spolte ${to < e.positionMs ? 'tilbake' : 'fram'} til ${formatTime(to)}${nearDrop(to)}`, accent: false });
      from = to;
    } else if (e.event === 'pause' && from !== null) {
      out.push({ at: time(e.at), text: `Spilte ${formatTime(from)} → ${formatTime(e.positionMs)} · pause`, accent: true });
      from = null;
    } else if (e.event === 'ended') {
      out.push({ at: time(e.at), text: `Spilte ${formatTime(from ?? 0)} → ${formatTime(m.durationMs)} · lyttet ferdig`, accent: true });
      from = null;
    }
  }
  const last = events[events.length - 1];
  if (from !== null && last && last.event === 'heartbeat') {
    out.push({ at: time(last.at), text: `Spilte ${formatTime(from)} → ${formatTime(last.positionMs)} · stoppet`, accent: true });
  }
  return out;
}

// ---------------------------------------------------------------- Arkiv / Live-sett

/** Del 19: fargen i Arkiv følger skinnet – Kameleon bruker låtas egen palett (cover eller manuell), faste skins sin aksent. */
function chameleonPalette(m: AssetManifest): Palette {
  return skinPalette(useSkin.getState().skin, m.palette);
}

function PinMarkerIcon({ width = 16, height = 16 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function EditPencilIcon({ width = 16, height = 16 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ArchiveView({ assets, title, log, onSaved, index }: { assets: LoadedAsset[]; title: string; log: IngestLogEntry[]; onSaved: () => void; index: IndexEntry[] }) {
  const { setQueue, playIndex } = usePlayer();
  const isSets = title === t.sets;
  // Del 10: hvor mange ganger hver versjon er delt (lokal logg, data/shares.json)
  const [shareCounts, setShareCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    fetch('/api/shares')
      .then((r) => (r.ok ? (r.json() as Promise<{ counts: Record<string, number> }>) : { counts: {} }))
      .then((j) => setShareCounts(j.counts))
      .catch(() => {});
  }, []);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-[34px] font-semibold uppercase tracking-[1.5px] text-ink-strong">{title}</h1>
          <p className="m-0 mt-1 text-xs text-soft">
            {isSets
              ? `${assets.length} live-sett · Macro/Micro-navigasjon med synkronisert sporliste`
              : `${assets.length} utgivelser · Klikk på en rad for å folde ut bølgeform og strukturmarkører`}
          </p>
        </div>
      </div>
      {assets.length === 0 && <p className="text-sm text-muted">Ingenting her ennå. Kjør «pnpm gh-ingest &lt;mappe&gt;».</p>}
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {assets.map((a, i) => (
          <ArchiveRow
            key={a.manifest.id}
            a={a}
            entry={lastLogFor(log, a)}
            onSaved={onSaved}
            versions={versionsOf(index, a.manifest.slug, a.manifest.variant)}
            shareCounts={shareCounts}
            defaultExpanded={isSets}
            onPlay={(shown) => {
              // Eldre versjon: spill bare den. Nyeste: hele arkivet som kø, som før.
              const latest = shown === a;
              setQueue(latest ? assets : [shown], latest ? i : 0);
              playIndex(latest ? i : 0);
            }}
          />
        ))}
      </ul>
      {isSets && <SetDropZone onDone={onSaved} />}
    </div>
  );
}

/** Subtil Drag & Drop-sone under Live-sett som gjør det tomme rommet om til et aktivt verktøy. */
function SetDropZone({ onDone }: { onDone?: () => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => /\.(wav|wave|aif|aiff|flac|png|jpe?g|webp)$/i.test(f.name));
    if (!list.length) return setMsg({ ok: false, text: 'Bare WAV, AIFF, FLAC og cover-bilder støttes.' });
    setBusy(true);
    setMsg(null);
    try {
      for (const f of list) {
        const r = await fetch(`/api/drafts/import?name=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          headers: { 'X-GV-Import': '1', 'Content-Type': f.type || 'application/octet-stream' },
          body: f
        });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      setMsg({ ok: true, text: `${list.length} fil${list.length > 1 ? 'er' : ''} lagt til for ingest.` });
      onDone?.();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void upload(e.dataTransfer.files);
      }}
      className={`mt-2 flex min-h-[220px] flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed p-8 text-center transition-colors ${
        over ? 'border-accent/60 bg-accent/[0.06]' : 'border-white/[0.09] bg-surface/40 hover:border-white/[0.16] hover:bg-surface/65'
      }`}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sunken text-soft">
        <UploadIcon width={24} height={24} strokeWidth={1.7} />
      </span>
      <span className="text-sm font-semibold text-ink-strong">Slipp nye live-sett eller opptak her</span>
      <span className="max-w-md text-xs leading-relaxed text-soft">
        Dra inn lange WAV-, AIFF- eller FLAC-opptak (og valgfri <code className="font-mono text-ink">live_log.json</code> / cover) for automatisk kapittel- og tempodeteksjon.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="mt-1 h-9 rounded-full border border-white/15 bg-sunken/80 px-4 text-xs font-semibold text-soft transition-colors hover:border-accent/50 hover:text-ink-strong disabled:opacity-50"
      >
        {busy ? 'Laster opp …' : 'Velg opptaksfiler …'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept=".wav,.wave,.aif,.aiff,.flac,image/png,image/jpeg,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-label="Velg live-sett som skal importeres"
        onChange={(e) => e.target.files && void upload(e.target.files)}
      />
      {msg && <span className={`text-xs ${msg.ok ? 'text-accent' : 'text-[#FF8A7A]'}`}>{msg.text}</span>}
    </div>
  );
}

/**
 * Todelt Macro/Micro-bølgeform + synkronisert vertikal sporliste for Live-sett.
 * - Øverst: Macro ("Mini-map") for hele settet med synlig zoom-utsnitt.
 * - Nederst: Micro (innzoomet, horisontalt navigerbar bølgeform) med vertikale cue-linjer.
 * - Til høyre: utvidbar, synkronisert sporliste som fremhever aktivt kapittel under avspilling.
 */
function LiveSetNavigator({ a, onPlayAt }: { a: LoadedAsset; onPlayAt: (ms: number) => void }) {
  const m = a.manifest;
  const full = useFullAsset(a);
  const { queue, index, positionMs } = usePlayer();
  const isPlayingThis = queue[index]?.manifest.id === m.id;
  const currentMs = isPlayingThis ? positionMs : 0;
  const progress = m.durationMs > 0 ? Math.min(1, Math.max(0, currentMs / m.durationMs)) : 0;

  const [zoomCenter, setZoomCenter] = useState(0.2);
  const [tracklistOpen, setTracklistOpen] = useState(true);
  const windowSpan = 0.35; // 35 % av settet vises i Micro-visningen
  const effCenter = isPlayingThis ? progress : zoomCenter;
  const winStart = Math.max(0, Math.min(1 - windowSpan, effCenter - windowSpan / 2));
  const winEnd = Math.min(1, winStart + windowSpan);

  useEffect(() => {
    if (isPlayingThis) setZoomCenter(progress);
  }, [isPlayingThis, progress]);

  const rawPeaks = full.analysis?.peaks ?? [];
  const microSlice = useMemo(() => {
    if (!rawPeaks.length) return [];
    const s = Math.floor(winStart * rawPeaks.length);
    const e = Math.max(s + 8, Math.ceil(winEnd * rawPeaks.length));
    return downsample(rawPeaks.slice(s, e), 140).map((v) => Math.max(0.1, Math.pow(v, 0.8)));
  }, [rawPeaks, winStart, winEnd]);

  const cues = useMemo(
    () =>
      [...m.markers]
        .filter((k) => k.kind === 'chapter' || k.kind === 'highlight' || k.kind === 'drop')
        .sort((x, y) => x.startMs - y.startMs),
    [m.markers]
  );

  const activeCueIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < cues.length; i++) {
      if (currentMs >= cues[i]!.startMs) idx = i;
    }
    return idx;
  }, [cues, currentMs]);

  return (
    <div className="mt-1 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-3 rounded-xl bg-sunken/70 p-3.5">
        {/* 1. Macro Mini-map */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-soft">
            <span>Oversikt (Mini-map)</span>
            <span>
              Utsnitt {formatTime(winStart * m.durationMs)} – {formatTime(winEnd * m.durationMs)}
            </span>
          </div>
          <div
            className="relative cursor-pointer rounded-lg border border-white/[0.06] bg-obsidian px-2 py-1.5"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
              setZoomCenter(ratio);
              onPlayAt(ratio * m.durationMs);
            }}
          >
            <Waveform
              peaks={rawPeaks}
              bars={140}
              height={22}
              progress={progress}
              active
              markers={cues.map((c) => ({ pct: c.startMs / m.durationMs, label: c.label ?? 'CUE' }))}
            />
            {/* Fremhevet zoom-utsnitt på mini-map */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0.5 rounded border border-accent/70 bg-accent/[0.08]"
              style={{ left: `${winStart * 100}%`, width: `${(winEnd - winStart) * 100}%` }}
            />
          </div>
        </div>

        {/* 2. Micro (innzoomet bølgeform med vertikale cue-linjer) */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-soft">
            <span>Innzoomet bølgeform · klikk for presis spoling</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(effCenter * 100)}
                onChange={(e) => setZoomCenter(Number(e.target.value) / 100)}
                aria-label="Panorer i bølgeformen"
                className="gv-range w-28"
                style={{ ['--fill' as string]: `${effCenter * 100}%` }}
              />
            </div>
          </div>
          <div
            className="relative flex h-[64px] cursor-pointer items-center gap-[2px] overflow-hidden rounded-xl border border-white/[0.07] bg-obsidian px-2.5 pt-4"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const localRatio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
              const globalRatio = winStart + localRatio * (winEnd - winStart);
              onPlayAt(globalRatio * m.durationMs);
            }}
          >
            {microSlice.map((h, i) => {
              const globalBarRatio = winStart + ((i + 0.5) / microSlice.length) * (winEnd - winStart);
              const played = globalBarRatio <= progress;
              return (
                <span
                  key={i}
                  aria-hidden="true"
                  className="flex-1 rounded-[2px] transition-colors"
                  style={{ height: Math.round(h * 42), backgroundColor: played ? 'var(--accent)' : 'rgba(255,255,255,0.16)' }}
                />
              );
            })}
            {/* Vertikale cue-linjer direkte gjennom bølgeformen */}
            {cues.map((c) => {
              const pct = c.startMs / m.durationMs;
              if (pct < winStart || pct > winEnd) return null;
              const localPct = ((pct - winStart) / (winEnd - winStart)) * 100;
              return (
                <span key={`${c.label}-${c.startMs}`} aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `${localPct}%` }}>
                  <span className="absolute inset-y-0 -left-px w-[1.5px]" style={{ background: 'var(--accent)' }} />
                  <span
                    className="absolute top-1 -translate-x-1/2 whitespace-nowrap rounded bg-sunken/95 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-strong shadow"
                    style={{ border: '1px solid color-mix(in srgb, var(--accent) 60%, transparent)' }}
                  >
                    {formatTime(c.startMs)} · {c.label}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* 3. Interaktiv, synkronisert vertikal sporliste på høyre side */}
      {cues.length > 0 && (
        <div className={`flex flex-col rounded-xl bg-sunken/70 p-3 ${tracklistOpen ? 'w-full lg:w-[270px]' : 'w-auto'}`}>
          <button
            type="button"
            aria-expanded={tracklistOpen}
            onClick={() => setTracklistOpen((o) => !o)}
            className="flex items-center justify-between gap-2 text-left font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-soft hover:text-ink-strong"
          >
            <span>Sporliste ({cues.length})</span>
            <ChevronDownIcon width={14} height={14} className={`transition-transform ${tracklistOpen ? '' : '-rotate-90'}`} />
          </button>
          {tracklistOpen && (
            <ol className="gv-scroll m-0 mt-2.5 flex max-h-[150px] list-none flex-col gap-1 overflow-y-auto p-0">
              {cues.map((c, idx) => {
                const active = idx === activeCueIdx;
                return (
                  <li key={`${c.kind}-${c.startMs}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setZoomCenter(c.startMs / m.durationMs);
                        onPlayAt(c.startMs);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-all ${
                        active
                          ? 'gv-neon-soft border-accent/70 bg-accent/[0.15] font-semibold text-ink-strong backdrop-blur-md'
                          : c.confirmed
                            ? 'border-white/[0.06] bg-white/[0.03] text-ink hover:border-white/15 hover:bg-white/[0.06]'
                            : 'border-dashed border-white/15 bg-transparent text-soft hover:border-accent/45 hover:text-ink-strong'
                      }`}
                    >
                      <span className={`tabular font-mono text-[11px] ${active ? 'text-accent' : 'text-soft'}`}>{formatTime(c.startMs)}</span>
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {c.bpm && <span className="font-mono text-[11px] text-soft">{Math.round(c.bpm)}</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function ArchiveRow({
  a: latest,
  entry,
  onPlay,
  onSaved,
  versions,
  shareCounts,
  defaultExpanded = false
}: {
  a: LoadedAsset;
  entry?: IngestLogEntry;
  onPlay: (shown: LoadedAsset) => void;
  onSaved: () => void;
  versions: IndexEntry[];
  shareCounts: Record<string, number>;
  defaultExpanded?: boolean;
}) {
  // Versjonsvelger (del 9 pkt. 13): eldre versjoner blir liggende i media/ og kan åpnes og spilles her.
  const [picked, setPicked] = useState<number>(latest.manifest.version);
  const [older, setOlder] = useState<LoadedAsset | null>(null);
  useEffect(() => {
    if (picked === latest.manifest.version) return setOlder(null);
    const e = versions.find((v) => v.version === picked);
    if (e) void loadVersion(e).then(setOlder).catch(() => setOlder(null));
  }, [picked, latest, versions]);
  const a = older && older.manifest.version === picked ? older : latest;
  const m = a.manifest;
  // «Kildefil» (privat, data/sources.json) – vises bare her og i Info i spilleren.
  const [source, setSource] = useState<string | null>(null);
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
  const rowRef = useRef<HTMLLIElement>(null);
  const focused = typeof location !== 'undefined' && decodeURIComponent(location.hash) === `#arkiv/${latest.manifest.slug}`;
  const [expanded, setExpanded] = useState(defaultExpanded || focused || m.kind === 'set');
  useEffect(() => {
    if (focused) {
      setExpanded(true);
      rowRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [focused]);
  const [editing, setEditing] = useState(false);
  const [markersOpen, setMarkersOpen] = useState(false);
  const [coverDrag, setCoverDrag] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);

  const handleCoverDrop = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|avif|gif|tiff)$/i.test(file.type) && !/\.(jpe?g|png|webp|avif|gif|tiff?)$/i.test(file.name)) return;
    setCoverBusy(true);
    try {
      const manifests = await uploadAssetCover(m.slug, file);
      usePlayer.getState().refreshManifests(manifests);
      onSaved();
    } catch {
      /* feil ignoreres stille i raden eller logges */
    } finally {
      setCoverBusy(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  };

  // Chameleon-farge: bruker låtas unike palett på Play-knapp og bølgeform i Arkiv
  const skinId = useSkinId();
  const rowPalette = useMemo(() => chameleonPalette(m), [m, skinId]);
  const vars = useMemo(() => {
    const base = paletteToCssVars(rowPalette);
    base['--glow'] = withAlpha(rowPalette.primary, 0.38);
    base['--glow-2'] = withAlpha(rowPalette.secondary, 0.16);
    return base as CSSProperties;
  }, [rowPalette]);

  const chapters = m.markers.filter((k) => k.kind === 'chapter' || k.kind === 'highlight');
  const hasUnconfirmed = m.markers.some((k) => !k.confirmed);
  const isOpen = expanded || editing || markersOpen;

  return (
    <li
      id={`arkiv-${latest.manifest.slug}`}
      ref={rowRef}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!coverDrag) setCoverDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setCoverDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setCoverDrag(false);
        const f = [...e.dataTransfer.files].find((x) => /^image\//i.test(x.type) || /\.(jpe?g|png|webp|avif|gif|tiff?)$/i.test(x.name)) ?? e.dataTransfer.files[0];
        void handleCoverDrop(f);
      }}
      className={`flex flex-col gap-3 rounded-2xl border bg-surface px-4 py-3.5 transition-colors ${
        coverDrag
          ? 'border-accent ring-2 ring-accent/50'
          : focused
            ? 'border-accent/60 ring-1 ring-accent/40'
            : isOpen
              ? 'border-white/[0.11]'
              : 'border-white/[0.06] hover:border-white/[0.11]'
      }`}
      style={vars}
    >
      <div
        className="flex cursor-pointer flex-wrap items-center gap-3.5"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button,select,input,a,label')) return;
          setExpanded((o) => !o);
        }}
      >
        <button
          type="button"
          onClick={() => coverInput.current?.click()}
          title="Klikk eller slipp et bilde her for å bytte cover"
          aria-label={`Bytt cover for ${m.title}`}
          className="group relative flex-none overflow-hidden rounded-[10px]"
        >
          <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={rowPalette} title={m.title} size={52} rounded={10} />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[10px] bg-black/65 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <UploadIcon width={16} height={16} />
          </span>
          {coverBusy && <span className="absolute inset-0 flex items-center justify-center rounded-[10px] bg-black/75 text-[11px] font-semibold text-white">…</span>}
        </button>
        <input
          ref={coverInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="sr-only"
          tabIndex={-1}
          aria-label={`Velg cover for ${m.title}`}
          onChange={(e) => void handleCoverDrop(e.target.files?.[0])}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((o) => !o)}
              aria-expanded={isOpen}
              className="inline-flex items-center gap-1.5 text-left text-[15px] font-semibold text-ink-strong hover:text-accent"
            >
              <span>{m.title}</span>
              {m.variantLabel ? <span className="font-normal text-soft"> · {m.variantLabel}</span> : null}
              <DraftBadge m={m} className="ml-1" />
              <ChevronDownIcon width={14} height={14} className={`text-soft transition-transform ${isOpen ? '' : '-rotate-90'}`} />
            </button>
            {m.titleNeedsReview && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">{t.titleNeedsReview}</span>}
          </div>

          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-soft">
            <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-ink-strong">
              {versions.length > 1 ? (
                <label className="inline-flex items-center gap-1">
                  <span className="sr-only">Versjon av {m.title}</span>
                  <select value={picked} onChange={(e) => setPicked(Number(e.target.value))} className="bg-transparent font-mono text-[11px] text-ink-strong focus:outline-none">
                    {versions.map((v) => (
                      <option key={v.version} value={v.version} className="bg-sunken text-ink">
                        {versionName({ version: v.version, status: v.status })}
                        {v.version === latest.manifest.version ? ' (vises)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                versionName(m)
              )}
            </span>
            <span>{formatTime(m.durationMs)}</span>
            <span>·</span>
            <span className="text-ink-strong">{m.loudness.integratedLufs} LUFS</span>
            {m.bpm != null && (
              <>
                <span>·</span>
                <span>{Math.round(m.bpm)} BPM</span>
              </>
            )}
            <span>·</span>
            <span>{m.markers.length} markører</span>
            {m.venue ? (
              <>
                <span>·</span>
                <span className="text-ink">{m.venue}</span>
              </>
            ) : null}
            {source && (
              <>
                <span>·</span>
                <span className="text-muted">
                  Kildefil: <span className="text-soft">{source}</span>
                </span>
              </>
            )}
            {(() => {
              const n = shareCounts[`${m.slug}::${m.variant ?? 'main'}::v${m.version}`] ?? 0;
              return n > 0 ? (
                <>
                  <span>·</span>
                  <span className="text-accent">
                    Delt {n} {n === 1 ? 'gang' : 'ganger'}
                  </span>
                </>
              ) : null;
            })()}
          </div>
        </div>

        {/* Chameleon-fargeprikker (uten støyende hex-tekst) */}
        <span className="flex items-center gap-1.5 px-1" title="Sporets aksentpalett (endres via Rediger)">
          <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full ring-1 ring-white/15" style={{ background: rowPalette.primary, boxShadow: `0 0 8px ${rowPalette.primary}66` }} />
          <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full ring-1 ring-white/15" style={{ background: rowPalette.secondary }} />
        </span>

        {/* Rene ikonknapper for Markører og Rediger */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setMarkersOpen((o) => !o);
              setExpanded(true);
            }}
            aria-expanded={markersOpen}
            aria-label={markersOpen ? 'Lukk markører' : `Markører for ${m.title}`}
            title={markersOpen ? 'Lukk markører' : `Rediger markører (${m.markers.length})`}
            className={`relative flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
              markersOpen ? 'border-accent bg-accent/15 text-accent' : 'border-white/10 bg-sunken/70 text-soft hover:border-accent/50 hover:text-ink-strong'
            }`}
          >
            <PinMarkerIcon width={16} height={16} />
            {hasUnconfirmed && !markersOpen && <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing((e) => !e);
              setExpanded(true);
            }}
            aria-expanded={editing}
            aria-label={editing ? t.close : `${t.edit} ${m.title}`}
            title={editing ? t.close : `${t.edit} metadata, farge og tekst`}
            className={`flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
              editing ? 'border-accent bg-accent/15 text-accent' : 'border-white/10 bg-sunken/70 text-soft hover:border-accent/50 hover:text-ink-strong'
            }`}
          >
            <EditPencilIcon width={16} height={16} />
          </button>
          <MakeRelease a={a} onDone={onSaved} />
          <button
            type="button"
            onClick={() => onPlay(a)}
            aria-label={`Spill ${m.title} v${m.version}`}
            title={`Spill ${m.title}`}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_0_14px_var(--glow)] transition-transform hover:scale-105 active:scale-95"
          >
            <PlayIcon width={18} height={18} className="ml-0.5" />
          </button>
        </div>
      </div>

      <SunoNotice entry={entry} />

      {/* Redigering lagrer tilbake: bare fra det fulle manifestet (katalogen har et slankt et) */}
      {editing && (
        <FullAsset a={a}>
          {(full) => (
            <>
              <MetaEditor
                a={full}
                onDone={() => {
                  setEditing(false);
                  onSaved();
                }}
              />
              <AssetLook key={`${full.manifest.id}-${full.manifest.palette.primary}-${full.manifest.liveOffsetMs ?? 0}`} a={full} onSaved={onSaved} />
              <LyricsEditor a={full} />
            </>
          )}
        </FullAsset>
      )}

      {markersOpen && (
        <FullAsset a={a}>
          {(full) => (
            <MarkerEditor
              key={`${full.manifest.id}-${full.manifest.markers.map((k) => `${k.label}${k.startMs}${k.confirmed}`).join('|')}`}
              a={full}
              onSaved={onSaved}
              onPlayAt={(ms) => usePlayer.getState().playFrom([a], 0, ms)}
            />
          )}
        </FullAsset>
      )}

      {isOpen && !markersOpen && (
        m.kind === 'set' ? (
          <LiveSetNavigator a={a} onPlayAt={(ms) => usePlayer.getState().playFrom([a], 0, ms)} />
        ) : (
          <div className="mt-1 flex flex-col gap-3 pt-4">
            <div className="px-1 pt-2">
              <Waveform
                peaks={a.analysis?.peaks ?? []}
                bars={120}
                height={44}
                progress={0}
                active
                markers={m.markers.filter((k) => k.kind === 'drop').map((k) => ({ pct: k.startMs / m.durationMs, label: 'DROP' }))}
                onSeek={(r) => usePlayer.getState().playFrom([a], 0, r * m.durationMs)}
              />
            </div>
            {chapters.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                  {chapters.map((c) => (
                    <li key={`${c.kind}-${c.startMs}`}>
                      <button
                        type="button"
                        onClick={() => usePlayer.getState().playFrom([a], 0, c.startMs)}
                        title={c.confirmed ? `${c.label} (${formatTime(c.startMs)}) – bekreftet` : `${c.label} (${formatTime(c.startMs)}) – ubekreftet forslag`}
                        className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors ${
                          c.confirmed
                            ? 'border-accent/65 bg-accent/20 font-medium text-ink-strong hover:bg-accent/30'
                            : 'border-dashed border-accent/45 bg-sunken text-soft hover:border-accent hover:text-ink-strong'
                        }`}
                      >
                        <span className="tabular font-mono text-[11px] text-soft">{formatTime(c.startMs)}</span>
                        <span>{c.label}</span>
                      </button>
                    </li>
                  ))}
                </ol>
                {hasUnconfirmed && (
                  <span className="font-mono text-[11px] text-muted" title="Klikk flagg-ikonet for å bekrefte eller flytte markører">
                    Stiplet ramme = ubekreftet forslag
                  </span>
                )}
              </div>
            )}
          </div>
        )
      )}
    </li>
  );
}

/** Tittel, artist, album og variantnavn. Lagres i media/<slug>/meta.json; bare tags og manifest skrives på nytt. */
function MetaEditor({ a, onDone }: { a: LoadedAsset; onDone: () => void }) {
  const m = a.manifest;
  const [title, setTitle] = useState(m.title);
  const [artist, setArtist] = useState(m.artist ?? '');
  const [album, setAlbum] = useState(m.album && m.album !== m.title ? m.album : '');
  const [variantLabel, setVariantLabel] = useState(m.variantLabel ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `meta-${m.id}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveAssetMeta(m.slug, { title, artist, album, ...(m.variant ? { variants: { [m.variant]: variantLabel } } : {}) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field = 'min-h-11 w-full rounded-xl border border-white/10 bg-sunken px-3 text-sm text-ink focus:border-accent/60 focus:outline-none';
  return (
    <form onSubmit={submit} className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 rounded-xl border border-white/[0.08] bg-sunken/60 p-3">
      <label className="flex flex-col gap-1 text-[11px] text-muted" htmlFor={`${id}-title`}>
        {t.fieldTitle}
        <input id={`${id}-title`} className={field} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted" htmlFor={`${id}-artist`}>
        {t.fieldArtist}
        <input id={`${id}-artist`} className={field} value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={200} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted" htmlFor={`${id}-album`}>
        {t.fieldAlbum}
        <input id={`${id}-album`} className={field} value={album} placeholder={t.albumPlaceholder} onChange={(e) => setAlbum(e.target.value)} maxLength={200} />
      </label>
      {m.variant && (
        <label className="flex flex-col gap-1 text-[11px] text-muted" htmlFor={`${id}-variant`}>
          {t.fieldVariant}
          <input id={`${id}-variant`} className={field} value={variantLabel} onChange={(e) => setVariantLabel(e.target.value)} maxLength={200} />
        </label>
      )}
      <div className="col-span-full flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-60">
          {busy ? t.saving : t.save}
        </button>
        <span className="text-[11px] text-muted">{t.saveHint}</span>
        {error && (
          <span role="alert" className="text-[12px] text-[#F2A08F]">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- Mini-spiller (admin)

function MiniPlayer() {
  const { queue, index, playing, positionMs, toggle, seek } = usePlayer();
  const a = queue[index];
  if (!a) return null;
  const m = a.manifest;
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 bg-sunken/95 px-6 py-3 backdrop-blur" style={skinTrackVars(m.palette) as CSSProperties}>
      <div className="mx-auto flex max-w-[1400px] items-center gap-4">
        <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={44} rounded={8} />
        <div className="flex w-48 min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{m.title}</span>
          <span className="tabular text-[11px] text-muted">
            {formatTime(positionMs)} / {formatTime(m.durationMs)}
          </span>
        </div>
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Spill'} className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-on-accent">
          {playing ? <PauseIcon width={18} height={18} /> : <PlayIcon width={18} height={18} className="ml-0.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <Waveform peaks={a.analysis?.peaks ?? []} bars={140} height={36} progress={positionMs / m.durationMs} active onSeek={(r) => seek(r * m.durationMs)} label="Spol" />
        </div>
      </div>
    </div>
  );
}
