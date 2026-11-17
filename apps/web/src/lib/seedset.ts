import { create } from 'zustand';

/**
 * Del 20 E: «Lag sett fra denne» og «Mer som denne». Forespørselen settes fra ⋯-menyen, fullskjermspilleren
 * eller et langt trykk på hjertet; spilleren (som har hele katalogen) tar imot og åpner settbyggeren eller
 * lager køen.
 */
export interface SeedRequest {
  slug: string;
  variant?: string | null;
  /** Asset-id når den er kjent (riktig variant og versjon). */
  id?: string;
  title: string;
  /** Øker for hver forespørsel, så samme låt to ganger på rad også bygger på nytt. */
  nonce: number;
}

interface SeedState {
  seedSet: SeedRequest | null;
  moreLike: SeedRequest | null;
  openSeedSet: (r: Omit<SeedRequest, 'nonce'>) => void;
  openMoreLike: (r: Omit<SeedRequest, 'nonce'>) => void;
  clearSeedSet: () => void;
  clearMoreLike: () => void;
}

let nonce = 0;
export const useSeedSet = create<SeedState>((set) => ({
  seedSet: null,
  moreLike: null,
  openSeedSet: (r) => set({ seedSet: { ...r, nonce: ++nonce } }),
  openMoreLike: (r) => set({ moreLike: { ...r, nonce: ++nonce } }),
  clearSeedSet: () => set({ seedSet: null }),
  clearMoreLike: () => set({ moreLike: null })
}));

/** Lite haptisk svar på mobil (Android: krever VIBRATE i manifestet). Gjør ingenting på PC. */
export function haptic(ms = 12): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator && matchMedia('(pointer: coarse)').matches) navigator.vibrate(ms);
  } catch {
    /* ikke støttet */
  }
}
