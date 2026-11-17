import { create } from 'zustand';

/**
 * Del 27 pkt. 16: stille hint. Vises når de trengs, kan lukkes og vises bare én gang per enhet.
 * Lagres som `gv:hint:<id>` = '1' i localStorage (ingen sensitive data). «Vis hint igjen» i Innstillinger → Hjelp.
 * DJ-låsen (DjLock) bruker samme nøkkelform (`gv:hint:dj-lock`).
 */
export const HINT_IDS = ['save-to-list', 'dj-lock', 'unmastered'] as const;
export type HintId = (typeof HINT_IDS)[number];

const key = (id: HintId) => `gv:hint:${id}`;

function read(): Record<HintId, boolean> {
  const out = {} as Record<HintId, boolean>;
  for (const id of HINT_IDS) {
    try {
      out[id] = localStorage.getItem(key(id)) === '1';
    } catch {
      out[id] = false;
    }
  }
  return out;
}

export const useHints = create<{ seen: Record<HintId, boolean>; dismiss: (id: HintId) => void; reset: () => void }>((set) => ({
  seen: typeof localStorage !== 'undefined' ? read() : ({ 'save-to-list': false, 'dj-lock': false, unmastered: false } as Record<HintId, boolean>),
  dismiss: (id) => {
    try {
      localStorage.setItem(key(id), '1');
    } catch {
      /* privat modus: hintet vises igjen neste gang */
    }
    set((s) => ({ seen: { ...s.seen, [id]: true } }));
  },
  reset: () => {
    for (const id of HINT_IDS) {
      try {
        localStorage.removeItem(key(id));
      } catch {
        /* privat modus */
      }
    }
    set({ seen: read() });
  }
}));
