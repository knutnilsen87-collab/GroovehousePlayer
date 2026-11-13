# Før du starter (for deg, Knut – ikke en del av prompten)

Koden ligger i GitHub-repoet `knutnilsen87-collab/GroovehousePlayer`. Åpne et **vanlig** PowerShell-vindu (ikke som administrator):

```powershell
git clone https://github.com/knutnilsen87-collab/GroovehousePlayer.git F:\prosjekter_MAIN\GroovehousePlayer
cd F:\prosjekter_MAIN\GroovehousePlayer
claude
```

(Mappa må være tom for at `git clone` skal virke. Det er den nå.)

Skriv: **«Les CLAUDE_CODE_SETUP.md og følg prompten under streken. Start med del 0.»**

Får du `'claude' is not recognized`: kjør `irm https://claude.ai/install.ps1 | iex`, åpne et nytt PowerShell-vindu og prøv igjen.

---

# Oppdrag: Sett opp Groovehouse Vault på denne PC-en og fullfør det som mangler

Du jobber på Knuts stasjonære Windows-PC. Prosjektets rotmappe er `F:\prosjekter_MAIN\GroovehousePlayer`. Groovehouse Vault er hans private spiller og arkiv for egen musikk (låter, demoer, varianter og hybride live-sett, kun eget materiale). Kodebasen er klonet fra GitHub (`knutnilsen87-collab/GroovehousePlayer`, gren `main`) til rotmappa. **Les `README.md` og `docs/CLAUDE_CODE_PROMPT.md` før du gjør noe**: der står arkitekturen og beslutningene som er låst.

## Arbeidsmåte

- Jobb i delene under, i rekkefølge. Legg fram en kort plan per del, og **vent på OK** før du gjør endringer.
- **Spør før** du installerer programmer (winget, npm -g), lager planlagte oppgaver, snarveier eller brannmurregler, eller skriver utenfor `F:\prosjekter_MAIN\GroovehousePlayer`.
- Kjør det du bygger. Etter hver del: `pnpm test`, `pnpm typecheck`, og en faktisk sjekk av det delen skulle levere. Si tydelig fra hvis noe ikke virker, i stedet for å anta at det gjør det.
- Hemmeligheter (Supabase-nøkler, PIN) skal aldri i git eller i chatten. Bruk `.env` (gitignored) eller Windows Credential Manager.
- Ikke endre de låste beslutningene uten å spørre: ingen Web Audio på mobil, aksentfarger kun fra `assets.palette` via CSS-variabler, gull som ramme, HLS AAC 256 kbps, ingest som CLI med watcher som trigger.
- Kode og identifikatorer på engelsk. UI-tekst: spiller og admin på norsk, lytterside (`/drop/...`) på engelsk.

## Del 0 – Oppsett og grønn start

1. Sjekk at `package.json`, `apps/`, `packages/`, `supabase/` og `docs/` ligger i rotmappa, og at `git status` er ren. Ikke init git på nytt. Jobb på en egen gren per del (`setup/del-0` osv.) og spør før du pusher til GitHub.
2. Sjekk og installer det som mangler, etter å ha spurt:
   - Node 20+ (`node -v`)
   - pnpm (`corepack enable`)
   - ffmpeg og ffprobe på PATH (`winget install Gyan.FFmpeg`). Sjekk i et nytt skall etterpå.
3. `pnpm install`, `pnpm test`, `pnpm typecheck`. Alle tester skal være grønne. Er de ikke det på Windows, fiks årsaken (stier, linjeskift, spawn-quoting), ikke testen.
4. `pnpm make-fixtures`, `pnpm gh-ingest fixtures/blue-fire`, `pnpm gh-ingest fixtures/live-sett-demo`.
5. `pnpm dev`, og sjekk at `/`, `/studio` og `/drop/blue-fire-pitch?r=Test` laster uten feil i konsollen, og at lyd faktisk spilles.
6. **Eksportmappe (avklart):** `F:\EchoGroove\EchoAI\REASONDONE`. Sett `GH_EXPORT_DIR` til den i `.env`. Mappa er i bruk fra før, med WAV-er og Reason-prosjekter, og er **kun lesing**: watcher og ingest skal aldri flytte, gi nytt navn til, endre eller slette noe der. Se del 0b.
7. **Ekte test:** De eksisterende WAV-ene i REASONDONE importeres med `gh-ingest --backlog` (del 0b). Vis BPM, toneart, struktur og palett for et par av dem, og spør Knut om de stemmer. Noter svaret. Det brukes i del 3.

