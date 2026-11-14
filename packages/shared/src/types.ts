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
  /** manual = valgt i Studio (del 8), overlever ny ingest. */
  source: 'cover' | 'fallback' | 'manual';
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

/** Del 14: formatet til kildefila, f.eks. «WAV 24-bit / 48 kHz». */
export interface SourceFormat {
  /** WAV, AIFF, FLAC … (null = ukjent, f.eks. når kildefila ikke er kjent lenger) */
  container: string | null;
  bitDepth: number | null;
  float: boolean;
  sampleRate: number;
  label: string;
}

/** Del 14: 48 log-bånd, Uint8 per bånd og ramme, i egen binærfil ved siden av analysis.json. */
export interface Spectrum48Info {
  bands: number;
  fps: number;
  minHz: number;
  maxHz: number;
  frames: number;
  /** Filnavn i versjonsmappa (rå Uint8, frames × bands). */
  file: string;
}

/** Øk når analysen får nye felt; `gh-ingest --backfill-analysis` fyller inn for eldre versjoner. */
export const ANALYSIS_VERSION = 2;

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
  /** Album. Uten meta.json: låttittelen (singel). Aldri labelnavnet. */
  album: string | null;
  /** Plateselskap, f.eks. "Groovehouse Records". */
  label: string | null;
  /** f.eks. "℗ 2026 Groovehouse Records" – året er filens år. */
  copyright: string | null;
  /** Tittelen kom fra et filnavn i bare versaler og bør sjekkes i Studio. */
  titleNeedsReview?: boolean;
  /** Verdiene ingest kom fram til uten Studio-overstyringer. Tømmes et felt i Studio, gjelder disse igjen. */
  sourceMeta?: {
    title: string;
    artist: string | null;
    album: string | null;
    label: string | null;
    copyright: string | null;
    variantLabel: string | null;
    venue: string | null;
  };
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Del 14: kildeformatet («WAV 24-bit / 48 kHz»). Strømmes uansett som AAC 256 kbps. */
  sourceFormat?: SourceFormat;
  bpm: number | null;
  bpmConfidence: number | null;
  key: MusicalKey | null;
  masterSha256: string;
  /** Hash av coverfila (null = gull). Nytt cover gir ny ingest selv om lyden er uendret. */
  coverSha256: string | null;
  loudness: Loudness;
  palette: Palette;
  markers: AssetMarker[];
  /** Live-sett: manuell forskyvning av markørene (ms) fra Studio, i tillegg til sync-klikket. */
  liveOffsetMs?: number;
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
  /** Mangler = 1. Se ANALYSIS_VERSION. */
  version?: number;
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
  /** Del 14 (versjon 2): spektrum til «Spektrum (Hz)»-panelet. */
  spectrum48?: Spectrum48Info;
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
