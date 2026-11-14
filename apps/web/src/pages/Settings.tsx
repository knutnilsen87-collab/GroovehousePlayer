import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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

  if (error && !state) return <p role="alert" className="text-[#F2A08F]">Kunne ikke hente innstillingene: {error}</p>;
  if (!state || !draft) return <p className="text-muted">Henter innstillinger…</p>;

  const dirty = (k: keyof Editable) => JSON.stringify(draft[k]) !== JSON.stringify(state.settings[k]);
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
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setDraft({ ...draft, [k]: v });

  return (
    <div className="flex max-w-[880px] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-semibold text-ink-strong">Innstillinger</h1>
        <p className="m-0 text-sm text-muted">Lagres i groovehouse.config.json (forrige versjon i groovehouse.config.backup.json). Eksportmappa lagres bare på denne PC-en.</p>
      </header>
      <div aria-live="polite" className="sticky top-0 z-10 empty:hidden">
        {error && (
          <p role="alert" className="m-0 rounded-xl border border-[#F2A08F]/40 bg-[#2A1512] px-4 py-3 text-sm text-[#F2A08F]">
            {error}
          </p>
        )}
        {notice && <p className="m-0 rounded-xl border border-accent/30 bg-accent/[0.08] px-4 py-3 text-sm text-soft">{notice}</p>}
      </div>

      <ExportSection state={state} draft={draft} set={set} busy={busy} dirty={dirty('exportDir')} onSave={() => save(['exportDir'], 'Eksportmappa er lagret.')} onReload={load} />
      <RulesSection draft={draft} set={set} busy={busy} dirty={dirty('ingest')} onSave={() => save(['ingest'], 'Reglene er lagret og gjelder neste ingest.')} />
      <Section title="Lyd" hint="Gjelder i spilleren med en gang (også låter som alt er ingestet).">
        <label className="flex flex-col gap-2 text-xs text-muted">
          Målnivå for avspilling
          <span className="flex items-center gap-3">
            <input type="range" min={-16} max={-11} step={0.5} value={draft.audio.targetLufs} onChange={(e) => set('audio', { targetLufs: Number(e.target.value) })} className="w-64" aria-label="Målnivå i LUFS" />
            <span className="tabular text-sm text-ink-strong">{draft.audio.targetLufs} LUFS</span>
          </span>
        </label>
        <p className="m-0 text-xs text-muted">Spilleren kan bare dempe, ikke løfte. Et høyere mål gjør derfor ikke stille skisser høyere – bare at høye låter dempes mindre. Standard −14 LUFS.</p>
        <p className="m-0 text-xs text-muted">HLS: {state.server.hls} (info, ikke en innstilling).</p>
        <SaveRow busy={busy} dirty={dirty('audio')} onSave={() => save(['audio'], 'Målnivået er lagret. Last spilleren på nytt for å høre det.')} onReset={() => set('audio', state.defaults.audio)} />
      </Section>
      <MetadataSection draft={draft} set={set} busy={busy} dirty={dirty('defaults') || dirty('titleCleanup')} onSave={() => save(['defaults', 'titleCleanup'], 'Metadata-standardene er lagret og gjelder neste ingest.')} />
      <ColorsSection draft={draft} set={set} busy={busy} dirty={dirty('colors')} onSave={() => save(['colors'], 'Fargeinnstillingene er lagret.')} />
      <AccessSection state={state} onChanged={load} />
      <Section title="Standarder for drops" hint="Lagres nå, men har ingen effekt før del 13 (deling med lenker) er bygget.">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
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
        <SaveRow busy={busy} dirty={dirty('drops')} onSave={() => save(['drops'], 'Drop-standardene er lagret.')} onReset={() => set('drops', state.defaults.drops)} />
      </Section>
      <Devices app={state.app} />
      {state.cloudSync && (
        <section role="alert" aria-label="Skysynkronisering" className="rounded-2xl border border-[#FF6B5A]/50 bg-[#FF6B5A]/[0.06] p-5">
          <h2 className="m-0 text-base font-semibold text-[#FFB4A8]">Prosjektmappa synkroniseres av {state.cloudSync.provider}</h2>
          <pre className="m-0 mt-2 whitespace-pre-wrap font-mono text-xs text-soft">{state.cloudSync.warning}</pre>
        </section>
      )}
      <Section title="Server" hint={`Port ${state.server.port} · prosess ${state.server.pid}`}>
        <RestartServer />
      </Section>
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
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm">
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

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-2xl border border-white/[0.06] bg-surface p-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="m-0 text-base font-semibold text-ink-strong">{title}</h2>
        {hint && <p className="m-0 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function SaveRow({ busy, dirty, onSave, onReset, label = 'Lagre' }: { busy: boolean; dirty: boolean; onSave: () => void; onReset?: () => void; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={busy || !dirty} onClick={onSave} className={primaryBtn}>
        {label}
      </button>
      {onReset && (
        <button type="button" disabled={busy} onClick={onReset} className={ghostBtn}>
          Standard
        </button>
      )}
    </div>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} className={field} />
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
    <Section title="Eksport og watcher" hint="Mappa Reason bouncer til. Vault leser bare – ingenting flyttes eller slettes der.">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Eksportmappe
        <input value={draft.exportDir ?? ''} onChange={(e) => set('exportDir', e.target.value || null)} placeholder="D:\Musikk\REASONDONE" className={field} spellCheck={false} />
      </label>
      {state.exportDirFromEnv && !state.settings.exportDir && <p className="m-0 text-xs text-muted">Bruker GH_EXPORT_DIR fra .env. Lagrer du en mappe her, vinner den.</p>}
      {check && !check.ok && (
        <p role="alert" className="m-0 text-xs text-[#F2A08F]">
          {check.error}
        </p>
      )}
      {check?.ok && (
        <p className={`m-0 text-xs ${check.many ? 'text-accent' : 'text-soft'}`}>
          {check.audioFiles} lydfiler i mappa.
          {check.many && ' Watcheren importerer bare nye filer. For å ta inn det som ligger der fra før, kjør «pnpm gh-ingest --backlog» i et terminalvindu (viser listen og spør før den starter).'}
        </p>
      )}
      <SaveRow busy={busy || (dirty && !!draft.exportDir && !check?.ok)} dirty={dirty} onSave={onSave} label="Lagre og start watcheren på nytt" />
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-sunken/60 px-3 py-2 text-xs">
        <span className="flex items-center gap-2 font-semibold text-ink">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${w ? 'bg-accent' : 'bg-[#F2A08F]'}`} />
          {w ? (w.busy ? 'Watcher jobber' : 'Watcher kjører') : 'Watcher er av'}
        </span>
        {w && <span className="text-muted">{w.queued} i kø</span>}
        {w?.lastEvent && (
          <span className="text-muted">
            Siste: {w.lastEvent.text} ({new Date(w.lastEvent.at).toLocaleString('nb-NO')})
          </span>
        )}
        <button
          type="button"
          disabled={restarting}
          className={`${ghostBtn} ml-auto`}
          onClick={async () => {
            setRestarting(true);
            await settingsApi.restartWatcher().catch(() => null);
            setRestarting(false);
            onReload();
          }}
        >
          {restarting ? 'Starter…' : 'Start watcheren på nytt'}
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
  if (!p.total) return <p className="m-0 text-xs text-muted">Ingen lydfiler i eksportmappa å vise.</p>;
  const rows = columns === 'rules' ? p.rows : p.rows.filter((r) => r.removed.length).concat(p.rows.filter((r) => !r.removed.length)).slice(0, 12);
  return (
    <details className="text-xs" open={columns === 'rules'}>
      <summary className="cursor-pointer text-muted">
        Forhåndsvisning på {Math.min(p.rows.length, columns === 'rules' ? p.rows.length : 12)} av {p.total} filer i eksportmappa
      </summary>
      <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-white/[0.06]">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-sunken text-muted">
            <tr>
              <th className="px-2 py-1.5 font-semibold">Fil</th>
              <th className="px-2 py-1.5 font-semibold">Tittel</th>
              {columns === 'rules' ? (
                <>
                  <th className="px-2 py-1.5 font-semibold">Variant</th>
                  <th className="px-2 py-1.5 font-semibold">Type</th>
                </>
              ) : (
                <th className="px-2 py-1.5 font-semibold">Fjernet</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.file} className="border-t border-white/[0.04]">
                <td className="max-w-[260px] truncate px-2 py-1.5 text-muted">{r.file}</td>
                <td className="px-2 py-1.5 text-ink">{r.title}</td>
                {columns === 'rules' ? (
                  <>
                    <td className="px-2 py-1.5 text-ink">{r.variant ?? '–'}</td>
                    <td className={`px-2 py-1.5 ${r.rule ? 'text-accent' : 'text-muted'}`}>
                      {r.kind}
                      {r.rule ? ` (${r.rule})` : ''}
                    </td>
                  </>
                ) : (
                  <td className="px-2 py-1.5 text-accent">{r.removed.join(', ') || '–'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function RulesSection({ draft, set, busy, dirty, onSave }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void; busy: boolean; dirty: boolean; onSave: () => void }) {
  const preview = usePreview(draft, ['ingest']);
  const rules = draft.ingest.rules;
  const setRules = (r: IngestRule[]) => set('ingest', { ...draft.ingest, rules: r });
  return (
    <Section title="Kategorisering" hint="Gjelder neste ingest. Eksisterende låter endres ikke.">
      <NumberField label="Lengre enn (minutter) regnes som live-sett" value={draft.ingest.setThresholdMinutes} min={5} max={180} onChange={(v) => set('ingest', { ...draft.ingest, setThresholdMinutes: v })} />
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted">Filnavnregler (første som passer, vinner). * er jokertegn, f.eks. «* (Live *)» → sett.</span>
        {rules.map((r, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-muted">
              Mønster
              <input value={r.pattern} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))} className={field} placeholder="* (Live *)" />
            </label>
            <label className="flex w-36 flex-col gap-1 text-xs text-muted">
              Type
              <select value={r.kind ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, kind: (e.target.value || undefined) as IngestRule['kind'] } : x)))} className={field}>
                <option value="">(etter lengde)</option>
                <option value="set">Sett</option>
                <option value="track">Låt</option>
              </select>
            </label>
            <label className="flex w-40 flex-col gap-1 text-xs text-muted">
              Variant
              <input value={r.variant ?? ''} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, variant: e.target.value.toLowerCase() || undefined } : x)))} className={field} placeholder="club" />
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
      <SaveRow busy={busy} dirty={dirty} onSave={onSave} />
    </Section>
  );
}

function MetadataSection({ draft, set, busy, dirty, onSave }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void; busy: boolean; dirty: boolean; onSave: () => void }) {
  const preview = usePreview(draft, ['titleCleanup', 'defaults']);
  const [word, setWord] = useState('');
  const d = draft.defaults;
  const words = draft.titleCleanup.remove;
  return (
    <Section title="Metadata" hint="Standardverdier for nye låter. Det du har overstyrt per låt i Arkiv, vinner.">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Standard artist
          <input value={d.artist ?? ''} onChange={(e) => set('defaults', { ...d, artist: e.target.value || null })} className={field} maxLength={100} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Label
          <input value={d.label ?? ''} onChange={(e) => set('defaults', { ...d, label: e.target.value || null })} className={field} maxLength={100} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Copyright-mal
          <input value={d.copyright ?? ''} onChange={(e) => set('defaults', { ...d, copyright: e.target.value || null })} className={field} maxLength={120} placeholder="℗ {år} {label}" />
        </label>
      </div>
      {preview?.copyright && <p className="m-0 text-xs text-muted">Blir: «{preview.copyright}»</p>}
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted">Fjernes fra titler (uansett store/små bokstaver)</span>
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {words.map((w) => (
            <li key={w} className="flex h-8 items-center gap-1 rounded-full border border-white/10 pl-3 pr-1 text-xs">
              {w}
              <button type="button" onClick={() => set('titleCleanup', { remove: words.filter((x) => x !== w) })} aria-label={`Fjern «${w}»`} className="h-7 w-7 rounded-full text-muted hover:text-ink">
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
      <SaveRow busy={busy} dirty={dirty} onSave={onSave} />
    </Section>
  );
}

function ColorsSection({ draft, set, busy, dirty, onSave }: { draft: Editable; set: <K extends keyof Editable>(k: K, v: Editable[K]) => void; busy: boolean; dirty: boolean; onSave: () => void }) {
  const [recolor, setRecolor] = useState<string | null>(null);
  return (
    <Section title="Farger" hint="Fargene hentes fra coveret. Låter du har gitt egen farge i Arkiv, røres aldri.">
      <label className="flex flex-col gap-2 text-xs text-muted">
        Minste kontrast for aksentfarge
        <span className="flex items-center gap-3">
          <input type="range" min={3} max={7} step={0.1} value={draft.colors.minContrast} onChange={(e) => set('colors', { ...draft.colors, minContrast: Number(e.target.value) })} className="w-64" aria-label="Minste kontrast" />
          <span className="tabular text-sm text-ink-strong">{draft.colors.minContrast.toFixed(1)}:1</span>
        </span>
      </label>
      <Toggle label="Fargeløse cover får standardfargen (cyan)" checked={draft.colors.colorFallback} onChange={(v) => set('colors', { ...draft.colors, colorFallback: v })} />
      <div className="flex flex-wrap items-center gap-2">
        <SaveRow busy={busy} dirty={dirty} onSave={onSave} />
        <button
          type="button"
          disabled={busy || dirty}
          className={ghostBtn}
          title={dirty ? 'Lagre først' : undefined}
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
        {recolor && <span className="text-xs text-muted">{recolor}</span>}
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
      <div className="flex flex-wrap items-start gap-4 rounded-xl border border-white/[0.06] bg-sunken/60 p-3 text-xs">
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
