# Groovehouse Vault – fase 1

Privat lytterom og arkiv for Groovehouse Records. Fase 1 kjører helt lokalt: ingest-motoren lager ferdige filer på disk, og web-appen spiller dem.

```
apps/web            Drop-side (lytter) + Command Center (admin) – Vite, React, TS, Tailwind, Zustand
packages/ingest     gh-ingest (CLI) + gh-watch (watcher) + make-fixtures
packages/shared     typer, palett med kontrastlås, navnekonvensjon, lyttedekning
supabase/migrations databaseskjema med RLS (testet mot Postgres 16)
docs/               oppdragsprompt, schema v0.1 og designfiler (visuell fasit)
media/              utdata fra ingest (gitignored)
fixtures/           testmapper (WAV gitignored – lag dem med make-fixtures)
```

## Oppsett på Windows

1. **Node 20+** og **pnpm**: `corepack enable` (eller `npm i -g pnpm`).
2. **ffmpeg** (inkl. ffprobe) på PATH: `winget install Gyan.FFmpeg`, åpne så et **nytt** terminalvindu og sjekk `ffmpeg -version`.
   Alternativt: sett `FFMPEG_PATH` og `FFPROBE_PATH` til full sti.
3. I prosjektmappa:
   ```powershell
   pnpm install
   pnpm test
   ```

## Prøv hele kjeden

```powershell
pnpm make-fixtures                      # lager fixtures/blue-fire og fixtures/live-sett-demo
pnpm gh-ingest fixtures/blue-fire       # HLS, bølgeform, LUFS, preview, palett → media/
pnpm gh-ingest fixtures/live-sett-demo  # sett: kapitler fra live_log.json, justert etter sync-klikket
pnpm dev                                # http://localhost:5173
```

- **Din spiller:** <http://localhost:5173/> (mobil og desktop – prøv å gjøre vinduet smalt)
- **Studio / Command Center:** <http://localhost:5173/studio>
- **Drop-siden (det lytteren ser):** <http://localhost:5173/drop/blue-fire-pitch?r=Jorrit>

### Din spiller

- **Mobil:** bunnmeny (Katalog, Live-sett, Søk, Studio), flytende mini-spiller (sveip for å bytte spor, trykk for fullskjerm), fullskjerm med stort cover, bølgeform med deler og store kontroller.
- **Desktop:** sidebar, presisjonstabell (klikk i bølgeform-kolonnen for å spille fra det punktet), transport-dock nederst.
- **Fargelagt bølgeform** i tre bånd: bass i `--accent-2`, mellomtone i `--accent`, diskant i en lys variant – alltid i coverets farger.
- **Strukturmarkører:** Intro, Build, Drop 1, Break, Drop 2, Outro foreslås av analysen. Hopp med ≪ ≫, Shift+←/→ eller låseskjermens spol-knapper.
- **Varianter:** én rad per låt. Bytter du fra Original til Extended, lander du i samme del (midt i Drop 1 → midt i Drop 1).
- **Live-sett:** «Spilles nå i settet» og «Gå til enkeltlåt» når kapittelet peker på en låt i katalogen. Sett fortsetter der du slapp.
- **Sub-bass-glød:** kantlinja over spilleren og gløden i rommet puster med bassen under 80 Hz, fra forhåndsberegnet data – virker likt på iPhone.
- **Søk (Ctrl/Cmd+K):** `126` (BPM ±1,5), `8A` (Camelot), `sett`, `extended`, tittel. Alle ord må treffe.
- **Snarveier:** Mellomrom = spill/pause, Shift+←/→ = forrige/neste del, Esc = lukk fullskjerm.

Kjører du `gh-ingest` på nytt med samme master, hoppes den over (hash). Bruk `--force` for å tvinge.

## Ekte musikk fra Reason

Mappekonvensjon i eksportmappa:

```
Export/
  would-you-run/
    would-you-run_v3.wav              ← mappenavn = slug, _v3 = versjon (over tid)
    would-you-run__extended_v2.wav    ← __extended = variant (samtidig versjon)
    would-you-run__vip-dub.wav        ← variant uten _vN = v1
    cover.png                         ← valgfri, men uten cover blir paletten gull
    meta.json                         ← valgfri, se under
    live_log.json                     ← kun for sett (se under)
```

`meta.json` (alt valgfritt):

```json
{
  "title": "Would You Run",
  "artist": "Echo Groove",
  "variants": { "extended": "Extended Mix", "vip-dub": "VIP Dub" },
  "bpm": 125,
  "camelot": "8A",
  "venue": "…",
  "performedAt": "2026-11-01"
}
```

`bpm` og `camelot` overstyrer analysen hvis den bommer.

```powershell
pnpm gh-ingest "C:\Users\<deg>\Music\Groovehouse\Export\would-you-run"
pnpm gh-watch  "C:\Users\<deg>\Music\Groovehouse\Export"   # overvåker og ingester automatisk
```

Watcheren venter til fila har stått stille i 4 s og ffprobe kan lese den, før den starter. Reason skriver bounce-fila gradvis.

### Live-sett og live_log.json

Echo Groove Lab (eller en hurtigtast) skriver tidspunkt mens settet spilles:

```json
{ "schema": 1, "events": [
  { "tMs": 0, "type": "sync" },
  { "tMs": 1500, "type": "track", "slug": "blue-fire", "label": "Blue Fire" },
  { "tMs": 380000, "type": "track", "slug": "would-you-run" },
  { "tMs": 512000, "type": "highlight", "label": "Publikum tar av" }
]}
```

