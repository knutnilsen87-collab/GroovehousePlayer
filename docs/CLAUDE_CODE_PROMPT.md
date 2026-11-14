# Oppdrag: Groovehouse Vault – fase 1

Du skal bygge første versjon av **Groovehouse Vault**: et privat lytterom og arkiv for plateselskapet mitt Groovehouse Records. Jeg legger ut egen musikk (låter, demoer, stems og hybride live-sett som bare inneholder mitt eget materiale), og deler den via personlige lenker med tilgangsnivåer. Jobb i faser og **stopp etter fase 1 for gjennomgang**. Spør før du installerer globale verktøy eller gjør noe som koster penger.

Kode, filnavn og identifikatorer på engelsk. UI-tekst ligger i en i18n-fil: admin på norsk, lytter-UI på engelsk (partnere er internasjonale).

## Referanser i denne mappa

- `Music_player/groovehouse_vault_schema.sql` – databaseskisse v0.1. Bruk den som utgangspunkt for første migrasjon; foreslå endringer i stedet for å avvike i stillhet.
- `Music_player/design/Main.dc.html` – drop-siden lytteren ser (mobil 390×844).
- `Music_player/design/CommandCenter.dc.html` – adminens Command Center.
- `Music_player/design/groovehouse-logo-round.png` – logo med ekte gjennomsiktighet.
Design-filene er HTML-mockups med inline-stiler og litt logikk. Bruk dem som visuell fasit (layout, farger, typografi, oppførsel), ikke som kode å kopiere.

## Låste beslutninger (ikke endre uten å spørre)

1. **Én kodebase.** Web-app (Vite + React + TypeScript + Tailwind + Zustand + Framer Motion). Desktop via Tauri og iPhone via Capacitor kommer i senere faser – ikke nå.
2. **Lytteren åpner en lenke i nettleseren.** Ingen konto, ingen app. iOS-PWA på hjemskjermen har upålitelig bakgrunnslyd, så drop-siden er en vanlig nettside, ikke en installerbar PWA.
3. **Bruk aldri Web Audio API / AnalyserNode** til visualisering eller avspilling. Avspilling skjer via `<audio>` (native HLS i Safari, hls.js ellers) + Media Session API. All visualisering (bølgeform, energi) drives av forhåndsberegnet analyse-JSON synkronisert mot `currentTime`.
4. **Coveret styrer fargene, gull bare i logoen** (endret 2026-11-14; erstatter «gullet er rammen», se del 14 i CLAUDE_CODE_SETUP.md). Navigasjon og kontroller bruker aksentfargen fra coveret. Glød, spilt del av bølgeform og aksenter på drop-siden tar fargene fra coveret. Alle aksentfarger går via CSS-variabler (`--accent`, `--accent-2`, `--glow`) satt fra `assets.palette`. **Ingen hardkodede aksent-hex i komponentene.**
   - Bakgrunn `#07080B`, flater `#0E1015` / `#0A0B0F`.
   - Gull (målt fra logoen): `linear-gradient(135deg, #F0DC6A 0%, #F0C030 45%, #B06000 100%)`. Ikke bruk `#FFD700`.
   - Tekst `#EDEAE2`, dempet `#A39E91`, champagne `#C9B98E`.
   - Fonter: Oswald 500/600 (titler, versaler, sporing), Inter 400–600 (UI). Tabulære tall for tid/BPM.
   - Gull dekker under ~10 % av flaten og markerer bare aktivt/primært.
5. **Lyttere har ingen Supabase-kontoer.** Kun admin (meg) logger inn med Supabase Auth. Lyttere identifiseres via invitasjonstoken; bare hash av tokenet lagres.
6. **Lyd er privat.** R2-bucketen er aldri offentlig. En Cloudflare Worker foran R2 validerer et kortlevd signert token (HMAC, utstedt av en Supabase Edge Function etter tokensjekk) og serverer HLS-spillelister og segmenter. Spillelister skrives om slik at hvert segment-kall bærer tokenet. Original-WAV er kun tilgjengelig for admin.
7. **Strømmeformat:** HLS, AAC 256 kbps. Ikke merk noe som «WAV» eller «Hi-Res» i lytter-UI.
8. **Hemmeligheter** (Supabase service role, R2-nøkler, HMAC-secret) aldri i repoet. Lokalt via Windows Credential Manager eller en `.env` som er gitignored; lever `.env.example`.

## Struktur (pnpm-monorepo)

