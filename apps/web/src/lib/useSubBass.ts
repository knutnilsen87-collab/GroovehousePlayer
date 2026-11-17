import { useEffect, type RefObject } from 'react';
import { subEnvelope, useFullAsset, type LoadedAsset } from './catalog';
import { getPositionMs } from './player';

/**
 * Setter CSS-variabelen --sub (0..1) på elementet i takt med sub-bassen (< 80 Hz).
 * Leser den forhåndsberegnede 50 ms-konvolutten mot avspillingsposisjonen – ingen Web Audio,
 * så det virker likt på iPhone, Android og desktop. Rask attack, langsom release.
 */
export function useSubBass(ref: RefObject<HTMLElement>, assetIn: LoadedAsset | undefined, playing: boolean) {
  // Sub-bass-konvolutten finnes bare i full analyse og trengs kun når musikken faktisk spiller
  const asset = useFullAsset(playing ? assetIn : undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const env = asset ? subEnvelope(asset) : null;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!env || !playing || reduce) {
      el.style.setProperty('--sub', '0');
      return;
    }
    let raf = 0;
    let level = 0;
    const tick = () => {
      const idx = Math.floor(getPositionMs() / env.frameMs);
      const target = (env.values[idx] ?? 0) / 255;
      level = target > level ? level + (target - level) * 0.6 : level + (target - level) * 0.12;
      el.style.setProperty('--sub', level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.setProperty('--sub', '0');
    };
  }, [ref, asset, playing]);
}
