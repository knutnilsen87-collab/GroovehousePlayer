import { useMemo, useState, type CSSProperties } from 'react';
import { duplicateSkin, skinAccentVars, skinContrastIssues, skinRootVars, type Skin } from '@gv/shared/web';
import { BUILT_IN_SKINS, useSkin } from '../lib/skin';
import { PlayIcon } from './Icons';

/** Del 19: liten forhåndsvisning (cover, bølgeform og play-knapp) i skinnets stil. */
function SkinPreview({ skin }: { skin: Skin }) {
  // Kameleon-skins vises med et eksempel-cover i blått, så forskjellen fra faste skins synes
  const sample = skin.mode === 'chameleon' ? { primary: '#3CB4FF', secondary: '#7A5CFF', onPrimary: '#07080B', source: 'cover' as const } : null;
  const vars = { ...skinRootVars(skin), ...skinAccentVars(skin, sample) } as CSSProperties;
  const bars = [0.35, 0.6, 0.9, 0.55, 0.75, 1, 0.65, 0.4, 0.8, 0.5, 0.7, 0.3, 0.55, 0.45];
  return (
    <div style={{ ...vars, backgroundColor: 'var(--c-obsidian)', backgroundImage: 'radial-gradient(circle at 90% -10%, var(--moon) 0, transparent 70%)' }} className="flex flex-col gap-2 rounded-xl p-2.5" data-wave={skin.waveform}>
      <div className="gv-panel flex items-center gap-2 p-2">
        <div aria-hidden="true" className="h-9 w-9 flex-none rounded-md" style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }} />
        <div className="flex h-7 flex-1 items-end gap-[2px]" aria-hidden="true">
          {bars.map((h, i) => (
            <span key={i} className={`flex-1 rounded-[1px] ${i < 8 ? 'gv-wave-played' : ''}`} style={{ height: `${h * 100}%`, ...(i < 8 ? {} : { backgroundColor: 'rgba(255,255,255,0.14)' }) }} />
          ))}
        </div>
        <span aria-hidden="true" className="gv-neon flex h-7 w-7 flex-none items-center justify-center rounded-full" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          <PlayIcon width={12} height={12} />
        </span>
      </div>
    </div>
  );
}

