import type { ReactNode } from 'react';
import { useFullAsset, type LoadedAsset } from '../lib/catalog';

/**
 * Viser innholdet først når det fulle manifestet er hentet. Brukes rundt alt som redigerer og lagrer en låt:
 * katalogen har bare et slankt manifest (uten album, label, copyright og alle markørtyper), og lagring fra det
 * ville slettet data.
 */
export function FullAsset({ a, children }: { a: LoadedAsset; children: (full: LoadedAsset) => ReactNode }) {
  const full = useFullAsset(a);
  if (full.slim) return <p className="m-0 px-1 py-3 text-sm text-muted">Henter låtdata …</p>;
  return <>{children(full)}</>;
}