**Ferdig når:** alt over kjører på hans maskin og låtene fra REASONDONE spilles i spilleren.

## Del 0b – Flat eksportmappe, backlog og metadata-rensing

**Flat mappe (kun lesing)**
- Watcheren skal støtte WAV/AIFF/FLAC som ligger **rett i** `GH_EXPORT_DIR` i tillegg til undermappe-konvensjonen. Slug utledes fra filnavnet (`Eyes on you.wav` → `eyes-on-you`). `_vN` gir versjon og `__variant` gir variant, som før.
- **Cover:** et bilde med samme navn ved siden av (`Eyes on you.png`/`.jpg`). Finnes det ikke, blir paletten gull.
- **Ignorer** alt annet: `.reason`-prosjekter, mp3, undermapper som ikke følger konvensjonen.
- Watcheren reagerer bare på **nye eller endrede** filer etter oppstart. Samme filnavn bounces på nytt → ny master for samme slug og versjon, og den forrige erstattes i spilleren (hash avgjør).
- `pnpm gh-ingest --backlog [mappe]`: finner alt i mappa som ikke er ingestet, viser en liste med filnavn → tittel (etter rensing), variant og versjon, og venter på bekreftelse (`--yes` hopper over). Den flytter aldri noe.
- Tester for navnetolkning (mellomrom, norske tegn, `_v2`, `__extended`, ` (1)`) og for at ingenting i kildemappa endres. Sammenlign mtime og hash før og etter.

**Metadata-rensing** (alt som havner i spilleren)
1. `groovehouse.config.json` med standardverdier. Bekreft dem med Knut: artist `Echo Groove`, album/label `Groovehouse Records`, copyright `℗ <år> Groovehouse Records`. Brukes når `meta.json` ikke sier noe annet.
2. Ingen kildetags videre: HLS og `preview.m4a` kodes med `-map_metadata -1`, deretter settes bare egne tags (title, artist, album, copyright, encoder `Groovehouse Vault`). Cover uten EXIF/XMP/C2PA. Originalfilene røres ikke.
3. Rens titler fra filnavn med en liste i config (start: `suno`, `suno ai`, `v4`, `v4.5`, `v5`, `v5.5`, `(remastered)`, `final`, `master`, `bounce`, `export`, datoer og løpenummer som ` (1)`). Rydd mellomrom og bindestreker, og bruk riktig store bokstaver. Stilisering satt i `meta.json` (f.eks. `WOULD YOU RUN`) vinner alltid.
4. Varsle i terminal og på ingest-kortet i Studio når «suno» (uansett store/små bokstaver) finnes i filnavn, tags eller tekstfelt: hva som ble funnet, og at det er fjernet.
5. Tittel, artist og variantnavn kan rettes i Studio. Det lagres som `meta.json` i **media-mappa** for asseten (ikke i REASONDONE) og kjører bare tag- og manifest-steget på nytt.
6. Test: fixture-WAV med Suno-tags og «suno» i filnavnet. Verifiser med `ffprobe` at ingenting av det finnes i HLS, preview eller manifest.

**Ferdig når:** de eksisterende WAV-ene i REASONDONE ligger i spilleren med rene titler og riktig artist, REASONDONE er uendret, og en ny bounce dukker opp automatisk.

## Del 1 – Desktop-app med autostart

Mål: Knut dobbeltklikker et Groovehouse-ikon på skrivebordet og får et eget vindu. Bounces fra Reason dukker opp av seg selv, uten at han starter noe manuelt.

