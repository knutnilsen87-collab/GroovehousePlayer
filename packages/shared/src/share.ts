/**
 * Del en låt som fil (del 10). Rene funksjoner, brukt av både serveren (filnavn i Content-Disposition)
 * og klienten (teksten som følger med i WhatsApp/e-post).
 */
export type ShareKind = 'full' | 'preview' | 'wav';

/** Tegn Windows ikke tåler i filnavn, pluss kontrolltegn. æøå og apostrofer beholdes. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFileName(name: string): string {
  let s = name.normalize('NFC').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, ''); // Windows: ikke punktum/mellomrom til slutt
  if (!s || RESERVED.test(s)) s = `Groovehouse ${s}`.trim();
  return s.slice(0, 180);
}

/** «Echo Groove - Tittel.m4a» eller «Echo Groove - Tittel (Extended).m4a». */
export function shareFileName(o: { artist?: string | null; title: string; variantLabel?: string | null; kind: ShareKind }): string {
  const artist = o.artist?.trim() || 'Echo Groove';
  const variant = o.variantLabel?.trim() ? ` (${o.variantLabel.trim()})` : '';
  const preview = o.kind === 'preview' ? ' (smakebit)' : '';
  const ext = o.kind === 'wav' ? 'wav' : 'm4a';
  return `${sanitizeFileName(`${artist} - ${o.title}${variant}${preview}`)}.${ext}`;
}

/**
 * Teksten som følger med fila. INGEN URL, vertsnavn eller IP – Tailscale-adressen og LAN-IP-en skal
 * aldri havne i en delt melding. Alt som ligner en adresse fjernes for sikkerhets skyld.
 */
export function shareText(o: { artist?: string | null; title: string }): string {
  const clean = (s: string) =>
    s
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '')
      .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:ts\.net|local|lan|home|internal)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  return `${clean(o.artist?.trim() || 'Echo Groove')} – ${clean(o.title)} · Groovehouse Records`;
}

/** Omtrentlig størrelse før fila hentes (vises i del-arket). */
export function estimateShareBytes(kind: ShareKind, m: { durationMs: number; sampleRate?: number; channels?: number }): number {
  const s = m.durationMs / 1000;
  if (kind === 'full') return Math.round((s * 256_000) / 8 + 200_000);
  if (kind === 'preview') return Math.round((30 * 256_000) / 8 + 200_000);
  return Math.round(s * (m.sampleRate ?? 44_100) * (m.channels ?? 2) * 2 + 44);
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}
