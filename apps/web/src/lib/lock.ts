import { DRAFT_BASE } from '@gv/shared/web';

/** Del 27 pkt. 7–8: versjonslås i lister og sett. Rene funksjoner (testes uten React). */

/** «v3», og for umastrede «umastret v3» (utkast har egne nummer over DRAFT_BASE). */
export const lockVersionLabel = (n: number) => (n > DRAFT_BASE ? `umastret v${n - DRAFT_BASE}` : `v${n}`);
export interface AddItem {
  slug: string;
  variant: string | null;
  /** null = følg nyeste versjon. */
  version?: number | null;
  /** Del 16: bare i klienten – låta er et utkast (sendes ikke til serveren). */
  draft?: boolean;
  /** Del 27: bare i klienten – versjonen som vises nå (låses når lista er et sett). */
  shown?: { version: number; title: string; variantLabel: string | null };
}

/**
 * Hva som lagres. Vanlige lister følger nyeste versjon (som før). I et sett (Sett-plan) låses hver låt til
 * versjonen som vises, så en ny bounce ikke flytter cue-punktene. Bare slug, variant og versjon sendes.
 */
export function entriesToSave(items: AddItem[], plan: 'album' | 'set' | null | undefined): Array<{ slug: string; variant: string | null; version: number | null }> {
  return items.map(({ slug, variant, version, shown }) => ({ slug, variant, version: version ?? (plan === 'set' && shown ? shown.version : null) }));
}

/** Låtene som får versjonen låst nå (vises i bekreftelsen). */
export const newlyLocked = (items: AddItem[], plan: 'album' | 'set' | null | undefined) =>
  plan === 'set' ? items.filter((i) => i.version == null && i.shown).map((i) => ({ title: i.shown!.title, variantLabel: i.shown!.variantLabel, version: i.shown!.version })) : [];
