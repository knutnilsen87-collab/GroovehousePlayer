import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { computeCoverage, formatTime, paletteToCssVars, type AccessTier, type AssetManifest } from '@gv/shared/web';
import { Logo } from '../components/Brand';
import { CoverArt } from '../components/CoverArt';
import { ArchiveIcon, DropsIcon, LinkIcon, PauseIcon, PlayIcon, PlusIcon, PulseIcon, StudioIcon, UploadIcon } from '../components/Icons';
import { AssetLook } from '../components/AssetLook';
import { LyricsEditor } from '../components/LyricsEditor';
import { loadPlaybackSettings } from '../lib/settings';
import { SettingsView } from './Settings';
import { Waveform } from '../components/Waveform';
import { assetUrl, downsample, findMain, lastLogFor, loadVersion, saveAssetMeta, useCatalog, useIngestLog, versionsOf, type IndexEntry, type IngestLogEntry, type LoadedAsset } from '../lib/catalog';
import { admin as t } from '../lib/i18n';
import { usePlayer } from '../lib/player';
import { SEED_DROPS, type SeedDrop, type SeedRecipient } from '../lib/seed';

type View = 'drops' | 'archive' | 'sets' | 'mobile' | 'settings';

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
    typeof location === 'undefined' ? 'drops' : location.pathname.startsWith('/studio/innstillinger') ? 'settings' : location.hash === '#mobil' ? 'mobile' : location.hash.startsWith('#arkiv') ? 'archive' : 'drops'
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
          <DropsView assets={assets} log={log} />
        ) : view === 'mobile' ? (
          <MobileView />
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
    { id: 'mobile', label: t.mobile, Icon: LinkIcon },
    { id: 'settings', label: 'Innstillinger', Icon: StudioIcon }
  ];
  return (
    <aside className="flex max-w-[260px] flex-[1_1_220px] flex-col gap-7 border-r border-white/[0.06] bg-sunken px-[18px] py-6">
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
      <div className="mt-auto flex flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-surface p-3.5">
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
        <div className="flex flex-col gap-2 rounded-2xl border border-white/[0.06] bg-surface p-5 text-sm">
          <p className="m-0 font-semibold">{t.mobileOff}</p>
          <p className="m-0 text-muted">
            Kjør <code className="text-ink">pnpm vault:lan on</code> i prosjektmappa. Du velger en PIN, og Windows spør om brannmurregel for private nettverk.
          </p>
        </div>
      )}
      {status && status !== 'unavailable' && status.enabled && (
        <div className="flex flex-wrap items-start gap-6 rounded-2xl border border-white/[0.06] bg-surface p-5">
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

function DropsView({ assets, log }: { assets: LoadedAsset[]; log: IngestLogEntry[] }) {
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

      <IngestStrip assets={assets} log={log} />

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

function IngestStrip({ assets, log }: { assets: LoadedAsset[]; log: IngestLogEntry[] }) {
  const recent = [...assets].sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt)).slice(0, 2);
  return (
    <section aria-label="Ingest" className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
      <div className="flex min-h-32 flex-col items-center justify-center gap-1.5 rounded-2xl border-[1.5px] border-dashed border-accent/35 bg-accent/[0.03] p-4 text-center">
        <UploadIcon width={26} height={26} className="text-accent" strokeWidth={1.8} />
        <span className="text-sm font-semibold">{t.dropzone}</span>
        <span className="text-xs text-muted">{t.dropzoneHint}</span>
      </div>
      {recent.map((a) => (
        <IngestCard key={a.manifest.id} a={a} entry={lastLogFor(log, a)} />
      ))}
    </section>
  );
}

function IngestCard({ a, entry }: { a: LoadedAsset; entry?: IngestLogEntry }) {
  const m = a.manifest;
  const steps = pipelineSteps(m);
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-white/[0.06] bg-surface px-[18px] py-4">
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={36} rounded={8} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold">
              {m.title}
              {m.variantLabel ? ` (${m.variantLabel})` : ''}
            </span>
            <span className="text-[11px] text-muted">
              {m.kind} · v{m.version} · {formatTime(m.durationMs)}
            </span>
          </div>
        </div>
        <span className="text-[11px] font-semibold tracking-[1px] text-accent">KLAR</span>
      </div>
      <SunoNotice entry={entry} />
      {m.titleNeedsReview && <p className="m-0 text-[11px] text-accent">{t.titleNeedsReview}</p>}
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {steps.map((s) => (
          <li key={s.label} className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium ${s.ok ? 'bg-accent/10 text-accent' : 'bg-white/[0.06] text-[#C9C4B6]'}`}>
            {s.ok ? '✓' : '!'} {s.label}
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
    { label: m.palette.source === 'cover' ? 'Palett' : 'Palett (gull – mangler cover)', ok: m.palette.source === 'cover' },
    { label: `${m.loudness.integratedLufs} LUFS`, ok: true },
    { label: 'Preview 30 s', ok: !!m.files.preview },
    { label: `${m.markers.length} markører`, ok: true },
    { label: 'Master til R2 (fase 2)', ok: false }
  ];
}

const TIER_STYLE: Record<AccessTier, string> = {
  inner: 'border-accent text-accent',
  partner: 'border-accent/45 text-accent',
  supporter: 'border-white/20 text-[#C9C4B6]',
  teaser: 'border-white/20 text-muted'
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
      className={`flex items-center gap-3 rounded-[14px] border bg-surface p-3.5 text-left ${selected ? 'border-accent/55' : 'border-white/[0.06] hover:border-white/15'}`}
    >
      {first ? (
        <CoverArt src={assetUrl(first, first.manifest.files.coverThumb)} palette={first.manifest.palette} title={first.manifest.title} size={44} rounded={9} />
      ) : (
        <span className="h-11 w-11 rounded-[9px] bg-white/5" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-ink-strong">{drop.title}</span>
        <span className="text-[11px] text-muted">{meta}</span>
      </span>
      <span className={`rounded-md border px-2 py-1 text-[10px] font-semibold tracking-[1.2px] ${TIER_STYLE[drop.tier]}`}>{drop.tier.toUpperCase()}</span>
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
      <div className="min-w-0 flex-[999_1_520px] rounded-[18px] border border-white/[0.06] bg-surface p-6 text-sm text-muted">
        Ingen av assetene i denne dropen er ingestet ennå. Kjør <code className="text-ink">pnpm gh-ingest fixtures/{drop.assetSlugs[0]}</code>.
      </div>
    );
  }
  const m = asset.manifest;
  const vars = paletteToCssVars(m.palette) as CSSProperties;
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
    <div className="relative min-w-0 flex-[999_1_520px] overflow-hidden rounded-[18px] border border-white/[0.06] bg-surface p-[22px]" style={vars}>
      <div aria-hidden="true" className="pointer-events-none absolute -right-[120px] -top-[160px] h-[420px] w-[420px] rounded-full" style={{ background: 'radial-gradient(circle, var(--glow) 0%, var(--glow-2) 45%, transparent 70%)', opacity: 0.45 }} />

      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <CoverArt src={assetUrl(asset, m.files.coverThumb)} palette={m.palette} title={m.title} size={72} rounded={12} />
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold tracking-[2px] text-accent">{drop.tier.toUpperCase()}-DROP</span>
            <h2 className="m-0 font-display text-[26px] font-semibold uppercase tracking-[1px] text-ink-strong">{drop.title}</h2>
            <span className="text-xs text-muted">
              {dropAssets.length} assets · {drop.recipients.length} mottakere · maks {drop.maxDevices} enheter per lenke
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/drop/${drop.slug}${recipient ? `?r=${encodeURIComponent(recipient.name)}` : ''}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center rounded-full border border-white/[0.12] px-4 text-[13px] text-ink no-underline hover:border-white/25">
            Åpne lyttervisning
          </a>
          <button type="button" onClick={copy} disabled={!recipient} className="flex min-h-11 items-center gap-1.5 rounded-full border border-accent/45 px-4 text-[13px] font-semibold text-accent disabled:opacity-50">
            <LinkIcon width={15} height={15} />
            {copied ? t.copied : t.copyLink}
          </button>
          <button type="button" disabled title={t.phase2} className="flex min-h-11 items-center rounded-full border border-white/[0.12] px-4 text-[13px] text-ink disabled:opacity-50">
            {t.addRecipient}
          </button>
          <button type="button" disabled title={t.phase2} className="flex min-h-11 items-center rounded-full border border-white/[0.12] px-4 text-[13px] text-ink disabled:opacity-50">
            {t.revoke}
          </button>
        </div>
      </div>

      {dropAssets.length > 1 && (
        <div role="tablist" aria-label="Asset" className="relative mt-5 flex flex-wrap gap-1.5">
          {dropAssets.map((a) => (
            <button
              key={a.manifest.slug}
              type="button"
              role="tab"
              aria-selected={a.manifest.slug === m.slug}
              onClick={() => setAssetSlug(a.manifest.slug)}
              className={`h-8 rounded-full px-3 text-xs ${a.manifest.slug === m.slug ? 'bg-white/10 text-ink-strong' : 'text-muted hover:text-ink'}`}
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
                <tr className="text-left text-[10px] tracking-[1.5px] text-muted">
                  <th scope="col" className="pb-2.5 pr-2.5 font-semibold">{t.recipient.toUpperCase()}</th>
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
            <p className="mt-2.5 text-[11px] text-muted">Gul strek = DROP-markør. Sterk farge = spilt flere ganger. Beregnet fra listen_events med computeCoverage().</p>
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
  const status =
    events.length === 0
      ? { text: 'Ikke åpnet', cls: 'text-muted' }
      : cov.finished
        ? { text: 'Lyttet ferdig', cls: 'text-accent' }
        : { text: `Falt av ${formatTime(cov.stoppedAtMs ?? 0)}`, cls: 'text-ink' };
  const overLimit = r.devices > maxDevices;

  return (
    <tr className={`border-t border-white/[0.06] ${selected ? 'bg-accent/[0.05]' : ''}`}>
      <td className="pr-2.5">
        <button type="button" aria-pressed={selected} onClick={onSelect} className="flex min-h-14 w-full flex-col justify-center rounded-lg px-2 text-left hover:bg-white/[0.04]">
          <span className="font-semibold text-ink-strong">{r.name}</span>
          <span className="text-[11px] text-muted">{r.org}</span>
        </button>
      </td>
      <td className="tabular px-2.5 text-[#C9C4B6]">{opens ? `${opens}×` : '—'}</td>
      <td className="px-2.5">
        <div className="relative flex h-[30px] w-[300px] items-center gap-[2px]" aria-label={`Hørt ${Math.round(cov.heardRatio * 100)} %`} role="img">
          {heights.map((h, i) => {
            const plays = cov.plays[i] ?? 0;
            const bg = plays >= 2 ? 'var(--accent)' : plays === 1 ? 'color-mix(in srgb, var(--accent) 55%, transparent)' : 'rgba(255,255,255,0.12)';
            return <span key={i} aria-hidden="true" className="flex-1 rounded-[1.5px]" style={{ height: Math.max(4, Math.round(h * 28)), backgroundColor: bg }} />;
          })}
          {dropMs !== null && (
            <span aria-hidden="true" className="absolute -bottom-0.5 -top-0.5 w-px bg-accent/60" style={{ left: `${(dropMs / m.durationMs) * 100}%` }} />
          )}
        </div>
      </td>
      <td className={`whitespace-nowrap px-2.5 font-medium ${status.cls}`}>{status.text}</td>
      <td className={`whitespace-nowrap pl-2.5 ${overLimit ? 'text-accent' : 'text-[#C9C4B6]'}`}>
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
    <div className="relative mt-5 flex flex-col gap-3 rounded-[14px] border border-white/[0.06] bg-sunken p-[18px]">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="m-0 text-[15px] font-semibold text-ink-strong">
          {t.listenLog} · {r.name} · {r.org}
        </h3>
        <span className="text-xs text-muted">{r.device}</span>
      </div>
      {lines.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">Ingen aktivitet ennå. Lenken er sendt.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {lines.map((l, i) => (
            <li key={i} className="flex items-baseline gap-3.5">
              <span className="tabular w-[52px] flex-none text-xs text-muted">{l.at}</span>
              <span aria-hidden="true" className="h-2 w-2 flex-none -translate-y-px rounded-full" style={{ background: l.accent ? 'var(--accent)' : 'rgba(255,255,255,0.35)' }} />
              <span className="text-[13px]">{l.text}</span>
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

function ArchiveView({ assets, title, log, onSaved, index }: { assets: LoadedAsset[]; title: string; log: IngestLogEntry[]; onSaved: () => void; index: IndexEntry[] }) {
  const { setQueue, playIndex } = usePlayer();
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
      <h1 className="m-0 font-display text-[34px] font-semibold uppercase tracking-[1.5px] text-ink-strong">{title}</h1>
      {assets.length === 0 && <p className="text-sm text-muted">Ingenting her ennå. Kjør «pnpm gh-ingest &lt;mappe&gt;».</p>}
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {assets.map((a, i) => (
          <ArchiveRow
            key={a.manifest.id}
            a={a}
            entry={lastLogFor(log, a)}
            onSaved={onSaved}
            versions={versionsOf(index, a.manifest.slug, a.manifest.variant)}
            shareCounts={shareCounts}
            onPlay={(shown) => {
              // Eldre versjon: spill bare den. Nyeste: hele arkivet som kø, som før.
              const latest = shown === a;
              setQueue(latest ? assets : [shown], latest ? i : 0);
              playIndex(latest ? i : 0);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function ArchiveRow({ a: latest, entry, onPlay, onSaved, versions, shareCounts }: { a: LoadedAsset; entry?: IngestLogEntry; onPlay: (shown: LoadedAsset) => void; onSaved: () => void; versions: IndexEntry[]; shareCounts: Record<string, number> }) {
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
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const [editing, setEditing] = useState(false);
  const vars = paletteToCssVars(m.palette) as CSSProperties;
  const chapters = m.markers.filter((k) => k.kind === 'chapter' || k.kind === 'highlight');
  return (
    <li id={`arkiv-${latest.manifest.slug}`} ref={rowRef} className={`flex flex-col gap-3 rounded-2xl border bg-surface p-4 ${focused ? 'border-accent/60 ring-1 ring-accent/40' : 'border-white/[0.06]'}`} style={vars}>
      <div className="flex flex-wrap items-center gap-4">
        <CoverArt src={assetUrl(a, m.files.coverThumb)} palette={m.palette} title={m.title} size={56} rounded={10} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold text-ink-strong">
            {m.title}
            {m.variantLabel ? <span className="font-normal text-muted"> · {m.variantLabel}</span> : null}
          </span>
          <span className="text-xs text-[#C9C4B6]">{[m.artist, m.album && m.album !== m.title ? m.album : null, m.copyright].filter(Boolean).join(' · ')}</span>
          {m.titleNeedsReview && <span className="text-[11px] text-accent">{t.titleNeedsReview}</span>}
          {source && <span className="text-[11px] text-muted">Kildefil: <span className="text-[#C9C4B6]">{source}</span></span>}
          {(() => {
            const n = shareCounts[`${m.slug}::${m.variant ?? 'main'}::v${m.version}`] ?? 0;
            return n > 0 ? <span className="text-[11px] text-muted">Delt {n} {n === 1 ? 'gang' : 'ganger'}</span> : null;
          })()}
          <span className="text-xs text-muted">
            {m.kind} ·{' '}
            {versions.length > 1 ? (
              <label className="inline-flex items-center gap-1">
                <span className="sr-only">Versjon av {m.title}</span>
                <select value={picked} onChange={(e) => setPicked(Number(e.target.value))} className="rounded border border-white/15 bg-sunken px-1 text-xs text-soft focus:outline-none">
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                      {v.version === latest.manifest.version ? ' (nyeste)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              `v${m.version}`
            )}{' '}
            · {formatTime(m.durationMs)} · {m.loudness.integratedLufs} LUFS · {m.markers.length} markører
            {m.venue ? ` · ${m.venue}` : ''}
          </span>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full" style={{ background: m.palette.primary }} />
          <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full" style={{ background: m.palette.secondary }} />
          {m.palette.source === 'fallback' ? 'gull (fallback)' : `${m.palette.primary}${m.palette.source === 'manual' ? ' (valgt)' : ''}`}
        </span>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          aria-expanded={editing}
          className="min-h-11 rounded-full border border-white/15 px-4 text-xs font-semibold text-ink hover:border-accent/50"
        >
          {editing ? t.close : t.edit}
        </button>
        <button type="button" onClick={() => onPlay(a)} aria-label={`Spill ${m.title} v${m.version}`} className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-on-accent">
          <PlayIcon width={18} height={18} className="ml-0.5" />
        </button>
      </div>
      <SunoNotice entry={entry} />
      {editing && (
        <>
          <MetaEditor
            a={a}
            onDone={() => {
              setEditing(false);
              onSaved();
            }}
          />
          <AssetLook key={`${m.id}-${m.palette.primary}-${m.liveOffsetMs ?? 0}`} a={a} onSaved={onSaved} />
          <LyricsEditor a={a} />
        </>
      )}
      <Waveform peaks={a.analysis?.peaks ?? []} bars={120} height={40} progress={0} active markers={m.markers.filter((k) => k.kind === 'drop').map((k) => ({ pct: k.startMs / m.durationMs, label: 'DROP' }))} />
      {chapters.length > 0 && (
        <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {chapters.map((c) => (
            <li key={`${c.kind}-${c.startMs}`} className="flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-[11px]">
              <span className="tabular text-muted">{formatTime(c.startMs)}</span>
              {c.label}
              {!c.confirmed && <span className="text-accent">· ubekreftet</span>}
            </li>
          ))}
        </ol>
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
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-white/[0.08] bg-sunken/95 px-6 py-3 backdrop-blur" style={paletteToCssVars(m.palette) as CSSProperties}>
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
