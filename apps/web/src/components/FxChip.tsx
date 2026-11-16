import { useState } from 'react';
import { placeSteps, type FxPreset, type SbTrack, type TransitionInfo } from '@gv/shared/web';
import { useAllPresets, useFx, useMostUsed } from '../lib/fx';
import { formatTime } from '@gv/shared/web';

/** Del 18: brikken for en preset (farge + ikon + navn). */
export function PresetBadge({ p, small = false }: { p: FxPreset; small?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-sans font-semibold ${small ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]'}`} style={{ borderColor: `${p.color}88`, color: p.color, background: `${p.color}14` }}>
      <span aria-hidden="true">{p.icon}</span>
      {p.name}
    </span>
  );
}

/** Ett-trykks-rad: de 6 mest brukte, og «Flere…» for resten. Brukes i settbyggeren og i «Idé for overgang». */
export function PresetRow({ onPick, active }: { onPick: (p: FxPreset) => void; active?: string }) {
  const top = useMostUsed(6);
  const all = useAllPresets();
  const [more, setMore] = useState(false);
  const list = more ? all : top;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Velg preset">
      {list.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={active === p.id}
          onClick={() => onPick(p)}
          className="min-h-[40px] rounded-full border px-3 text-[13px] font-semibold transition-colors"
          style={{ borderColor: active === p.id ? p.color : `${p.color}55`, color: p.color, background: active === p.id ? `${p.color}26` : 'transparent' }}
        >
          <span aria-hidden="true" className="mr-1">
            {p.icon}
          </span>
          {p.name}
        </button>
      ))}
      {!more && (
        <button type="button" onClick={() => setMore(true)} className="min-h-[40px] rounded-full bg-white/[0.04] px-3 text-[13px] text-soft hover:text-ink">
          Flere…
        </button>
      )}
    </div>
  );
}

/** Overgangen i settbyggeren: foreslått preset som brikke, ett trykk for å bytte, og stegene festet til takter. */
export function TransitionFx({ a, b, info, preset, reason, learned }: { a: SbTrack; b: SbTrack; info: TransitionInfo; preset: FxPreset; reason: string; learned: boolean }) {
  const [open, setOpen] = useState(false);
  const saveIdea = useFx((s) => s.saveIdea);
  const steps = placeSteps(preset, info.mix, a.bpm, b.bpm);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={reason} className="rounded-full">
          <PresetBadge p={preset} />
        </button>
        <span className="font-sans text-[11px] text-muted">{learned ? `★ ${reason}` : reason}</span>
      </div>
      <ol className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-[10px] text-muted" aria-label={`Steg i ${preset.name}`}>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="text-ink">takt {s.bar > 0 ? `+${s.bar}` : s.bar}</span> · {s.track} {formatTime(s.atMs)} · {s.text}
          </li>
        ))}
      </ol>
      {open && (
        <PresetRow
          active={preset.id}
          onPick={(p) => {
            // Valget lagres som idé for paret – da lærer Vault det (del 18 pkt. 5)
            void saveIdea(a.slug, b.slug, p.id);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