`sync` er et kort, hørbart klikk som også havner i opptaket. Motoren finner klikket i lyden (første transient over −6 dBFS i de første 20 s) og forskyver alle markører. Finner den ikke klikket, merkes markørene «ubekreftet». Bommer det, juster med `--offset <ms>`.

## Hva ingest lager per versjon (`media/<slug>/v<N>/`)

| Fil | Innhold |
|---|---|
| `hls/index.m3u8` + `seg_*.ts` | AAC 256 kbps, 48 kHz, 6 s segmenter |
| `analysis.json` | 2000 peaks, bølgeform i 3 bånd, 1000 energiverdier, 8-bånds spektrum, sub-bass hvert 50. ms – driver all visualisering |
| `preview.m4a` | 30 s, starter rett før DROP (ellers 25 % inn), med fade |
| `cover.jpg`, `cover_300.jpg` | normalisert cover |
| `manifest.json` | alt over + BPM, toneart (Camelot), LUFS, avspillingsgain, palett, markører |

Filene havner i `media/<slug>/<variant eller main>/v<N>/`. `media/index.json` er katalogen web-appen leser.

### Analysen – hva den kan og ikke kan

- **BPM:** autokorrelasjon av basstransientene, 90–150 BPM, med preferanse for 115–135 ved oktavtvil. Treffer innen ±0,2 BPM på testfilene. Stigende/fallende tempo i et sett gir ett snitt.
- **Toneart:** Krumhansl–Schmuckler på kromagram (150 Hz–5 kHz). Sikkerheten vises i terminalen – lav sikkerhet betyr «sjekk med øret». Overstyr med `camelot` i `meta.json`.
- **Struktur:** fra energikurven, snappet til takt. Alt merkes som forslag (`confirmed: false`). Godkjenning/flytting i Command Center kommer i neste runde.
- **Ytelse (målt i testmiljøet):** ~10 s for en 3-minutters låt, 28 s for 10 minutter. Et 2-timers sett blir da rundt 5–6 minutter. Alt skjer i ett strømmepass, uten å laste hele fila i minnet.

## Beslutninger som er bygget inn

- **Ingen Web Audio API.** Avspilling via `<audio>` (native HLS i Safari, hls.js lastes bare i andre nettlesere) + Media Session. Visualisering fra `analysis.json`.
- **Coveret styrer fargene, gull bare i logoen** (endret 2026-11-14, se del 14 i CLAUDE_CODE_SETUP.md). Aksentfarger kommer kun fra `assets.palette` via CSS-variablene `--accent`, `--accent-2`, `--glow`. Paletten velger mest *levende* farge og løftes til ≥ 4.5:1 mot `#07080B`. Fargeløst cover → gull.
- **Volumnormalisering:** målnivå −14 LUFS via `audio.volume`. Det kan bare dempe; stille spor spilles på full styrke. iOS ignorerer `audio.volume` – der gjelder telefonens volumknapper.
- **Ingen Web Audio på mobil.** På desktop (Tauri) kan Web Audio brukes senere, f.eks. til automix i takt.
- **DROP-markør** foreslås fra energianalysen og lagres som `source: "analysis", confirmed: false`.
- **Lytter-UI på engelsk, admin på norsk** (`apps/web/src/lib/i18n.ts`).

## Supabase (forberedt, ikke koblet på ennå)

```powershell
npm i -g supabase   # eller scoop install supabase
supabase init       # lager config.toml – behold eksisterende migrations/
supabase start      # krever Docker Desktop
```

Migrasjonen lager alle tabeller med RLS. Kun brukere i `admins` har tilgang. Lyttere får aldri kontoer.

## Status

**Ferdig**
- Din spiller (`/`) for mobil og desktop – se over
- `gh-ingest`, `gh-watch`, `make-fixtures` – testet ende til ende
- Drop-side: gull → coverfarger ved avspilling, spolbar bølgeform, DROP-markør, kapitler for sett, sporliste, vannmerke med navn, utløp og nedtelling
- Command Center: drops, ingest-kort med stegstatus, mottakertabell med lyttedekning beregnet fra lyttehendelser, lyttelogg, arkiv, live-sett, mini-spiller
- Databasemigrasjon validert mot Postgres 16
- 28 enhetstester (palett, navn/varianter, lyttedekning, deler/variantbytte, live-logg, tempo, toneart, struktur)

**Eksempeldata:** drops, mottakere og lyttehendelser ligger i `apps/web/src/lib/seed.ts` til Supabase kobles på. Mottakernavn i klammer er plassholdere.

**Gjenstår**
- Godkjenne/flytte strukturmarkører i Command Center
- «Fortsett der du slapp» på tvers av PC og mobil: tabellen `playback_positions` finnes, men spilleren bruker localStorage per enhet til Supabase er koblet på
- Supabase-klient i web, Edge Functions: `create-invite`, `issue-play-token`, `log-event`
- Cloudflare Worker foran R2 (tokensjekk + m3u8-omskriving), opplasting med `gh-ingest --upload`
- Invitasjonstoken i stedet for `?r=<navn>`, enhetsbinding (`max_devices`)
- Vannmerke i selve lyden, klipp-eksport, katalogmatching for sett
- Tauri (desktop) og Capacitor (iPhone, med native bakgrunnslyd)
- Forenklet logo som SVG for ikoner og favicon