1. **`apps/server`** (ny pakke): én Node-prosess som
   - serverer bygget web-app (`apps/web/dist`) og `media/` på `http://127.0.0.1:4747`, med SPA-fallback,
   - kjører watcheren (`gh-watch`-logikken som modul, ikke som eget skall) mot `GH_EXPORT_DIR`,
   - har et lite API for del 2 (`/api/...`),
   - logger til `%LOCALAPPDATA%\GroovehouseVault\logs\` med rotering,
   - nekter å starte en ny instans hvis porten allerede er i bruk (åpner da bare vinduet).
   Web-appen bruker samme kode i dev (Vite-middleware) og i server-modus.
2. **Autostart ved innlogging** via Planlagte oppgaver (`Register-ScheduledTask`, kun for denne brukeren, uten admin). Prosessen skal kjøre uten synlig konsollvindu, så skriv en liten launcher (`.vbs` eller `node` med `windowsHide`).
3. **Skrivebordssnarvei «Groovehouse Vault»** som åpner `http://127.0.0.1:4747` i app-modus. Bruk Edge `--app=` (eget vindu uten adresselinje), og fall tilbake til Chrome `--app=`. Start serveren først hvis den ikke kjører.
   - Ikon: lag `groovehouse.ico` (16–256 px) fra `docs/design/groovehouse-logo-round.png`. Logoen er detaljert, så sjekk at 16 og 32 px er lesbare. Er de ikke det, si fra og foreslå et forenklet merke.
4. **`pnpm vault:install` og `pnpm vault:uninstall`** som gjør punkt 2–3 og fjerner dem igjen, så det er reversibelt.
5. Legg til et **systemvarsel** (Windows toast via f.eks. `node-notifier`) når watcheren har ingestet en ny bounce: «Would You Run (Extended) er klar – 125 BPM · 8A».

Tauri er **ikke** en del av denne runden. Edge-app-vindu gir samme opplevelse uten Rust-bygg. Nevn i README at Tauri er neste steg hvis Knut vil ha automix med Web Audio på desktop.

**Ferdig når:** etter omstart av PC-en kjører serveren, snarveien åpner spilleren, og en ny fil i eksportmappa dukker opp i katalogen med varsel uten at Knut gjør noe.

## Del 2 – Redigere strukturmarkører i Studio

Analysen foreslår Intro, Build, Drop 1, Break, Drop 2 og Outro (`confirmed: false`). Knut skal kunne rette dem.

1. I `/studio` → Arkiv: en editor per asset med stor bølgeform (bruk `SpectralWaveform`), der markørene er
   - **flyttbare** (dra, snapper til takt når BPM finnes; Alt-dra = fri),
   - **omdøpbare** og **slettbare**,
   - **nye** ved dobbeltklikk,
   - **godkjent** med ett klikk per markør eller «Godkjenn alle».
   Kan styres med tastatur (piltaster flytter én takt, Shift = fire takter).
2. Lagres som `markers.json` ved siden av `manifest.json` (via `POST /api/assets/:slug/:variant/:version/markers`). Godkjente og manuelle markører skal **overleve ny ingest** av samme versjon (`--force`). Ved ny versjon (`_v4`): foreslå å overføre markørene fra forrige versjon med `mapPositionBetweenVariants`-logikken, og vis dem som ubekreftede.
3. Spilleren bruker overstyrte markører når de finnes.
4. Tester for sammenslåing av analyse-forslag og manuelle overstyringer.

**Ferdig når:** Knut kan flytte Drop 1 på en ekte låt, kjøre `gh-ingest --force`, og flyttingen står seg.

## Del 3 – Mer presis BPM og toneart

Dagens toneart-analyse (Krumhansl på enkelt kromagram) har lav sikkerhet.

1. Lag et **evalueringsskript** (`pnpm eval:analysis`) som kjører analysen på en mappe og sammenligner med en fasitfil (`fixtures/truth.json`: slug → bpm, camelot). Be Knut fylle inn fasit for 5–10 egne låter han kjenner tempo og toneart på. Bruk også svaret fra del 0 punkt 7.
2. Forbedringer i denne rekkefølgen, og mål hver mot fasiten:
   - EDM-tilpassede tonearts-profiler (Faraldos «EDMA»-profiler) i stedet for Krumhansl,
   - tuning-estimat før kromagrammet, harmonisk vekting og bare harmoniske rammer (ikke trommer),
   - BPM: begrens til 118–132 for låter med house-energi, og rapporter tempoendringer i sett per kapittel.
