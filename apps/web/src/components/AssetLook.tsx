import { useMemo, useState, type CSSProperties } from 'react';
import { formatTime, paletteToCssVars, type Palette } from '@gv/shared/web';
import { saveAssetMeta, type LoadedAsset } from '../lib/catalog';
import { usePlayer } from '../lib/player';
import { contrast, getMinContrast } from '../lib/settings';

const OBSIDIAN = '#07080B';

/**
 * Del 8 pkt. 8–9, per låt i Studio → Arkiv:
 * - Fargeoverstyring (primary/secondary) med live forhåndsvisning og kontrast mot #07080B.
 * - Live-sett: forskyvning ±10 s (steg 50 ms) som flytter alle live-logg-markører, med «spill fra markør».
 * Lagres i media/<slug>/meta.json og overlever ny ingest.
 */
export function AssetLook({ a, onSaved }: { a: LoadedAsset; onSaved: () => void }) {
  const m = a.manifest;
  const [primary, setPrimary] = useState(m.palette.primary.toUpperCase());
  const [secondary, setSecondary] = useState(m.palette.secondary.toUpperCase());
  const savedOffset = m.liveOffsetMs ?? 0;
  const [offset, setOffset] = useState(savedOffset);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const min = getMinContrast();
  const ratio = contrast(primary, OBSIDIAN);
  const tooLow = ratio < min;
  const preview: Palette = useMemo(() => ({ primary, secondary, onPrimary: contrast(primary, OBSIDIAN) >= contrast(primary, '#F4F1EA') ? OBSIDIAN : '#F4F1EA', source: 'manual' }), [primary, secondary]);
  const { playFrom } = usePlayer();

  const run = async (body: Parameters<typeof saveAssetMeta>[1], ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await saveAssetMeta(m.slug, body);
      setMsg({ ok: true, text: ok });
      onSaved();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const delta = offset - savedOffset;
  const markers = m.markers.filter((k) => k.kind !== 'drop' || m.kind === 'set');
  const shifted = (ms: number) => Math.min(m.durationMs, Math.max(0, ms + delta));
  const hex = /^#[0-9A-F]{6}$/i;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-sunken/60 p-3">
      <fieldset className="m-0 flex flex-wrap items-start gap-4 border-0 p-0">
        <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Farge {m.palette.source === 'manual' ? '· valgt manuelt' : '· standard (grønn)'}</legend>
        {(
          [
            ['Primær', primary, setPrimary],
            ['Sekundær', secondary, setSecondary]
          ] as const
        ).map(([label, value, set]) => (
          <label key={label} className="flex flex-col gap-1 text-[11px] text-muted">
            {label}
            <span className="flex items-center gap-2">
              <input type="color" value={hex.test(value) ? value.toLowerCase() : '#000000'} onChange={(e) => set(e.target.value.toUpperCase())} aria-label={`${label}farge`} className="h-11 w-11 cursor-pointer rounded-lg border border-white/15 bg-transparent" />
              <input value={value} onChange={(e) => set(e.target.value.trim().toUpperCase())} maxLength={7} aria-label={`${label}farge som hex`} className="min-h-11 w-24 rounded-xl border border-white/10 bg-sunken px-2 font-mono text-sm text-ink focus:border-accent/60 focus:outline-none" />
            </span>
          </label>
        ))}
        <div className="flex flex-col gap-1 text-[11px] text-muted">
          Kontrast mot bakgrunn
          <span data-testid="contrast" className={`flex min-h-11 items-center text-sm font-semibold ${tooLow ? 'text-[#FF6B5A]' : 'text-ink-strong'}`}>
            {ratio.toFixed(2)}:1 {tooLow ? `– under ${min}:1` : '✓'}
          </span>
        </div>
        {/* Live forhåndsvisning: spiller og drop-side */}
        <div className="flex gap-3" style={paletteToCssVars(preview) as CSSProperties} aria-label="Forhåndsvisning">
          <div className="flex w-48 items-center gap-2 rounded-xl border border-white/10 bg-surface p-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold" style={{ background: primary, color: preview.onPrimary }}>
              ▶
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold" style={{ color: primary }}>
                {m.title}
              </span>
              <span className="mt-1 block h-1 rounded-full" style={{ background: `linear-gradient(90deg, ${primary} 45%, ${secondary} 45%)` }} />
            </span>
          </div>
          <div className="flex w-32 flex-col justify-end rounded-xl p-2" style={{ background: `radial-gradient(circle at 30% 20%, ${secondary}55, ${OBSIDIAN} 70%)`, border: `1px solid ${primary}55` }}>
            <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: primary }}>
              Drop
            </span>
            <span className="truncate text-[11px] text-ink">{m.title}</span>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2">
          <button type="button" disabled={busy || tooLow || !hex.test(primary) || !hex.test(secondary)} onClick={() => run({ palette: { primary, secondary } }, 'Farge lagret')} className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50">
            Lagre farge
          </button>
          {m.palette.source === 'manual' && (
            <button type="button" disabled={busy} onClick={() => run({ palette: null }, 'Tilbake til automatisk')} className="min-h-11 rounded-full border border-white/15 px-4 text-xs font-semibold text-ink hover:border-accent/50">
              Tilbakestill til automatisk
            </button>
          )}
        </div>
      </fieldset>

      {m.kind === 'set' && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Live-sett: forskyvning av markører</legend>
          <label className="flex flex-wrap items-center gap-3 text-xs text-muted">
            <input type="range" min={-10000} max={10000} step={50} value={offset} onChange={(e) => setOffset(Number(e.target.value))} aria-label="Forskyvning i millisekunder" className="w-72 accent-[var(--accent)]" />
            <span data-testid="offset" className="tabular min-w-[72px] text-sm text-ink-strong">
              {offset > 0 ? '+' : ''}
              {(offset / 1000).toFixed(2)} s
            </span>
            {offset !== 0 && (
              <button type="button" onClick={() => setOffset(0)} className="text-xs text-muted underline">
                Nullstill
              </button>
            )}
          </label>
          {markers.length > 0 && (
            <ol className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {markers.slice(0, 40).map((k) => (
                <li key={`${k.kind}-${k.startMs}`}>
                  <button type="button" onClick={() => playFrom([a], 0, shifted(k.startMs))} className="flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-[11px] hover:border-accent/50" aria-label={`Spill fra ${k.label ?? k.kind} ${formatTime(shifted(k.startMs))}`}>
                    ▶ <span className="tabular text-muted">{formatTime(shifted(k.startMs))}</span> {k.label ?? k.kind}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div>
            <button type="button" disabled={busy || offset === savedOffset} onClick={() => run({ liveOffsetMs: offset }, 'Forskyvning lagret – markørene er flyttet')} className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-on-accent disabled:opacity-50">
              Lagre forskyvning
            </button>
          </div>
        </fieldset>
      )}
      {msg && (
        <span role={msg.ok ? 'status' : 'alert'} className={`text-[12px] ${msg.ok ? 'text-soft' : 'text-[#F2A08F]'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
