import type { ReactNode } from 'react';
import { useHints, type HintId } from '../lib/hints';

/**
 * Del 27 pkt. 16: et stille hint (ingen modal, tar ikke fokus). Lukkes med × eller ved å bruke handlingen,
 * og vises ikke igjen på denne enheten før «Vis hint igjen» i Innstillinger → Hjelp.
 */
export function Hint({ id, children, action, className = '' }: { id: HintId; children: ReactNode; action?: { label: string; run: () => void }; className?: string }) {
  const seen = useHints((s) => s.seen[id]);
  if (seen) return null;
  const close = () => useHints.getState().dismiss(id);
  return (
    <div role="status" data-hint={id} className={`gv-glass flex items-center gap-2 rounded-xl border border-accent/40 bg-surface/95 py-1 pl-3 pr-1 text-[13px] text-ink shadow-[0_8px_28px_rgba(0,0,0,0.45)] ${className}`}>
      <span className="min-w-0 flex-1">{children}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            close();
            action.run();
          }}
          className="h-11 flex-none rounded-full px-3 text-[13px] font-semibold text-accent hover:bg-white/[0.06] lg:h-9"
        >
          {action.label}
        </button>
      )}
      <button type="button" onClick={close} aria-label="Lukk hintet" className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-muted hover:bg-white/[0.06] hover:text-ink lg:h-9 lg:w-9">
        <span aria-hidden="true" className="text-lg leading-none">×</span>
      </button>
    </div>
  );
}
