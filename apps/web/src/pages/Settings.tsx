import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SkinPicker } from '../components/SkinPicker';
import { settingsApi, type Editable, type IngestRule, type PreviewRow, type SettingsState, type Tier } from '../lib/settings';

/**
 * Del 8: /studio/innstillinger. Alt valideres på serveren før lagring; config skrives atomisk med backup.
 * Ingen hemmeligheter vises her (PIN kan bare settes, aldri leses).
 */
export function SettingsView() {
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<Editable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await settingsApi.get();
      setState(s);
      setDraft(s.settings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // «Velg eksportmappe» (del 27): rett til feltet, med fokus i det
  const loaded = !!state;
  useEffect(() => {
    if (!loaded || location.hash !== '#eksport') return;
    const el = document.getElementById('eksport');
    el?.scrollIntoView({ block: 'start' });
    el?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [loaded]);

  if (error && !state) return <p role="alert" className="text-[#F2A08F]">Kunne ikke hente innstillingene: {error}</p>;
  if (!state || !draft) return <p className="text-muted">Henter innstillinger…</p>;

  const ALL_KEYS: Array<keyof Editable> = ['exportDir', 'draftDirs', 'ingest', 'lyrics', 'covers', 'audio', 'defaults', 'titleCleanup', 'colors', 'drops'];
  const dirty = (k: keyof Editable) => JSON.stringify(draft[k]) !== JSON.stringify(state.settings[k]);
  const dirtyKeys = ALL_KEYS.filter(dirty);
  const hasUnsaved = dirtyKeys.length > 0;

  const save = async (keys: Array<keyof Editable>, ok: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const patch: Partial<Editable> = {};
      for (const k of keys) (patch as Record<string, unknown>)[k] = draft[k];
      const r = await settingsApi.save(patch);
      setState({ ...state, settings: r.settings, watcher: r.watcher });
      setDraft(r.settings);
      setNotice(r.restarted.includes('watcher') ? `${ok} Watcheren er startet på nytt med den nye mappa.` : ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const saveAll = () => {
    if (!dirtyKeys.length) return;
    void save(dirtyKeys, 'Endringene er lagret.');
  };
  const resetAll = () => {
    setDraft(state.settings);
    setError(null);
  };
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setDraft({ ...draft, [k]: v });
  const lufsFill = `${((draft.audio.targetLufs - -16) / (-11 - -16)) * 100}%`;

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-7 pb-28">
      <header className="flex flex-col gap-1.5">
        <h1 className="m-0 text-2xl font-bold tracking-tight text-ink-strong sm:text-[28px]">Innstillinger</h1>
        <p className="m-0 text-sm leading-relaxed text-soft">
          Lagres i <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-ink-strong">groovehouse.config.json</code> (forrige versjon i{' '}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-ink-strong">groovehouse.config.backup.json</code>). Eksportmappa lagres bare på denne PC-en.
        </p>
      </header>
      <Section title="Utseende" hint="Velg skin. Byttet skjer med en gang og lagres på denne enheten, så PC og telefon kan ha ulike skins.">
        <SkinPicker />
      </Section>
      <div aria-live="polite" className="sticky top-2 z-20 empty:hidden">
        {error && (
          <p role="alert" className="m-0 rounded-xl border border-[#F2A08F]/40 bg-[#2A1512]/95 px-4 py-3 text-sm text-[#F2A08F] shadow-lg backdrop-blur-md">
            {error}
          </p>
        )}
        {notice && (
          <p className="m-0 flex items-center justify-between gap-3 rounded-xl border border-accent/40 bg-surface/95 px-4 py-3 text-sm text-ink-strong shadow-lg backdrop-blur-md">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="text-xs text-soft hover:text-ink-strong">
              Lukk
            </button>
          </p>
        )}
      </div>

      <ExportSection state={state} draft={draft} set={set} busy={busy} dirty={dirty('exportDir') || dirty('draftDirs')} onSave={() => save(['exportDir', 'draftDirs'], 'Mappene er lagret.')} onReload={load} />
      <RulesSection draft={draft} set={set} />
      <Section
        title="Lyd"
        hint="Gjelder i spilleren med en gang (også låter som alt er ingestet)."
        right={
          JSON.stringify(draft.audio) !== JSON.stringify(state.defaults.audio) ? (
            <button type="button" disabled={busy} onClick={() => set('audio', state.defaults.audio)} className={ghostBtn}>
              Standard (−14 LUFS)
            </button>
          ) : undefined
        }
      >
        <label className="flex flex-col gap-2.5 text-xs font-medium text-soft">
          Målnivå for avspilling
          <span className="flex flex-wrap items-center gap-4">
            <input
              type="range"
              min={-16}
              max={-11}
              step={0.5}
              value={draft.audio.targetLufs}
              onChange={(e) => set('audio', { targetLufs: Number(e.target.value) })}
              className="gv-range w-64"
              style={{ ['--fill' as string]: lufsFill }}
              aria-label="Målnivå i LUFS"
            />
            <span className="tabular rounded-lg bg-sunken px-2.5 py-1 font-mono text-sm font-semibold text-ink-strong">{draft.audio.targetLufs} LUFS</span>
          </span>
        </label>
        <p className="m-0 text-xs leading-relaxed text-soft">
          Spilleren kan bare dempe, ikke løfte. Et høyere mål gjør derfor ikke stille skisser høyere – bare at høye låter dempes mindre. Standard <span className="font-mono text-ink-strong">−14 LUFS</span>.
        </p>
        <p className="m-0 font-mono text-xs text-muted">HLS: {state.server.hls} (info, ikke en innstilling).</p>
      </Section>
      <LyricsSection draft={draft} set={set} />
      <CoverSection draft={draft} set={set} />
      <MetadataSection draft={draft} set={set} />
      <ColorsSection draft={draft} set={set} busy={busy} dirty={dirty('colors')} />
      <AccessSection state={state} onChanged={load} />
      <Section
        title="Standarder for drops"
        hint="Standardverdier når du oppretter delingslenker (del 13)."
        right={
          JSON.stringify(draft.drops) !== JSON.stringify(state.defaults.drops) ? (
            <button type="button" disabled={busy} onClick={() => set('drops', state.defaults.drops)} className={ghostBtn}>
              Standard
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-end gap-5">
          <label className="flex w-48 flex-col gap-1.5 text-xs font-medium text-soft">
            Standard nivå
            <select value={draft.drops.tier} onChange={(e) => set('drops', { ...draft.drops, tier: e.target.value as Tier })} className={field}>
              <option value="partner">Partner</option>
              <option value="inner_circle">Inner circle</option>
              <option value="supporter">Supporter</option>
              <option value="teaser">Teaser</option>
            </select>
          </label>
          <NumberField label="Levetid (dager)" value={draft.drops.ttlDays} min={1} max={365} onChange={(v) => set('drops', { ...draft.drops, ttlDays: v })} />
          <NumberField label="Maks enheter per lenke" value={draft.drops.maxDevices} min={1} max={10} onChange={(v) => set('drops', { ...draft.drops, maxDevices: v })} />
          <Toggle label="Vannmerke som standard" checked={draft.drops.watermark} onChange={(v) => set('drops', { ...draft.drops, watermark: v })} />
        </div>
      </Section>
      <Devices app={state.app} />
      {state.cloudSync && (
        <section role="alert" aria-label="Skysynkronisering" className="rounded-2xl border border-[#FF6B5A]/50 bg-[#FF6B5A]/[0.06] p-6 sm:p-8">
          <h2 className="m-0 text-base font-semibold text-[#FFB4A8]">Prosjektmappa synkroniseres av {state.cloudSync.provider}</h2>
          <pre className="m-0 mt-2 whitespace-pre-wrap font-mono text-xs text-soft">{state.cloudSync.warning}</pre>
        </section>
      )}
      <Section title="Server" hint={`Port ${state.server.port} · prosess ${state.server.pid}`}>
        <RestartServer />
      </Section>

      {hasUnsaved && (
        <div
          role="region"
          aria-label="Ulagrede endringer"
          className="fixed inset-x-4 bottom-5 z-40 mx-auto flex max-w-[720px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent/50 bg-surface/95 px-5 py-3.5 shadow-[0_20px_50px_rgba(0,0,0,0.75)] backdrop-blur-xl"
        >
          <div className="flex items-center gap-2.5 text-sm font-medium text-ink-strong">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" />
            <span>Du har ulagrede endringer ({dirtyKeys.length})</span>
          </div>
          <div className="flex items-center gap-2.5">
            <button type="button" disabled={busy} onClick={resetAll} className={ghostBtn}>
              Tilbakestill
            </button>
            <button type="button" disabled={busy} onClick={saveAll} className={primaryBtn}>
              {busy ? 'Lagrer…' : 'Lagre endringer'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const field = 'min-h-11 w-full rounded-xl border border-white/10 bg-sunken px-3 text-sm text-ink focus:border-accent/60 focus:outline-none';
const primaryBtn = 'min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50';
const ghostBtn = 'min-h-11 rounded-full border border-white/15 px-4 text-xs font-semibold text-ink hover:border-accent/50 disabled:opacity-50';

/** Del 15: tilkoblede enheter, hvilken app- og bunt-versjon de kjører, og hva som er nyeste. */
interface DeviceRow {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  client?: { versionCode: number; bundle: number | null; seenAt: string };
}
function Devices({ app }: { app: SettingsState['app'] }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    fetch('/api/devices', { cache: 'no-store' })
      .then(async (r) => (r.ok ? setDevices(((await r.json()) as { devices: DeviceRow[] }).devices) : setErr(`HTTP ${r.status}`)))
      .catch((e: unknown) => setErr(String(e)));
  useEffect(() => {
    void load();
  }, []);
  const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' }) : '–');
  const active = (devices ?? []).filter((d) => !d.revokedAt);
  return (
    <Section title="Enheter" hint="Android-appen oppdaterer seg selv fra denne PC-en (pnpm android:release). Grensesnittet kommer ved neste oppstart av appen; ny native kode gir «Oppdater» i appen.">
      <p className="m-0 font-mono text-xs text-soft">
        Nyeste: app {app.apk ? `${app.apk.versionName} (${app.apk.versionCode})` : 'ikke publisert'} · bunt {app.bundle ? `${app.bundle.version} (krever app ≥ ${app.bundle.minNative})` : 'ikke publisert'}
      </p>
      {err && <p className="m-0 text-xs text-[#FF8A7A]">Fikk ikke hentet enhetene: {err}</p>}
      {devices && active.length === 0 && <p className="m-0 text-sm text-muted">Ingen paret enhet ennå. Åpne appen på telefonen og koble til med adresse og PIN.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {active.map((d) => {
          const c = d.client;
          const appOld = !!(c && app.apk && c.versionCode < app.apk.versionCode);
          const bundleOld = !!(c && app.bundle && (c.bundle ?? 0) < app.bundle.version && c.versionCode >= app.bundle.minNative);
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-white/[0.02] px-3 py-2 text-sm">
              <span className="min-w-[140px] flex-1 font-semibold text-ink-strong">{d.name}</span>
              <span className="font-mono text-xs text-soft">
                {c ? (
                  <>
                    app {c.versionCode}
                    {appOld && <span className="text-accent"> → {app.apk!.versionCode}</span>} · bunt {c.bundle ?? 'innebygd'}
                    {bundleOld && <span className="text-accent"> → {app.bundle!.version}</span>}
                  </>
                ) : (
                  'versjon ikke meldt ennå (eldre app)'
                )}
              </span>
              <span className="text-xs text-muted">sist sett {fmt(c?.seenAt ?? d.lastSeenAt)}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Section({ title, hint, right, children, id }: { title: string; hint?: string; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="flex scroll-mt-4 flex-col gap-4 rounded-2xl bg-surface p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-base font-semibold text-ink-strong">{title}</h2>
          {hint && <p className="m-0 text-xs leading-relaxed text-soft">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <label className="flex max-w-[180px] flex-col gap-1.5 text-xs font-medium text-soft">
      {label}
      <span className="inline-flex h-11 items-center overflow-hidden rounded-xl border border-transparent bg-sunken focus-within:border-accent/60">
        <button
          type="button"
          aria-label={`Reduser ${label}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - step))}
          className="flex h-full w-10 flex-none items-center justify-center font-mono text-base text-soft transition-colors hover:bg-white/[0.05] hover:text-ink-strong disabled:opacity-30"
        >
          −
        </button>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-full w-16 border-x border-white/[0.06] bg-transparent text-center font-mono text-sm font-semibold text-ink-strong focus:outline-none"
        />
        <button
          type="button"
          aria-label={`Øk ${label}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + step))}
          className="flex h-full w-10 flex-none items-center justify-center font-mono text-base text-soft transition-colors hover:bg-white/[0.05] hover:text-ink-strong disabled:opacity-30"
        >
          +
        </button>
      </span>
    </label>
  );
}

function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />
      {label}
    </label>
  );
}

function ExportSection({ state, draft, set, busy, dirty, onSave, onReload }: { state: SettingsState; draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void; busy: boolean; dirty: boolean; onSave: () => void; onReload: () => void }) {
  const [check, setCheck] = useState<{ ok: boolean; error?: string; audioFiles?: number; many?: boolean } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const w = state.watcher;
  useEffect(() => {
    setCheck(null);
    if (!dirty || !draft.exportDir) return;
    const t = setTimeout(() => {
      void settingsApi
        .checkDir(draft.exportDir!)
        .then(setCheck)
        .catch(() => setCheck(null));
    }, 400);
    return () => clearTimeout(t);
  }, [draft.exportDir, dirty]);
  return (
    <Section id="eksport" title="Eksport og watcher" hint="Mappa Reason bouncer til. Vault leser bare – ingenting flyttes eller slettes der.">
      <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
        Eksportmappe
        <input value={draft.exportDir ?? ''} onChange={(e) => set('exportDir', e.target.value || null)} placeholder="D:\Musikk\REASONDONE" className={`${field} font-mono text-[13px]`} spellCheck={false} />
      </label>
      {state.exportDirFromEnv && !state.settings.exportDir && (
        <p className="m-0 text-xs text-soft">
          Bruker <code className="font-mono text-ink-strong">GH_EXPORT_DIR</code> fra <code className="font-mono text-ink-strong">.env</code>. Lagrer du en mappe her, vinner den.
        </p>
      )}
      <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
        Mapper for umastrede låter (undermapper tillatt, én per linje)
        <textarea
          value={draft.draftDirs.join('\n')}
          onChange={(e) => set('draftDirs', e.target.value.split(/\r?\n/))}
          placeholder={'F:\\EchoGroove\\EchoAI_SamledeLydfiler\\WAV\nF:\\prosjekter_MAIN\\GroovehousePlayer\\umastret-sync'}
          rows={Math.max(2, draft.draftDirs.length + 1)}
          className="w-full rounded-xl border border-white/10 bg-sunken px-3 py-2 font-mono text-[13px] text-ink focus:border-accent/60 focus:outline-none"
          spellCheck={false}
        />
        <span className="text-xs leading-relaxed text-soft">
          Alle mappene overvåkes, og ved oppstart tas filer som ikke er importert ennå, med. Låter som finnes fra før, importeres ikke på nytt (se «Hoppet over» i Studio). MP3 og M4A godtas her. Låter herfra blir <b className="font-mono text-ink-strong">UMASTRET</b>: holdes atskilt fra de release-klare, normaliseres til målnivået i spilleren, og leses bare. Du kan også dra filer inn på ingest-kortet («Importer som umastret»).
        </span>
      </label>
      {check && !check.ok && (
        <p role="alert" className="m-0 text-xs text-[#F2A08F]">
          {check.error}
        </p>
      )}
      {check?.ok && (
        <p className={`m-0 text-xs ${check.many ? 'text-accent' : 'text-soft'}`}>
          {check.audioFiles} lydfiler i mappa.
          {check.many && ' Etter lagring tas nye bouncer med med en gang. Filene som ligger der fra før, tas inn når du trykker «Ta inn det som ligger der» nedenfor (eller ved neste oppstart). Låter som finnes fra før, importeres ikke på nytt.'}
        </p>
      )}
      {dirty && (
        <div>
          <button type="button" disabled={busy || (dirty && !!draft.exportDir && !check?.ok)} onClick={onSave} className={primaryBtn}>
            Lagre og start watcheren på nytt
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-sunken/75 px-4 py-3 text-xs">
        <span className="flex items-center gap-2.5 font-semibold text-ink-strong">
          <span aria-hidden="true" className="relative flex h-2.5 w-2.5 items-center justify-center">
            {w && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${w ? 'bg-accent shadow-[0_0_8px_var(--accent)]' : 'bg-[#F2A08F]'}`} />
          </span>
          {w ? (w.busy ? 'Watcher jobber' : 'Watcher kjører') : 'Watcher er av'}
        </span>
        {w && <span className="font-mono text-soft">{w.queued} i kø</span>}
        {w?.lastEvent && (
          <span className="text-soft">
            Siste: <span className="font-mono text-ink">{w.lastEvent.text}</span> ({new Date(w.lastEvent.at).toLocaleString('nb-NO')})
          </span>
        )}
        <button
          type="button"
          disabled={restarting}
          className={`${ghostBtn} ml-auto`}
          onClick={async () => {
            setRestarting(true);
            await settingsApi.restartWatcher(true).catch(() => null);
            setRestarting(false);
            onReload();
          }}
        >
          {restarting ? 'Starter…' : 'Ta inn det som ligger der'}
        </button>
      </div>
    </Section>
  );
}

function usePreview(draft: Editable, keys: Array<keyof Editable>) {
  const [p, setP] = useState<{ rows: PreviewRow[]; total: number; copyright: string | null } | null>(null);
  const dep = JSON.stringify(keys.map((k) => draft[k]));
  useEffect(() => {
    const t = setTimeout(() => {
      const patch: Partial<Editable> = {};
      for (const k of keys) (patch as Record<string, unknown>)[k] = draft[k];
      void settingsApi
        .preview(patch)
        .then(setP)
        .catch(() => setP(null));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return p;
}

function PreviewTable({ p, columns }: { p: { rows: PreviewRow[]; total: number } | null; columns: 'rules' | 'titles' }) {
  if (!p) return null;
  if (!p.total) return <p className="m-0 text-xs text-soft">Ingen lydfiler i eksportmappa å vise.</p>;
  const rows = columns === 'rules' ? p.rows : p.rows.filter((r) => r.removed.length).concat(p.rows.filter((r) => !r.removed.length)).slice(0, 12);
  return (
    <details className="text-xs" open={columns === 'rules'}>
      <summary className="cursor-pointer font-medium text-soft hover:text-ink-strong">
        Forhåndsvisning på {Math.min(p.rows.length, columns === 'rules' ? p.rows.length : 12)} av {p.total} filer i eksportmappa
      </summary>
      <div className="gv-scroll mt-2.5 max-h-72 overflow-auto rounded-xl bg-sunken/50">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-sunken font-mono text-[11px] uppercase tracking-[0.12em] text-soft">
            <tr>
              <th className="px-3 py-2 font-semibold">Fil</th>
              <th className="px-3 py-2 font-semibold">Tittel</th>
              {columns === 'rules' ? (
                <>
                  <th className="px-3 py-2 font-semibold">Variant</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                </>
              ) : (
                <th className="px-3 py-2 font-semibold">Fjernet</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.file} className="hover:bg-white/[0.02]">
                <td className="max-w-[260px] truncate px-3 py-2 font-mono text-[11.5px] text-soft">{r.file}</td>
                <td className="px-3 py-2 font-medium text-ink-strong">{r.title}</td>
                {columns === 'rules' ? (
                  <>
                    <td className="px-3 py-2 font-mono text-soft">{r.variant ?? '–'}</td>
                    <td className={`px-3 py-2 font-mono ${r.rule ? 'text-accent' : 'text-soft'}`}>
                      {r.kind}
                      {r.rule ? ` (${r.rule})` : ''}
                    </td>
                  </>
                ) : (
                  <td className="px-3 py-2 font-mono text-accent">{r.removed.join(', ') || '–'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function RulesSection({ draft, set }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void }) {
  const preview = usePreview(draft, ['ingest']);
  const rules = draft.ingest.rules;
  const setRules = (r: IngestRule[]) => set('ingest', { ...draft.ingest, rules: r });
  return (
    <Section title="Kategorisering" hint="Gjelder neste ingest. Eksisterende låter endres ikke.">
      <NumberField label="Lengre enn (minutter) = live-sett" value={draft.ingest.setThresholdMinutes} min={5} max={180} onChange={(v) => set('ingest', { ...draft.ingest, setThresholdMinutes: v })} />
      <div className="flex flex-col gap-2.5">
        <span className="text-xs text-soft">
          Filnavnregler (første som passer, vinner). <code className="font-mono text-ink-strong">*</code> er jokertegn, f.eks. <code className="font-mono text-ink-strong">* (Live *)</code> → sett.
        </span>
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2.5">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs font-medium text-soft">
              Mønster
              <input value={r.pattern} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))} className={`${field} font-mono`} placeholder="* (Live *)" />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs font-medium text-soft">
              Type
              <select value={r.kind ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, kind: (e.target.value || undefined) as IngestRule['kind'] } : x)))} className={field}>
                <option value="">(etter lengde)</option>
                <option value="set">Sett</option>
                <option value="track">Låt</option>
              </select>
            </label>
            <label className="flex w-40 flex-col gap-1 text-xs font-medium text-soft">
              Variant
              <input value={r.variant ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, variant: e.target.value.toLowerCase() || undefined } : x)))} className={`${field} font-mono`} placeholder="club" />
            </label>
            <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className={ghostBtn} aria-label={`Fjern regel ${i + 1}`}>
              Fjern
            </button>
          </div>
        ))}
        <div>
          <button type="button" onClick={() => setRules([...rules, { pattern: '', kind: 'set' }])} className={ghostBtn}>
            + Legg til regel
          </button>
        </div>
      </div>
      <PreviewTable p={preview} columns="rules" />
    </Section>
  );
}

function CoverSection({ draft, set }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void }) {
  const c = draft.covers;
  return (
    <Section
      title="Cover"
      hint="Låter uten cover får et Vault-cover automatisk. AI-cover lages i bulkIMG / AURORA Asset Studio: Vault skriver en CSV til innboksen, du kjører batchen og eksporterer vinneren, og Vault henter coveret fra eksportmappa. Lagres bare på denne PC-en."
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Innboks for CSV (bulkIMG)
          <input value={c.bulkimgInbox} onChange={(e) => set('covers', { ...c, bulkimgInbox: e.target.value })} className={`${field} font-mono`} spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Eksportmappe (bulkIMG, med manifest.json)
          <input value={c.bulkimgExports} onChange={(e) => set('covers', { ...c, bulkimgExports: e.target.value })} className={`${field} font-mono`} spellCheck={false} />
        </label>
      </div>
    </Section>
  );
}

function LyricsSection({ draft, set }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void }) {
  const l = draft.lyrics;
  return (
    <Section
      title="Tekst"
      hint="Etter ingest legges låta i en bakgrunnskø (Demucs + WhisperX på skjermkortet). Ingest venter ikke på den. Har du tekst fra før (limt inn i Studio, eller en .txt med samme navn som lydfila), brukes den, og bare ordtidene beregnes."
    >
      <Toggle label="Lag tekst automatisk etter ingest" checked={l.auto} onChange={(v) => set('lyrics', { ...l, auto: v })} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Modell (større = bedre og tregere)
          <select value={l.model} onChange={(e) => set('lyrics', { ...l, model: e.target.value })} className={field}>
            {['small', 'medium', 'large-v2', 'large-v3'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Språk
          <select value={l.language ?? ''} onChange={(e) => set('lyrics', { ...l, language: e.target.value || null })} className={field}>
            <option value="">Automatisk</option>
            <option value="en">Engelsk</option>
            <option value="no">Norsk</option>
          </select>
        </label>
      </div>
    </Section>
  );
}

function MetadataSection({ draft, set }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void }) {
  const preview = usePreview(draft, ['titleCleanup', 'defaults']);
  const [word, setWord] = useState('');
  const d = draft.defaults;
  const words = draft.titleCleanup.remove;
  return (
    <Section title="Metadata" hint="Standardverdier for nye låter. Det du har overstyrt per låt i Arkiv, vinner.">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Standard artist
          <input value={d.artist ?? ''} onChange={(e) => set('defaults', { ...d, artist: e.target.value || null })} className={field} maxLength={100} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Label
          <input value={d.label ?? ''} onChange={(e) => set('defaults', { ...d, label: e.target.value || null })} className={field} maxLength={100} />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-soft">
          Copyright-mal
          <input value={d.copyright ?? ''} onChange={(e) => set('defaults', { ...d, copyright: e.target.value || null })} className={field} maxLength={120} placeholder="℗ {år} {label}" />
        </label>
      </div>
      {preview?.copyright && <p className="m-0 font-mono text-xs text-soft">Blir: «{preview.copyright}»</p>}
      <div className="flex flex-col gap-2.5">
        <span className="text-xs font-medium text-soft">Fjernes fra titler (uansett store/små bokstaver)</span>
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {words.map((w) => (
            <li key={w} className="flex h-8 items-center gap-1 rounded-full bg-sunken/60 pl-3 pr-1 font-mono text-xs text-ink">
              {w}
              <button type="button" onClick={() => set('titleCleanup', { remove: words.filter((x) => x !== w) })} aria-label={`Fjern «${w}»`} className="h-7 w-7 rounded-full text-soft hover:text-ink-strong">
                ×
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const w = word.trim();
            if (w && !words.some((x) => x.toLowerCase() === w.toLowerCase())) set('titleCleanup', { remove: [...words, w] });
            setWord('');
          }}
        >
          <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="Ord eller mønster" className={`${field} max-w-xs`} maxLength={60} aria-label="Nytt ord å fjerne" />
          <button type="submit" className={ghostBtn}>
            Legg til
          </button>
        </form>
      </div>
      <PreviewTable p={preview} columns="titles" />
    </Section>
  );
}

function ColorsSection({ draft, set, busy, dirty }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void; busy: boolean; dirty: boolean }) {
  const [recolor, setRecolor] = useState<string | null>(null);
  const contrastFill = `${((draft.colors.minContrast - 3) / (7 - 3)) * 100}%`;
  return (
    <Section title="Farger" hint="Gjelder Kameleon-skinnene: fargen hentes fra coveret, og uten cover brukes standardfargen grønn (#06B211). Låter du har gitt egen farge i Arkiv, røres aldri.">
      <label className="flex flex-col gap-2.5 text-xs font-medium text-soft">
        Minste kontrast for aksentfarge
        <span className="flex flex-wrap items-center gap-4">
          <input
            type="range"
            min={3}
            max={7}
            step={0.1}
            value={draft.colors.minContrast}
            onChange={(e) => set('colors', { ...draft.colors, minContrast: Number(e.target.value) })}
            className="gv-range w-64"
            style={{ ['--fill' as string]: contrastFill }}
            aria-label="Minste kontrast"
          />
          <span className="tabular rounded-lg bg-sunken px-2.5 py-1 font-mono text-sm font-semibold text-ink-strong">{draft.colors.minContrast.toFixed(1)}:1</span>
        </span>
      </label>
      <Toggle label="Fargeløse cover får standardfargen (grønn)" checked={draft.colors.colorFallback} onChange={(v) => set('colors', { ...draft.colors, colorFallback: v })} />
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={busy || dirty}
          className={ghostBtn}
          title={dirty ? 'Lagre endringene nederst først' : undefined}
          onClick={async () => {
            setRecolor('Regner ut fargene på nytt…');
            try {
              const r = await settingsApi.recolor();
              setRecolor(`${r.changed} låter fikk ny farge${r.skipped ? ` · ${r.skipped} med egen farge urørt` : ''}.`);
            } catch (err) {
              setRecolor(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Bruk på alle låter nå
        </button>
        {recolor && <span className="text-xs text-soft">{recolor}</span>}
      </div>
    </Section>
  );
}

function AccessSection({ state, onChanged }: { state: SettingsState; onChanged: () => void }) {
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);
  const can = state.canChangeAccess;
  const afterRestart = useMemo(
    () => () => {
      setMsg('Serveren starter på nytt – siden lastes om et øyeblikk…');
      waitAndReload();
    },
    []
  );
  return (
    <Section title="Tilgang" hint={can ? 'Wi-Fi-modus og PIN kan bare endres her fra PC-en.' : 'Wi-Fi-modus og PIN kan bare endres fra PC-en.'}>
      <div className="flex flex-wrap items-center gap-3">
        <Toggle
          label="Wi-Fi-modus (mobilen på samme nett, med PIN)"
          checked={state.lan.enabled}
          disabled={!can}
          onChange={async (v) => {
            try {
              await settingsApi.setLan(v);
              afterRestart();
            } catch (err) {
              const e = err as Error & { body?: { needPin?: boolean } };
              if (e.body?.needPin) setShowPin(true);
              setMsg(e.message);
            }
          }}
        />
        <span className="text-xs text-muted">PIN: {state.lan.pinSet ? 'satt' : 'ikke satt'}</span>
        {state.lan.firewallRule === false && state.lan.enabled && <span className="text-xs text-accent">Brannmurregelen mangler – kjør «pnpm vault:lan on» i et terminalvindu (Windows spør om administrator).</span>}
        {can && (
          <button type="button" className={ghostBtn} onClick={() => setShowPin((s) => !s)}>
            {state.lan.pinSet ? 'Bytt PIN' : 'Velg PIN'}
          </button>
        )}
      </div>
      {showPin && can && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await settingsApi.setPin(pin, repeat);
              setPin('');
              setRepeat('');
              setShowPin(false);
              if (r.restarting) afterRestart();
              else {
                setMsg('Ny PIN er lagret.');
                onChanged();
              }
            } catch (err) {
              setMsg(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted">
            Ny PIN (6–12 sifre)
            <input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} className={`${field} w-40`} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Gjenta
            <input type="password" inputMode="numeric" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={`${field} w-40`} />
          </label>
          <button type="submit" className={primaryBtn}>
            Lagre PIN
          </button>
          <span className="text-xs text-muted">Alle mobiler må taste den nye PIN-en.</span>
        </form>
      )}
      <div className="flex flex-wrap items-start gap-4 rounded-xl bg-sunken/60 p-3 text-xs">
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-ink">Tailscale</span>
          {!state.remote.running ? (
            <span className="text-muted">Kjører ikke eller er ikke logget inn.</span>
          ) : state.remote.serve && state.remote.url ? (
            <>
              <span className="text-soft">På – {state.remote.url}</span>
              <span className="text-muted">Bare enheter i tailnettet ditt når adressen.</span>
            </>
          ) : (
            <span className="text-muted">Serve er av. Slå på med «pnpm vault:remote on».</span>
          )}
          {state.remote.funnel && <span className="text-[#F2A08F]">Funnel er PÅ (åpent mot internett). Slå av: tailscale funnel --https=443 off</span>}
        </div>
        {state.remote.qr && <div className="h-36 w-36 overflow-hidden rounded-lg" aria-label="QR-kode til Tailscale-adressen" dangerouslySetInnerHTML={{ __html: state.remote.qr }} />}
      </div>
      {msg && (
        <p role="status" className="m-0 text-xs text-soft">
          {msg}
        </p>
      )}
    </Section>
  );
}

function RestartServer() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={busy}
        className={ghostBtn}
        onClick={async () => {
          setBusy(true);
          await settingsApi.restartServer().catch(() => null);
          waitAndReload();
        }}
      >
        {busy ? 'Starter på nytt…' : 'Start serveren på nytt'}
      </button>
      <span className="text-xs text-muted">Trengs bare etter endring av porter. Avspilling stopper et par sekunder.</span>
    </div>
  );
}

/** Venter til serveren svarer igjen, og laster siden på nytt. */
function waitAndReload() {
  let tries = 0;
  const poll = () => {
    tries++;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? location.reload() : Promise.reject()))
      .catch(() => tries < 60 && setTimeout(poll, 1000));
  };
  setTimeout(poll, 1500);
}
