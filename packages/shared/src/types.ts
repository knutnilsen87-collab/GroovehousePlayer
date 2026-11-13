/**
 * Delte typer. De speiler tabellene i supabase/migrations/0001_init.sql.
 * Ingest-motoren skriver `AssetManifest` til media/<slug>/v<N>/manifest.json,
 * og web-appen leser det samme formatet. I fase 2 blir manifestet en rad i `assets`.
 */

export type AssetKind = 'track' | 'set' | 'demo' | 'stem';
export type AccessTier = 'inner' | 'partner' | 'supporter' | 'teaser';
export type MarkerKind = 'chapter' | 'highlight' | 'drop' | 'clip';
export type MarkerSource = 'manual' | 'catalog_match' | 'live_log' | 'analysis';
export type ListenEventType = 'open' | 'play' | 'pause' | 'seek' | 'heartbeat' | 'ended';

export interface Palette {
  /** Lesbar aksent: ≥ 4.5:1 mot bakgrunnen #07080B. */
  primary: string;
  /** Sekundærfarge til glød og overganger. Ingen kontrastkrav. */
  secondary: string;
  /** Tekstfarge oppå en flate i `primary`. */
  onPrimary: string;
  source: 'cover' | 'fallback';
}

export interface AssetMarker {
  kind: MarkerKind;
  source: MarkerSource;
  startMs: number;
  endMs?: number;
  label?: string;
  refSlug?: string;
  confidence?: number;
  confirmed: boolean;
}

export interface Loudness {
  integratedLufs: number;
  truePeakDbtp: number | null;
  lra: number | null;
  /** Gain som legges på ved avspilling (via audio.volume). Masteren endres aldri. */
  playbackGainDb: number;
}

export interface MusicalKey {
  /** f.eks. "A minor" */
  name: string;
  /** Camelot-notasjon, f.eks. "8A" */
  camelot: string;
  confidence: number;
}

export interface AssetManifest {
  schema: 1;
  id: string;
  slug: string;
  /** Samtidig variant av samme låt: null = hovedversjon, ellers f.eks. "extended", "radio-edit", "vip-dub". */
  variant: string | null;
  variantLabel: string | null;
  /** Versjon over tid (_vN i filnavnet). */
  version: number;
  versionLabel: string | null;
  kind: AssetKind;
  title: string;
  artist: string | null;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bpm: number | null;
  bpmConfidence: number | null;
  key: MusicalKey | null;
  masterSha256: string;
  masterFile: string;
  loudness: Loudness;
  palette: Palette;
  markers: AssetMarker[];
  performedAt: string | null;
  venue: string | null;
  files: {
    hls: string;
    analysis: string;
    preview: string;
    cover: string | null;
    coverThumb: string | null;
  };
  createdAt: string;
}

export interface Analysis {
  schema: 1;
  durationMs: number;
  /** Maks absoluttverdi per bøtte, 0..1. Brukes til bølgeformen. */
  peaks: number[];
  /** RMS per bøtte, normalisert til 0..1. Brukes til energikurve og glød. */
  energy: number[];
  /** Grovt spektrum: `bands` logaritmiske bånd per ramme, normalisert 0..1. */
  spectrum: { bands: number; frameMs: number; frames: number[][] };
  /** Lav (< 150 Hz), mid og høy (> 2,5 kHz) per peak-bøtte, hver normalisert 0..1. Driver den fargelagte bølgeformen. */
  bands3: { low: number[]; mid: number[]; high: number[] };
  /** Sub-bass-konvolutt (< 80 Hz) med 50 ms oppløsning, Uint8 (0–255) som base64. Driver sub-bass-gløden. */
  sub: { frameMs: number; b64: string };
}

export interface CatalogIndex {
  schema: 1;
  updatedAt: string;
  assets: Array<{ slug: string; variant: string | null; version: number; manifest: string; title: string; kind: AssetKind }>;
}

export interface ListenEvent {
  event: ListenEventType;
  positionMs: number;
  toMs?: number;
  at: string;
}
