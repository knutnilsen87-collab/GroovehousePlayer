import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Analysis, AssetManifest } from '@gv/shared';

/**
 * Del 23 nivå 1: «Vault-cover» for låter uten cover. Lages av låtas egne data, uten nett og uten
 * tilfeldighet (samme låt gir alltid samme cover):
 *  - Farger fra tonearten: posisjonen på Camelot-hjulet gir fargetonen, så låter som passer harmonisk
 *    også ser beslektet ut. Dur (B) er lysere, moll (A) mørkere.
 *  - Form fra lyden: bølgeformen som en sirkulær «vinyl-ring», og spekteret som konsentriske ringer inni.
 *    Energien styrer intensitet og kontrast.
 *  - Typografi: tittel i Clash Display, «ECHO GROOVE» i sperret Syncopate, lite Groovehouse-merke.
 *    Umastrede låter får en diskret «UMASTRET»-linje.
 *
 * Erstatter det enkle reservecoveret fra delingen (del 10), og brukes både i spilleren og ved deling.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.resolve(here, '..', 'assets', 'fonts');
const CLASH = path.join(FONTS, 'ClashDisplay-Variable.ttf');
const SYNCOPATE = path.join(FONTS, 'Syncopate-Bold.ttf');
/** Versjon av tegningen. Øk når utseendet endres, så eksisterende Vault-cover lages på nytt. */
export const VAULT_COVER_VERSION = 1;

export interface VaultCoverInput {
  title: string;
  artist: string | null;
  slug: string;
  camelot: string | null;
  draft: boolean;
  analysis: Pick<Analysis, 'peaks' | 'energy' | 'spectrum'> | null;
}

export const coverInputOf = (m: AssetManifest, analysis: VaultCoverInput['analysis']): VaultCoverInput => ({
  title: m.title,
  artist: m.artist ?? 'Echo Groove',
  slug: m.slug,
  camelot: m.key?.camelot ?? null,
  draft: m.status === 'draft',
  analysis
});

// ---------------------------------------------------------------- farger

