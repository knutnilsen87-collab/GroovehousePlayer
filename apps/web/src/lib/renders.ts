import { create } from 'zustand';
import type { LoadedAsset } from './catalog';
import { usePlayer } from './player';

/**
 * Del 20 C: «Hør overgangen». Vault lager overgangen (ffmpeg på PC-en), og den spilles her som vanlig lyd i et
 * <audio>-element – ingen Web Audio, så det virker likt på mobil og i appen. Fila hentes med fetch (så appen sender
 * enhetstokenet) og spilles fra en blob-URL. Hovedspilleren pauses mens overgangen spilles.
 */
export interface RenderQuality {
  ok: boolean;
  offsetMs: number | null;
  bassClash: boolean;
  vocalClash: boolean;
  levelJumpDb: number;
  notes: string[];
}
export interface RenderInfo {
  id: string;
  url: string;
  preset: string;
  presetName: string;
  bars: number;
  kind: 'blend' | 'short';
  durationMs: number;
  quality: RenderQuality;
  alternative?: Omit<RenderInfo, 'alternative'>;
}

const ref = (a: LoadedAsset) => ({ slug: a.manifest.slug, variant: a.manifest.variant ?? null, version: a.manifest.version });

export async function makeRender(from: LoadedAsset, to: LoadedAsset, preset: string | null): Promise<RenderInfo> {
  const r = await fetch('/api/renders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: ref(from), to: ref(to), preset }) });
  const j = (await r.json().catch(() => ({}))) as RenderInfo & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Feil ${r.status}`);
  return j;
}

export async function sendFeedback(from: LoadedAsset, to: LoadedAsset, preset: string, vote: 1 | -1) {
  await fetch('/api/renders/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: from.manifest.slug, to: to.manifest.slug, preset, vote }) });
}

interface PreviewState {
  playingId: string | null;
  loadingId: string | null;
  play: (r: { id: string; url: string }) => Promise<void>;
  stop: () => void;
}
let audio: HTMLAudioElement | null = null;
const blobs = new Map<string, string>();

export const usePreview = create<PreviewState>((set, get) => ({
  playingId: null,
  loadingId: null,
  play: async (r) => {
    get().stop();
    set({ loadingId: r.id });
    try {
      let src = blobs.get(r.id);
      if (!src) {
        const res = await fetch(r.url);
        if (!res.ok) throw new Error(`Feil ${res.status}`);
        src = URL.createObjectURL(await res.blob());
        blobs.set(r.id, src);
      }
      if (usePlayer.getState().playing) usePlayer.getState().toggle();
      audio = new Audio(src);
      audio.onended = () => set({ playingId: null });
      await audio.play();
      set({ playingId: r.id, loadingId: null });
    } catch (err) {
      set({ loadingId: null });
      throw err;
    }
  },
  stop: () => {
    audio?.pause();
    audio = null;
    set({ playingId: null });
  }
}));