```
apps/web            – drop-side (lytter) + Command Center (admin)
apps/media-worker   – Cloudflare Worker: tokensjekk + R2-strømming + m3u8-omskriving
packages/ingest     – Node CLI «gh-ingest» + watcher
packages/shared     – typer, palett-/fargeverktøy, i18n
supabase/           – migrasjoner, Edge Functions (issue-play-token, log-event, create-invite)
```

## Ingest-motoren (`packages/ingest`) – kjernen i fase 1

Motoren er et CLI (`gh-ingest <mappe>`); watcheren er bare én måte å starte den på.

- **Mappekonvensjon:** `Export/<slug>/<slug>_v<N>.wav`, valgfri `cover.png|jpg`, valgfri `live_log.json`. Mappenavn = slug, `_vN` = versjon (`parent_id`/`version_label`). Samme slug + ny versjon = ny versjon, ikke nytt asset.
- **Watcher:** `chokidar` med `awaitWriteFinish` + ekstra stabilitetssjekk (størrelse uendret + `ffprobe` lykkes) før prosessering. Reason skriver filen gradvis.
- **Steg (lokalt, med ffmpeg):**
  1. `ffprobe`: varighet, samplerate, kanaler.
  2. HLS AAC 256k, 6 s segmenter.
  3. Analyse-JSON fra dekodet PCM (ffmpeg → Node, ingen ekstra binærer): peaks for bølgeform (f.eks. 2000 punkter), energikurve, grovt spektrum per tidssteg.
  4. LUFS via ffmpeg `ebur128`; lagre avspillingsjustering (gain), endre aldri masteren.
  5. 30 s forhåndsvisning (for Teaser-nivå); start ved første DROP-markør hvis den finnes, ellers 25 % inn.
  6. Palett fra cover: `sharp` + `node-vibrant`, velg *mest levende* farge (ikke mest dominerende), clamp lyshet/metning i OKLCH (`culori`) slik at aksenten har ≥ 4.5:1 mot `#07080B`. Fargeløst cover → fallback gull, `source: "fallback"`.
  7. Last opp HLS, analyse, preview og cover til R2; master-WAV lastes opp i bakgrunnen (lagringsklasse for sjelden tilgang) og blokkerer ikke at utkastet blir spillbart.
  8. Skriv `assets` (+ `asset_markers` fra `live_log.json`) via en admin-autentisert Edge Function, ikke med service role-nøkkel direkte fra klienten.
- **Live-logg og sync-anker (fase 2, men design datamodellen for det nå):** Echo Groove Lab skriver tidspunkt + låt-ID mens settet spilles, og sender et hørbart sync-klikk i starten. Motoren finner klikket i lyden og forskyver alle markører. Admin kan i tillegg justere global offset.
- Idempotent: kjøres to ganger på samme fil → ingen duplikater (hash av master).

## Fase 1 – ferdig når

1. `pnpm gh-ingest ./fixtures/<slug>` på én ekte WAV + cover produserer HLS, analyse-JSON, LUFS, preview og palett **lokalt** (uten sky), med en rapport i terminalen. Tester for palett-clamp og versjonsparsing.
2. Supabase-migrasjon fra schemaet kjører lokalt (`supabase start`), med RLS på alle tabeller.
3. Drop-siden i `apps/web` spiller en lokalt generert HLS-strøm, viser bølgeform fra analyse-JSON, bytter fra gull (før avspilling) til coverfarger (under avspilling) via CSS-variabler, har spolbar bølgeform (tilgjengelig `<input type="range">`), DROP-markør, sporliste og diagonalt navnevannmerke på 5 % opasitet. Ser ut som `design/Main.dc.html`.
4. Command Center viser drops-listen, ingest-køen med stegstatus og mottakertabellen med lyttedekning og lyttelogg, mot seed-data. Ser ut som `design/CommandCenter.dc.html`.
5. `README.md` med oppsett på Windows (ffmpeg-installasjon, pnpm, Supabase CLI) og en kort oversikt over hva som gjenstår.

Ikke i fase 1: R2-opplasting i produksjon, media-worker i produksjon, vannmerke i lyd, klipp-eksport, Tauri, Capacitor, katalogmatching.

## Arbeidsmåte

- Start med å lese referansefilene og legg fram en kort plan (mappestruktur, avhengigheter, rekkefølge). Vent på mitt OK før du skriver kode.
- Små, verifiserbare steg. Kjør det du bygger. Si tydelig fra hvis noe ikke fungerer i stedet for å anta at det gjør det.
- Si fra hvis en låst beslutning over kolliderer med noe teknisk du oppdager.