/** Fargetone (0–360) fra Camelot-koden: 1–12 rundt hjulet. Ukjent toneart: fra sluggen, svakere metning. */
export function camelotColors(camelot: string | null, slug: string): { hue: number; minor: boolean; known: boolean } {
  const m = /^(\d{1,2})([AB])$/i.exec(camelot ?? '');
  const n = m ? Number(m[1]) : 0;
  if (m && n >= 1 && n <= 12) return { hue: ((n - 1) * 30 + 150) % 360, minor: m[2]!.toUpperCase() === 'A', known: true };
  const h = parseInt(createHash('sha1').update(slug).digest('hex').slice(0, 4), 16);
  return { hue: h % 360, minor: true, known: false };
}

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${Math.round(h) % 360}, ${s}%, ${l}%, ${a})`;
/** Samme farge som #RRGGBB (Pango-markup godtar ikke hsl()). */
function hslHex(h: number, s: number, l: number): string {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => Math.round(255 * (L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- data fra lyden

function resample(xs: number[], n: number): number[] {
  if (!xs.length) return new Array(n).fill(0.3);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i / n) * xs.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / n) * xs.length));
    let mx = 0;
    for (let j = a; j < b && j < xs.length; j++) mx = Math.max(mx, Math.abs(xs[j]!));
    out.push(mx);
  }
  const top = Math.max(1e-6, ...out);
  return out.map((v) => v / top);
}

function bandMeans(an: VaultCoverInput['analysis']): number[] {
  const frames = an?.spectrum?.frames ?? [];
  const bands = an?.spectrum?.bands ?? 0;
  if (!frames.length || !bands) return [];
  const sum = new Array(bands).fill(0);
  for (const f of frames) for (let i = 0; i < bands; i++) sum[i] += f[i] ?? 0;
  const mean = sum.map((s) => s / frames.length);
  const top = Math.max(1e-6, ...mean);
  return mean.map((v) => v / top);
}

const energyOf = (an: VaultCoverInput['analysis']) => {
  const e = an?.energy ?? [];
  if (!e.length) return 0.5;
  const top = Math.max(1e-6, ...e);
  return Math.min(1, Math.max(0, e.reduce((a, b) => a + b, 0) / e.length / top));
};

// ---------------------------------------------------------------- tegning

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Grafikken (uten tekst) som SVG i `size` px. */
export function vaultCoverSvg(input: VaultCoverInput, size = 3000): string {
  const { hue, minor, known } = camelotColors(input.camelot, input.slug);
  const sat = known ? 82 : 45;
  const energy = energyOf(input.analysis);
  const accentL = minor ? 56 : 64;
  const bgTop = minor ? 9 : 15;
  const bgBot = minor ? 3 : 6;
  const h2 = hue + 30; // nabotonen på hjulet
  const S = size / 3000;
  const cx = 1500 * S;
  const cy = 1180 * S;

  // Vinyl-ringen: bølgeformen rundt sirkelen, rotert fast ut fra sluggen
  const N = 240;
  const peaks = resample(input.analysis?.peaks ?? [], N);
  const rot = (parseInt(createHash('sha1').update(input.slug).digest('hex').slice(0, 3), 16) % 360) * (Math.PI / 180);
  const r0 = 520 * S;
  const bars: string[] = [];
  for (let i = 0; i < N; i++) {
    const v = Math.pow(peaks[i]!, 1.2);
    const a = rot + (i / N) * Math.PI * 2;
    const len = (50 + v * (330 + 150 * energy)) * S;
    const x1 = cx + Math.cos(a) * r0;
    const y1 = cy + Math.sin(a) * r0;
    const x2 = cx + Math.cos(a) * (r0 + len);
    const y2 = cy + Math.sin(a) * (r0 + len);
    bars.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="url(#ring)" stroke-width="${(11 * S).toFixed(1)}" stroke-linecap="round" opacity="${(0.55 + 0.45 * v).toFixed(2)}"/>`);
  }
  // Spekteret: konsentriske ringer inni (bass ytterst, diskant innerst)
  const bands = bandMeans(input.analysis);
  const rings = bands
    .map((v, i) => {
      const r = (490 - (i / Math.max(1, bands.length)) * 290) * S;
      return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${hsl(i % 2 ? h2 : hue, sat, accentL)}" stroke-width="${(4 * S).toFixed(1)}" opacity="${(0.08 + 0.42 * v * (0.6 + 0.4 * energy)).toFixed(2)}"/>`;
    })
    .join('');
  const glow = (0.25 + 0.5 * energy).toFixed(2);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<defs>` +
    `<radialGradient id="bg" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="${hsl(hue, sat * 0.5, bgTop + 6)}"/><stop offset="0.6" stop-color="${hsl(h2, sat * 0.4, bgTop)}"/><stop offset="1" stop-color="${hsl(hue, 30, bgBot)}"/></radialGradient>` +
    `<radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="0.35" stop-color="${hsl(hue, sat, accentL, 0)}"/><stop offset="0.55" stop-color="${hsl(hue, sat, accentL, Number(glow))}"/><stop offset="1" stop-color="${hsl(h2, sat, accentL, 0)}"/></radialGradient>` +
    `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hsl(hue, sat, accentL + 8)}"/><stop offset="1" stop-color="${hsl(h2, sat, accentL)}"/></linearGradient>` +
    `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.72"/></linearGradient>` +
    `</defs>` +
    `<rect width="${size}" height="${size}" fill="url(#bg)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(1100 * S).toFixed(0)}" fill="url(#halo)"/>` +
    rings +
    bars.join('') +
    // Vinyl-etiketten i midten
    `<circle cx="${cx}" cy="${cy}" r="${(180 * S).toFixed(0)}" fill="${hsl(hue, sat * 0.4, minor ? 7 : 11)}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(180 * S).toFixed(0)}" fill="none" stroke="${hsl(hue, sat, accentL, 0.6)}" stroke-width="${(5 * S).toFixed(1)}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(22 * S).toFixed(0)}" fill="${hsl(hue, sat, accentL + 10)}"/>` +
    `<rect width="${size}" height="${size}" fill="url(#fade)"/>` +
    `</svg>`
  );
}

async function textLayer(markup: string, font: string, fontfile: string, width: number): Promise<Buffer> {
  return sharp({ text: { text: markup, font, fontfile, rgba: true, dpi: 72, width, wrap: 'word', align: 'left' } }).png().toBuffer();
}

