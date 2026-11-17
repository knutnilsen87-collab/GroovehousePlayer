import { create } from 'zustand';
import type { LoadedAsset } from './catalog';

/** Samme brytepunkt som Tailwind `lg`: desktop-oppsett (sidemeny, kontekstmenyer, klikk velger). */
export const isDesktop = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

/** Ekstra valg som bare gjelder der menyen ble åpnet (f.eks. låsing og fjerning i en spilleliste). */
export type ExtraAction =
  | { label: string; danger?: boolean; run: () => void }
  | { label: string; options: Array<{ label: string; checked: boolean; run: () => void }> };

export interface ActionsRequest {
  /** Låta/låtene menyen gjelder – nøyaktig versjonen og varianten som vises eller spilles. */
  assets: LoadedAsset[];
  /** «now» = låta som spilles (Vis køen, spol til seksjon); «row» = en rad i en liste. */
  context: 'row' | 'now';
  /** Desktop: åpne ved musepekeren/knappen. Mobil: alltid ark nederfra. */
  anchor?: { x: number; y: number } | null;
  extra?: ExtraAction[];
}

export interface AddSheetRequest {
  assets: LoadedAsset[];
  anchor?: { x: number; y: number } | null;
}

interface UiState {
  actions: ActionsRequest | null;
  openActions: (r: ActionsRequest) => void;
  closeActions: () => void;
  addSheet: AddSheetRequest | null;
  openAddSheet: (r: AddSheetRequest) => void;
  closeAddSheet: () => void;
  queueOpen: boolean;
  setQueueOpen: (open: boolean) => void;
  /** Del 10: «Del…» for denne låta (nøyaktig versjonen/varianten som vises). */
  share: LoadedAsset | null;
  openShare: (a: LoadedAsset) => void;
  closeShare: () => void;
  /** Del 27: importstatus (mapper, «Ser etter låter …», siste import). */
  importOpen: boolean;
  setImportOpen: (open: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  actions: null,
  openActions: (actions) => set({ actions }),
  closeActions: () => set({ actions: null }),
  addSheet: null,
  openAddSheet: (addSheet) => set({ addSheet, actions: null }),
  closeAddSheet: () => set({ addSheet: null }),
  queueOpen: false,
  setQueueOpen: (queueOpen) => set({ queueOpen, actions: null }),
  share: null,
  openShare: (share) => set({ share, actions: null }),
  closeShare: () => set({ share: null }),
  importOpen: false,
  setImportOpen: (importOpen) => set({ importOpen, actions: null })
}));
