/**
 * Mappekonvensjon: Export/<slug>/<slug>[__<variant>]_v<N>.wav
 * Mappenavnet er slug. `__extended` gir variant. `_vN` gir versjon. Mangler `_vN` er det versjon 1.
 *   would-you-run_v3.wav            → hovedversjon, v3
 *   would-you-run__extended_v2.wav  → variant "extended", v2
 */
export interface ParsedName {
  slug: string;
  variant: string | null;
  version: number;
  /** true hvis filnavnets slug ikke stemmer med mappenavnet. Mappenavnet vinner. */
  slugMismatch: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/æ/gi, 'ae')
    .replace(/ø/gi, 'o')
    .replace(/å/gi, 'a')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseMasterName(folderName: string, fileName: string): ParsedName {
  const slug = slugify(folderName);
  if (!SLUG_RE.test(slug)) throw new Error(`Ugyldig mappenavn for slug: "${folderName}"`);
  const base = fileName.replace(/\.(wav|wave|aif|aiff|flac)$/i, '');
  const m = base.match(/^(.*?)[_-]v(\d{1,4})$/i);
  const rest = m ? m[1]! : base;
  const version = m ? parseInt(m[2]!, 10) : 1;
  if (version < 1) throw new Error(`Ugyldig versjon i "${fileName}"`);
  const vi = rest.indexOf('__');
  const fileSlug = slugify(vi >= 0 ? rest.slice(0, vi) : rest);
  const variantRaw = vi >= 0 ? slugify(rest.slice(vi + 2)) : '';
  const variant = variantRaw && variantRaw !== 'main' && variantRaw !== 'original' ? variantRaw : null;
  return { slug, variant, version, slugMismatch: fileSlug !== slug };
}

export function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function formatTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