/** Tittel (Clash Display), artist i sperret Syncopate, «UMASTRET» og merket – Vaults egen typografi oppå et bilde. */
async function typeLayers(input: VaultCoverInput, size: number, logo: string | null | undefined): Promise<sharp.OverlayOptions[]> {
  const S = size / 3000;
  const { hue, minor } = camelotColors(input.camelot, input.slug);
  const left = Math.round(190 * S);
  const maxW = Math.round(2620 * S);
  const title = input.title.length > 60 ? `${input.title.slice(0, 59)}…` : input.title;
  // Tittelstørrelsen krymper med lengden, så lange titler får plass på to linjer
  const pt = Math.round((title.length <= 14 ? 250 : title.length <= 24 ? 210 : 170) * S);
  const layers: sharp.OverlayOptions[] = [];
  const titleBuf = await textLayer(`<span foreground="#F5F7FA">${esc(title)}</span>`, `Clash Display Variable Bold ${pt}`, CLASH, maxW);
  const tm = await sharp(titleBuf).metadata();
  const artist = (input.artist ?? 'Echo Groove').toUpperCase();
  const capPt = Math.round(54 * S);
  const capBuf = await textLayer(`<span foreground="${hslHex(hue, 70, minor ? 74 : 80)}" letter_spacing="${Math.round(capPt * 1024 * 0.42)}">${esc(artist)}</span>`, `Syncopate Bold ${capPt}`, SYNCOPATE, maxW);
  const cm = await sharp(capBuf).metadata();
  const bottom = size - Math.round(200 * S);
  const titleTop = bottom - (tm.height ?? 0);
  layers.push({ input: capBuf, left, top: Math.max(0, titleTop - (cm.height ?? 0) - Math.round(36 * S)) });
  layers.push({ input: titleBuf, left, top: Math.max(0, titleTop) });
  if (input.draft) {
    const dPt = Math.round(40 * S);
    const dBuf = await textLayer(`<span foreground="#A3ACBA" letter_spacing="${Math.round(dPt * 1024 * 0.5)}">UMASTRET</span>`, `Syncopate Bold ${dPt}`, SYNCOPATE, maxW);
    layers.push({ input: dBuf, left, top: Math.round(170 * S) });
  }
  if (logo && existsSync(logo)) {
    const l = Math.round(230 * S);
    layers.push({ input: await sharp(logo).resize(l, l, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), left: size - l - Math.round(150 * S), top: Math.round(150 * S) });
  }
  return layers;
}

/** Ferdig Vault-cover som PNG (standard 3000×3000). */
export async function renderVaultCover(input: VaultCoverInput, opts: { size?: number; logo?: string | null } = {}): Promise<Buffer> {
  const size = opts.size ?? 3000;
  return sharp(Buffer.from(vaultCoverSvg(input, size)))
    .composite(await typeLayers(input, size, opts.logo))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Del 23 punkt 6 og 10: AI-bildet (uten tekst) skaleres til 3000×3000 RGB, og Vault legger tittel og artist
 * oppå med egen typografi, over en mørk toning nederst så teksten er lesbar.
 */
export async function overlayCoverText(image: Buffer, input: VaultCoverInput, opts: { size?: number; logo?: string | null } = {}): Promise<Buffer> {
  const size = opts.size ?? 3000;
  const base = await sharp(image).rotate().resize(size, size, { fit: 'cover' }).removeAlpha().toColourspace('srgb').png().toBuffer();
  const fade = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient></defs><rect width="${size}" height="${size}" fill="url(#f)"/></svg>`
  );
  return sharp(base)
    .composite([{ input: fade }, ...(await typeLayers(input, size, opts.logo))])
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Groovehouse-merket som legges i hjørnet (samme fil som lyttersiden bruker). */
export function vaultCoverLogo(root: string): string | null {
  const f = path.join(root, 'docs', 'design', 'groovehouse-logo-round.png');
  return existsSync(f) ? f : null;
}

/** Skriver Vault-coveret som `cover_vault.png` (3000 px) i versjonsmappa og returnerer stien. */
export async function writeVaultCover(dir: string, input: VaultCoverInput, logo: string | null): Promise<string> {
  const out = path.join(dir, 'cover_vault.png');
  const buf = await renderVaultCover(input, { logo });
  await writeFile(`${out}.tmp`, buf);
  await rename(`${out}.tmp`, out);
  return out;
}

/** Leser analysis.json i versjonsmappa (null hvis den mangler). */
export async function readAnalysis(dir: string, file = 'analysis.json'): Promise<VaultCoverInput['analysis']> {
  try {
    return JSON.parse(await readFile(path.join(dir, file), 'utf8')) as Analysis;
  } catch {
    return null;
  }
}