3. Vurder **essentia.js** (`KeyExtractor` med profil `edma`, `RhythmExtractor2013`) som alternativ. **Essentia er AGPL-3.0.** Det er greit for Knuts private bruk, men stopp og spør før du tar det inn, i tilfelle han vil selge verktøyet senere. Velg det som scorer best på fasiten.
4. Vis treffraten (f.eks. «8/10 toneart, 10/10 BPM ±0,5») før og etter i oppsummeringen.

**Ferdig når:** treffraten er målt og forbedret på Knuts egne låter, og README beskriver hva som er brukt.

## Del 4 – Raskere ingest

1. Kjør HLS-koding, LUFS-måling og analyse **parallelt**, ikke etter hverandre. Alle leser samme master.
2. Mål før og etter på en 10-minutters fil og på `fixtures/`. Skriv tallene i README.
3. For sett over 20 minutter: vis fremdrift i prosent i terminalen og i Studio (ingest-kortet).

## Del 5 – Fortsett der du slapp, på tvers av PC og mobil (Supabase)

1. Forklar Knut kort valget: Supabase i skyen (gratisnivå) trengs for at mobilen skal se posisjonen fra PC-en. Lokal Supabase i Docker holder ikke. **Vent til han har laget prosjektet** og lagt URL og anon-nøkkel i `.env`. Service role-nøkkelen skal ikke ligge i klientkode.
2. Kjør migrasjonene i `supabase/migrations/` mot prosjektet. Legg Knut inn i `admins` etter første innlogging.
3. Innlogging for Knut med magisk lenke (e-post) i spilleren. Uten innlogging fungerer alt som før, med posisjon lagret lokalt.
4. Bytt `savedPosition`/`savePosition` i `apps/web/src/lib/player.ts` til `playback_positions`. Lagre maks hvert 10. sekund og ved pause/lukking, og les ved oppstart. Slå sammen med lokal posisjon (nyeste vinner).
5. «Fortsett her»-banner når en annen enhet har en nyere posisjon (Supabase Realtime): «Spilte på PC-en – Live-sett 1:02:14. Fortsett her?» Ikke lov sømløs overtakelse på taktslaget. Mobilen starter på posisjonen, og PC-en pauser.

**Ferdig når:** Knut spiller et sett på PC-en, åpner mobilen og fortsetter innenfor et par sekunder fra samme sted.

## Del 6 – Mobilen på samme Wi-Fi

Uutgitt musikk skal ikke være åpen for alle på nettverket.

1. LAN-modus av som standard. Slås på med `pnpm vault:lan on`: serveren binder til nettverkskortet og krever en **PIN** (lagret hashet i Credential Manager). Etter riktig PIN får mobilen en httpOnly-cookie som varer 30 dager. Spør før du lager brannmurregel.
2. Vis en QR-kode i Studio med `http://<pc-ip>:4747` for rask åpning på telefonen.
3. Si tydelig i README: dette er HTTP på lokalnettet, kun hjemme, og ikke for partnere. Partnerlenker kommer med R2 og invitasjonstokens i en egen fase.

## Ikke gjør nå

- **Volum på iPhone:** kan ikke fikses i en nettside (iOS ignorerer `audio.volume`). Først mulig i en native app (Capacitor). Bare dokumenter det.
- Tauri, Capacitor, R2, partnerlenker med tokens og vannmerke i lyd: egne faser.
- Ikke last opp musikk til skyen i denne runden. Supabase brukes bare til innlogging og posisjoner.

## Avslutning

Oppdater README (oppsett på Windows, desktop-app, LAN-modus, markør-editor, analyse-treffrate, ytelsestall), commit per del med beskrivende meldinger på egen gren, spør før push, og gi Knut en kort oppsummering: hva som virker, hva som er målt, og hva som gjenstår.