function Editor({ start, taken, onClose }: { start: Skin; taken: Set<string>; onClose: () => void }) {
  const save = useSkin((s) => s.saveCustom);
  const choose = useSkin((s) => s.choose);
  const [s, setS] = useState<Skin>(() => duplicateSkin(start, taken));
  const [err, setErr] = useState<string | null>(null);
  const issues = skinContrastIssues(s);
  const color = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex items-center gap-2 text-xs text-soft">
      <input type="color" value={value.toLowerCase()} onChange={(e) => set(e.target.value.toUpperCase())} aria-label={label} className="h-10 w-10 cursor-pointer rounded-lg border border-white/15 bg-transparent" />
      {label} <span className="font-mono text-muted">{value}</span>
    </label>
  );
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-sunken p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex flex-1 flex-col gap-1 text-xs text-soft">
          Navn
          <input value={s.name} maxLength={40} onChange={(e) => setS({ ...s, name: e.target.value })} className="min-h-[40px] rounded-lg border border-white/10 bg-obsidian px-3 text-sm text-ink-strong" />
        </label>
        <div className="w-48">
          <SkinPreview skin={s} />
        </div>
      </div>
      <div className="flex flex-wrap gap-5">
        {color('Aksent', s.accent ?? '#FFFFFF', (v) => setS({ ...s, accent: v }))}
        {color('Aksent 2', s.accent2 ?? s.accent ?? '#FFFFFF', (v) => setS({ ...s, accent2: v }))}
        {color('Bakgrunn', s.background.base, (v) => setS({ ...s, background: { ...s.background, base: v } }))}
      </div>
      <label className="flex items-center gap-3 text-xs text-soft">
        Glød
        <input type="range" min={0} max={100} value={s.glow} onChange={(e) => setS({ ...s, glow: Number(e.target.value) })} className="gv-range flex-1" style={{ ['--fill' as string]: `${s.glow}%` }} />
        <span className="w-10 text-right font-mono text-ink-strong">{s.glow} %</span>
      </label>
      {issues.length > 0 && (
        <ul role="status" className="m-0 list-none rounded-lg border border-[#F2A08F]/40 bg-[#F2A08F]/[0.08] p-3 text-xs text-[#F2A08F]">
          {issues.map((i) => (
            <li key={i}>Kontrast: {i}</li>
          ))}
        </ul>
      )}
      {err && <p role="alert" className="m-0 text-xs text-[#F2A08F]">{err}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={issues.length > 0}
          onClick={async () => {
            try {
              await save(s);
              choose(s.id);
              onClose();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
          className="min-h-[40px] rounded-lg bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-40"
        >
          Lagre og bruk
        </button>
        <button type="button" onClick={onClose} className="min-h-[40px] rounded-lg border border-white/10 px-4 text-sm text-soft hover:text-ink-strong">
          Avbryt
        </button>
      </div>
    </div>
  );
}

/** Innstillinger → Utseende. Byttet skjer umiddelbart og lagres på denne enheten. */
export function SkinPicker() {
  const { skin, followShared, setFollowShared, choose, deleteCustom } = useSkin();
  // Ikke s.all() i selektoren: den lager en ny liste hver gang og gir en uendelig render-løkke
  const custom = useSkin((s) => s.custom);
  const all = useMemo(() => [...BUILT_IN_SKINS, ...custom], [custom]);
  const [editing, setEditing] = useState<Skin | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Skin" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {all.map((s) => {
          const on = s.id === skin.id;
          return (
            <div key={s.id} className={`flex flex-col gap-2 rounded-2xl border p-2.5 transition-colors ${on ? 'gv-neon-soft border-accent/70' : 'border-white/[0.08] hover:border-white/20'}`}>
              <button type="button" role="radio" aria-checked={on} onClick={() => choose(s.id)} className="flex flex-col gap-2 text-left">
                <SkinPreview skin={s} />
                <span className="flex items-center gap-2 px-1 text-sm font-semibold text-ink-strong">
                  {s.name}
                  {s.id === 'kameleon' && <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">standard</span>}
                  {!s.builtIn && <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">egen</span>}
                </span>
                <span className="px-1 text-xs leading-snug text-soft">{s.description || (s.mode === 'chameleon' ? 'Coveret styrer fargene.' : 'Faste farger.')}</span>
              </button>
              <div className="flex gap-1 px-1">
                <button type="button" onClick={() => setEditing(s)} className="text-xs text-soft underline-offset-2 hover:text-ink-strong hover:underline">
                  Dupliser og tilpass
                </button>
                {!s.builtIn && (
                  <button
                    type="button"
                    onClick={() => void deleteCustom(s.id).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))}
                    className="ml-auto text-xs text-muted hover:text-[#F2A08F]"
                  >
                    Slett
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editing && <Editor start={editing} taken={new Set(all.map((s) => s.id))} onClose={() => setEditing(null)} />}
      <label className="flex items-center gap-3 text-sm text-soft">
        <input type="checkbox" checked={followShared} onChange={(e) => void setFollowShared(e.target.checked).catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))} className="h-5 w-5 accent-[var(--accent)]" />
        Bruk samme skin på alle enheter
        <span className="text-xs text-muted">(ellers bare denne enheten)</span>
      </label>
      <p className="m-0 text-xs leading-relaxed text-muted">
        Manuell farge på en låt (Arkiv) gjelder bare i Kameleon-skinnene. Lyttersiden og spillelistefargene påvirkes ikke.
      </p>
      {err && <p role="alert" className="m-0 text-xs text-[#F2A08F]">{err}</p>}
    </div>
  );
}
