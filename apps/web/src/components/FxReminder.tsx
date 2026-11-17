import { useEffect, useMemo, useState } from 'react';
import { usePlayer } from '../lib/player';
import { useFx } from '../lib/fx';
import { reminderPlan, reminderText } from '../lib/fxReminder';
import type { LoadedAsset } from '../lib/catalog';
import { PresetRow } from './FxChip';
import { captureIdea } from './TrackActions';

/**
 * Del 18 pkt. 9: når neste låt i køen står klar (planlagt sett eller to låter etter hverandre), vises de siste
 * 30 sekundene før mikspunktet: «Neste: Echo out – 8 takter igjen», med presetets farge og stegene ett om gangen.
 */
export function FxReminder({ compact = false }: { compact?: boolean }) {
  const { queue, index, positionMs } = usePlayer();
  const ideas = useFx((s) => s.ideas);
  const cur = queue[index];
  const next = queue[index + 1];
  const plan = useMemo(() => (cur ? reminderPlan(cur, next, index + 1 === queue.length - 1, ideas) : null), [cur, next, index, queue.length, ideas]);
  if (!plan) return null;
  const t = reminderText(positionMs, plan);
  if (!t) return null;
  const preset = plan.preset;
  const barsPart = t.head.slice(`Neste: ${preset.name}`.length);
  return (
    <div role="status" aria-live="polite" className={`rounded-xl border px-3 py-2 ${compact ? 'text-xs' : 'text-sm'}`} style={{ borderColor: `${preset.color}88`, background: `${preset.color}14` }}>
      <span className="font-semibold" style={{ color: preset.color }}>
        Neste: {preset.icon} {preset.name}
      </span>
      <span className="text-ink">{barsPart}</span>
      {t.step && <span className="ml-2 font-mono text-[11px] text-soft">{t.step}</span>}
    </div>
  );
}

/** «Idé for overgang» i fullskjermspilleren: ett trykk åpner raden, ett trykk til lagrer (med Angre). */
export function IdeaButton({ cur }: { cur: LoadedAsset }) {
  const [open, setOpen] = useState(false);
  const load = useFx((s) => s.load);
  const loaded = useFx((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="min-h-[48px] rounded-full border border-accent/50 px-4 text-sm font-semibold text-accent">
        Idé for overgang
      </button>
      {open && (
        <PresetRow
          onPick={(p) => {
            setOpen(false);
            void captureIdea(cur, p.id);
          }}
        />
      )}
    </div>
  );
}
