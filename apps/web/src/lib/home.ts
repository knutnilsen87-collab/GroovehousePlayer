import { isDraft } from '@gv/shared/web';

/**
 * Del 27 pkt. 9: Hjem viser siste eksport fra Reason og uhørte nye versjoner først. «Ny» regnes etter
 * versjonens importtid (manifestet per versjon), ikke når låta først ble laget. Ren funksjon (testes).
 */
interface TrackLike {
  slug: string;
  main: { manifest: { createdAt: string; version: number; status?: 'release' | 'draft' } };
}
export interface HomeNews<T> {
  /** Nyeste release-klare eksport (null når ingen finnes). */
  latest: T | null;
  /** Nye versjoner du ikke har spilt etter at de kom (nyeste først). */
  unheard: T[];
}

export function homeNews<T extends TrackLike>(tracks: T[], lastPlayed: (slug: string) => string | undefined, opts: { now?: number; days?: number; max?: number } = {}): HomeNews<T> {
  const now = opts.now ?? Date.now();
  const since = now - (opts.days ?? 30) * 86_400_000;
  const byNew = [...tracks].sort((a, b) => b.main.manifest.createdAt.localeCompare(a.main.manifest.createdAt));
  // Siste eksport fra Reason = release-klar (umastrede kommer fra egne mapper)
  const latest = byNew.find((t) => !isDraft(t.main.manifest)) ?? null;
  const unheard = byNew
    .filter((t) => t !== latest && Date.parse(t.main.manifest.createdAt) >= since)
    .filter((t) => {
      const at = lastPlayed(t.slug);
      return !at || at < t.main.manifest.createdAt;
    })
    .slice(0, opts.max ?? 6);
  return { latest, unheard };
}
