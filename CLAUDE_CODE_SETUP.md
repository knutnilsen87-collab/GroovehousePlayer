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
- **Porter:** server **41733**, dev **41734** (ikke 5173/4747). Portene ligger i `groovehouse.config.json`, binder kun til `127.0.0.1` (unntak: LAN-modus i del 6), og velges etter sjekk mot `Get-NetTCPConnection` og `netsh interface ipv4 show excludedportrange protocol=tcp`. `GET /api/health` svarer `{ "app": "groovehouse-vault", "version": … }`. Launcheren sjekker dette før vinduet åpnes, og sier tydelig fra hvis et annet program bruker porten. Er porten tatt ved oppstart: prøv de neste 10, skriv valgt port til `%LOCALAPPDATA%\GroovehouseVault\port`, og la snarveien lese den.
- **Media-URL:** media serveres under `/media/...` (dev og server). `apps/web/public/` er vanlig public-mappe for ikoner og manifest.
- Kode og identifikatorer på engelsk. UI-tekst: spiller og admin på norsk, lytterside (`/drop/...`) på engelsk.

## Del 0 – Oppsett og grønn start

1. Sjekk at `package.json`, `apps/`, `packages/`, `supabase/` og `docs/` ligger i rotmappa, og at `git status` er ren. Løse designfiler i rotmappa (`Claude Design projects/`, Gemini-bildet, `logo.png`, `Groovehouse_Records.ico`, zip-filer) legges i `.gitignore`. Ikke init git på nytt. Jobb på en egen gren per del (`setup/del-0` osv.) og spør før du pusher til GitHub.
2. Sjekk og installer det som mangler, etter å ha spurt:
   - Node 20+ (`node -v`)
   - pnpm (`corepack enable`)
   - ffmpeg og ffprobe på PATH (`winget install Gyan.FFmpeg`). Sjekk i et nytt skall etterpå.
3. `pnpm install`, `pnpm test`, `pnpm typecheck`. Alle tester skal være grønne. Er de ikke det på Windows, fiks årsaken (stier, linjeskift, spawn-quoting), ikke testen.
4. `pnpm make-fixtures`, `pnpm gh-ingest fixtures/blue-fire`, `pnpm gh-ingest fixtures/live-sett-demo`.
5. `pnpm dev` (port 41734), og sjekk at `/`, `/studio` og `/drop/blue-fire-pitch?r=Test` laster uten feil i konsollen, og at lyd faktisk spilles.
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
1. `groovehouse.config.json` med standardverdier (avklart med Knut): `artist: "Echo Groove"`, `label: "Groovehouse Records"`, copyright `℗ <filens år> Groovehouse Records` (årstall fra filens dato, kan overstyres i `meta.json`). **Groovehouse Records er labelet, ikke albumet.** Album settes per låt i `meta.json`. Mangler det, brukes låttittelen som album, som for en singel. Labelnavnet havner aldri i album-feltet. Label skrives i `copyright`, i en `label`/`publisher`-tag der formatet støtter det, og som `label` i `manifest.json`.
2. Ingen kildetags videre: HLS og `preview.m4a` kodes med `-map_metadata -1`, deretter settes bare egne tags (title, artist, album, copyright, label der det støttes, encoder `Groovehouse Vault`). Cover uten EXIF/XMP/C2PA. Originalfilene røres ikke.
3. Rens titler fra filnavn med en liste i config (start: `suno`, `suno ai`, `v4`, `v4.5`, `v5`, `v5.5`, `(remastered)`, `final`, `master`, `bounce`, `export`, datoer og løpenummer som ` (1)`). Rydd mellomrom og bindestreker, og bruk riktig store bokstaver. Stilisering satt i `meta.json` (f.eks. `WOULD YOU RUN`) vinner alltid.
   - **Ikke gjett apostrofer.** Filnavn i bare versaler får vanlig tittel-format og vises i backlog-lista, så Knut kan rette dem i Studio. Avklart: `ILL KEEP IT REAL` → «I'll Keep It Real».
   - **BPM i filnavn** (`(128BPM)`, `128 BPM`, `128bpm`) fjernes fra tittelen og brukes som BPM-hint. Analysen bekrefter innenfor ±2. Ellers vinner analysen, og det vises en advarsel.
   - **«Stems»** står i renselista. Er en fil faktisk enkeltspor (trommer, bass osv.), skal den ikke inn i spilleren som låt. Spør Knut ved tvil.
4. Varsle i terminal og på ingest-kortet i Studio når «suno» (uansett store/små bokstaver) finnes i filnavn, tags eller tekstfelt: hva som ble funnet, og at det er fjernet.
5. Tittel, artist, album og variantnavn kan rettes i Studio. Det lagres som `meta.json` i **media-mappa** for asseten (ikke i REASONDONE) og kjører bare tag- og manifest-steget på nytt.
6. Test: fixture-WAV med Suno-tags og «suno» i filnavnet. Verifiser med `ffprobe` at ingenting av det finnes i HLS, preview eller manifest.

**Ferdig når:** de eksisterende WAV-ene i REASONDONE ligger i spilleren med rene titler og riktig artist, REASONDONE er uendret, og en ny bounce dukker opp automatisk.

## Del 1 – Startfil, desktop-app og autostart

Mål: Knut dobbeltklikker «Groovehouse Vault» på skrivebordet og får spilleren i eget vindu. Bounces fra Reason dukker opp av seg selv.

**Først: startfila** (rett etter at del 0 og 0b er godkjent)
1. **`apps/server`** (ny pakke), én Node-prosess som
   - serverer bygget web-app (`apps/web/dist`) med SPA-fallback, og `media/` under `/media/...`, på `http://127.0.0.1:41733` (se Porter under Arbeidsmåte),
   - har `GET /api/health` og API-et fra del 0b/2,
   - kjører watcheren som modul mot `GH_EXPORT_DIR`,
   - logger til `%LOCALAPPDATA%\GroovehouseVault\logs\` med rotering,
   - ikke starter en ny instans hvis den allerede kjører (helse-sjekk), men bare åpner vinduet.
2. **Ikoner:** Knuts ikonpakke `Groovehouse_Vault_Ikonpakke_v2.zip` ligger i rotmappa. Pakk den ut til `assets/brand/` (hele pakken, også Android og iOS til senere native-apper) og legg zip-en i `.gitignore`.
   - Windows-snarvei: `assets/brand/Windows/Groovehouse_Vault_IconPack.ico`.
   - Web: kopier `assets/brand/Web/public/*` til `apps/web/public/` og legg `<head>`-snippeten inn i `apps/web/index.html`.
   - Lag `icon-192.png` og `icon-512.png` på nytt fra `Windows/groovehouse-transparent-512.png`, så `purpose: "any"` har gjennomsiktige hjørner. Maskable-, iOS- og Play Store-ikoner beholdes uten alfa.
   - I `manifest.webmanifest`: `"display": "minimal-ui"`, **ikke** `standalone`. iOS kutter bakgrunnslyd i hjemskjerm-PWA-er, og minimal-ui støttes ikke på iOS, så den åpnes i Safari der lyden virker. Ikke legg inn `apple-mobile-web-app-capable`.
   - Valgfritt, spør Knut: i 48 px har ikonet fortsatt «GROOVEHOUSE»-tekst som blir uleselig. Foreslå å bruke det forenklede merket (hus + plate) også i 48 px.
3. **Skrivebordssnarvei «Groovehouse Vault»** og samme snarvei i Startmenyen. Dobbeltklikk starter serveren usynlig hvis den ikke kjører, venter på `/api/health`, og åpner spilleren i Edge `--app=` (Chrome `--app=` som reserve). Kjører den allerede, åpnes bare vinduet.
4. **`pnpm vault:install` og `pnpm vault:uninstall`** lager og fjerner alt dette, så det er reversibelt. Spør før noe lages utenfor prosjektmappa (godkjent av Knut: skrivebordssnarvei, Startmeny-snarvei og `%LOCALAPPDATA%\GroovehouseVault\`).
   - `vault:install` kjører `pnpm build` først. Launcheren sjekker at `apps/web/dist` finnes og sier tydelig fra hvis ikke, i stedet for å vise en tom side.
   - `vault:uninstall` fjerner begge snarveiene og `%LOCALAPPDATA%\GroovehouseVault\`, men spør først om loggene skal beholdes.
5. **Ikon på oppgavelinja:** start via snarveien og sjekk hvilket ikon som vises på oppgavelinja. Står det Edge-ikonet og ikke Groovehouse, vis Knut det og foreslå en løsning (f.eks. eget `--app-id` eller installert Edge-app fra manifestet) før du gjør noe mer.
6. **Reversibilitet:** test `vault:install` → dobbeltklikk → `vault:uninstall` → `vault:install` én gang.

**Deretter**
7. **Autostart ved innlogging** via Planlagte oppgaver (`Register-ScheduledTask`, kun for denne brukeren, uten admin). Uten synlig konsollvindu: lag en liten launcher (`.vbs` eller `node` med `windowsHide`).
8. **Systemvarsel** (Windows toast, f.eks. `node-notifier`) når watcheren har ingestet en ny bounce: «Would You Run (Extended) er klar – 125 BPM · 8A».

Tauri er **ikke** med i denne runden. Edge-app-vindu gir samme opplevelse uten Rust-bygg. Nevn i README at Tauri er neste steg hvis Knut vil ha automix med Web Audio på desktop.

**Ferdig når:** snarveien med Groovehouse-ikonet åpner spilleren, og etter omstart av PC-en kjører serveren og nye filer i eksportmappa dukker opp med varsel uten at Knut gjør noe.

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
2. Vis en QR-kode i Studio med `http://<pc-ip>:<server-port>` for rask åpning på telefonen.
3. Si tydelig i README: dette er HTTP på lokalnettet, kun hjemme, og ikke for partnere. Partnerlenker kommer med R2 og invitasjonstokens i en egen fase.

## Del 7 – Spilleren på mobilen utenfor hjemmet (Tailscale)

**Rekkefølge avklart med Knut:** del 6 (Wi-Fi) → del 7 (Tailscale) → **del 9 (spillelister)** → **del 11 («⋯»-meny)** → **del 12 (Android-app)** → **del 10 (del en låt som fil, både web og app)** → del 1 punkt 7–8 (autostart og varsel) → del 8 (innstillinger).

Mål: Knut åpner spilleren på mobilen hvor som helst (4G, borte), uten at noe åpnes mot internett.

1. Knut installerer Tailscale på PC og mobil og logger inn med samme konto. Vent på ham. Spør før du installerer på PC-en (`winget install Tailscale.Tailscale`).
2. Bruk **Tailscale Serve**, aldri **Funnel** (Funnel er offentlig):
   `tailscale serve --bg --https=<port> http://127.0.0.1:<server-port>`
   Første gang ber Tailscale om å skru på Serve og HTTPS-sertifikater i admin-konsollen. Vis Knut lenken og vent. Serveren skal fortsatt bare lytte på `127.0.0.1`. Tailscale står for HTTPS og tilgang.
3. Serveren må godta vertsnavnet `<maskin>.<tailnet>.ts.net` (Host-header) og bruke relative URL-er, så alt virker både på `127.0.0.1` og via ts.net.
4. Siden bare Knuts egne enheter i tailnetet når adressen, trengs ikke PIN her. Ta den bort for forespørsler som kommer via Tailscale Serve, men behold den for LAN-modus. Sjekk at Serve ikke er tilgjengelig for andre i tailnetet hvis Knut deler det med noen. Vis tilgangsreglene.
5. `pnpm vault:remote on/off/status` setter opp og fjerner Serve-oppsettet og viser adressen. Vis QR-kode for ts.net-adressen i Studio.
6. Oppdater snarveien/launcheren: hvis serveren bytter port (reserveport), må Serve-regelen følge med. Varsle tydelig hvis de ikke stemmer.
7. Test fra mobilen på 4G (Wi-Fi av): katalogen laster, lyden spilles, fortsetter med låst skjerm, og hopp mellom deler virker. Android: «Legg til på startskjermen» virker nå med HTTPS. iPhone: bruk Safari-fanen, ikke hjemskjermen.
8. README: hvordan Tailscale er satt opp, hvordan det slås av, og at PC-en må være på og serveren kjøre for at mobilen skal nå musikken.

**Ferdig når:** spilleren spilles på mobilen over 4G via ts.net-adressen, og ingenting er tilgjengelig fra internett utenfor tailnetet.

## Del 8 – Innstillinger i Studio

Mål: Knut kan justere oppførselen uten å redigere filer. Alt lagres i `groovehouse.config.json` (globalt) eller `media/<slug>/meta.json` (per låt). **Ingen hemmeligheter i dette grensesnittet**: nøkler, PIN-hasher og tokens blir i `.env` og Windows Credential Manager.

**Side: `/studio/innstillinger`**
1. **Eksport og watcher:** sti til eksportmappa (validert: finnes, kan leses), watcher-status (kjører, siste hendelse, antall i kø) og knapp for å restarte watcheren. Varsle hvis stien endres til en mappe med mange eksisterende filer, og tilby `--backlog` i stedet for automatisk import.
2. **Kategoriseringsregler:** grense i minutter for når noe regnes som sett (i dag 20), og valgfrie regler for filnavnmønster til type/variant (f.eks. `* (Live *)` → set). Vis en forhåndsvisning av hvordan eksisterende filer i eksportmappa ville blitt tolket.
3. **Lyd:** målnivå for avspilling (standard **−14 LUFS**, område −16 til −11). Forklar i UI-et at spilleren bare kan dempe, ikke løfte, så et høyere mål ikke gjør stille skisser høyere. HLS-bitrate vises som info, ikke som innstilling.
4. **Metadata:** standard artist, label, copyright-mal (`℗ {år} {label}`) og rensingslisten for titler (legg til og fjern ord/mønstre, med forhåndsvisning på eksisterende filnavn).
5. **Farger:** minimum kontrast for aksent (standard 4.5:1, ikke lavere enn 3:1) og om fargeløse cover skal falle tilbake til gull.
6. **Tilgang:** Wi-Fi-modus på/av og bytte PIN (samme logikk som `vault:lan`), Tailscale-status og adresse med QR (samme logikk som `vault:remote`). Ingen visning av PIN eller hasher.
7. **Standarder for drops** (lagres nå, brukes når drops kobles til Supabase): standard nivå, levetid i dager, maks antall enheter per lenke (standard 2), og vannmerke på/av som standard. Merk tydelig i UI-et at dette ikke har effekt før delingsfasen.

**Per låt (asset-siden i Studio)**
8. **Fargeoverstyring:** to fargevelgere (`primary`, `secondary`) med live forhåndsvisning av spiller og drop-side, kontrastmåling mot `#07080B` (rødt under minimum) og «Tilbakestill til automatisk». Lagres som `palette` i `meta.json` med `source: "manual"`. Ingest skal respektere den ved ny kjøring.
9. **Live-sett-offset:** slider (±10 s, steg 50 ms) som flytter alle live-logg-markører samtidig, med «spill fra markør»-knapp for å høre etter. Lagres i `meta.json` og brukes av ingest (i stedet for `--offset`). Henger sammen med markør-editoren i del 2.

**Krav**
- Endringer valideres før lagring. `groovehouse.config.json` skrives atomisk (tempfil + rename), og forrige versjon lagres som `groovehouse.config.backup.json`.
- Endringer som krever restart (porter, eksportmappe) sier det tydelig og tilbyr restart. Resten trer i kraft med en gang.
- Skriving til innstillinger er bare lov fra PC-en selv eller fra Knuts egne enheter (Tailscale, eller Wi-Fi med gyldig PIN). Lytterlenker (`/drop/...`) har aldri tilgang.
- Tester for validering, atomisk skriving, at manuell palett overlever ny ingest, og at offset flytter markørene riktig.

**Ikke i denne delen** (hører til delingsfasen med Supabase): oppførsel per nivå (nedlasting av stems, opplåsing, teaser kun med preview), håndheving av enhetsgrense, GDPR-sletting av lyttelogger og personvernerklæring for partnere, og klipp-eksport til sosiale medier.

**Ferdig når:** Knut kan endre eksportmappe, LUFS-mål, standard artist/label og farge på én låt fra Studio, og endringene står seg etter omstart og ny ingest.

## Del 9 – Spillelister (mobil og desktop)

Mål: Knut lager og endrer spillelister med ett eller to trykk, både på mobilen (via Tailscale) og i desktop-appen, og de er like på begge.

**Lagring og synk**
- Spillelistene lagres av serveren på PC-en (`data/playlists.json` i rotmappa, gitignored, atomisk skriving + backup), via `GET/POST/PATCH/DELETE /api/playlists`. Mobil og desktop snakker med samme server, så de er alltid synkronisert. Supabase trengs ikke.
- Hver oppføring peker på **slug + variant**, ikke på asset-id eller versjon. En ny bounce (`_v4`) av en låt oppdaterer dermed alle lister automatisk. Varianten kan låses per oppføring («spill alltid Extended») eller følge hovedversjonen.
- Samme regler for tilgang som innstillingene: bare fra PC-en eller Knuts egne enheter (Tailscale, eller Wi-Fi med PIN). Lytterlenker har aldri tilgang.
- Samtidige endringer: hver liste har `updatedAt`. Klienten sender den med, og serveren avviser med 409 hvis lista er endret i mellomtiden, så klienten laster på nytt og prøver igjen. Ingen stille overskriving.

**Lage og legge til, mobil (én tommel)**
1. «⋯» på hver låtrad og i fullskjermspilleren → **Legg til i spilleliste**: et ark nederfra med de 3 sist brukte listene øverst, deretter resten, og **+ Ny spilleliste** (navn → lagre → låta er lagt til).
2. Bekreftelse som liten melding nederst («Lagt til i Club Ready – Angre»).
3. I en liste: hold inne og dra for å endre rekkefølge, sveip til venstre for å fjerne (med angre).
4. **Velgemodus:** hold inne på en låt for å starte velgemodus, trykk på flere låter, og en flytende knapp viser **Legg til i spilleliste (3)**. «Avbryt» eller tilbake-knappen avslutter velgemodus.
5. Spillelister får egen plass i bunnmenyen eller under Katalog. Ikke lag en femte fane hvis det blir trangt. Foreslå løsningen og vis Knut før du bygger.

**Lage og legge til, desktop**
6. Spillelister i sidemenyen, med **+ Ny spilleliste** øverst. Hver liste vises med fargeprikken sin.
7. Dra låter (én eller flere) fra tabellen til en liste i sidemenyen. Høyreklikk → **Legg til i spilleliste**. Flervalg med Ctrl/Shift-klikk.
8. Snarvei: `Ctrl+Shift+P` legger låta som spilles nå til i sist brukte liste.
9. Endre rekkefølge med dra og slipp, og fjern med Delete (med angre).

**Spillelista**
10. Viser cover-mosaikk av de fire første låtene (eller eget cover, se under), total tid, antall låter og BPM-spenn. Spill, Bland og Fortsett. For sett gjelder fortsett-posisjonen som før.
11. Når lista spilles, er køen lista. Låste varianter og versjoner brukes, og ellers hovedversjonen.
12. Gi nytt navn, dupliser og slett (med bekreftelse) fra «⋯»-menyen.
13. **Låse en bestemt versjon:** per oppføring kan Knut velge «følg nyeste» (standard), en bestemt variant, eller en bestemt **versjon** (f.eks. v3 Demo). Det krever at eldre versjoner fortsatt kan spilles. Katalogen viser i dag bare nyeste versjon per variant, så legg til en versjonsvelger på asset-siden og la eldre versjoner ligge i `media/` (de slettes ikke ved ny ingest). Står en låst versjon ikke lenger i media, vises raden som utilgjengelig med en forklaring i stedet for å forsvinne.
14. **Eget cover for lista:** last opp et bilde (lagres i `data/playlist-covers/`, renset for EXIF som andre cover). Paletten hentes fra det med samme kontrastlås. Uten eget cover brukes mosaikken.
15. **Fargekoding:** hver liste har en farge, valgt fra paletten i `docs/design/playlist-colors.json`: **40 farger i to grupper**, **Neon** (22) og **Candy** (18). Alle har `primary`, `secondary` og `onPrimary`, er testet til ≥ 4.5:1 kontrast mot `#07080B`, og farger som ligger for nær gullet i rammen er tatt ut. Forhåndsvisning: `docs/design/playlist-colors.png`.
    - **Neon-glød:** prikken, «Spill»-knappen og lista som er aktiv i sidemenyen får glød i listefargen: `box-shadow: 0 0 6px {primary}, 0 0 18px {primary}99, 0 0 36px {primary}55` (oppskriften ligger også i JSON-fila under `neonGlow`). Prikken får en lys kjerne (primary blandet 60 % mot hvitt) for neonrør-effekt. Mens lista spilles, kan gløden puste svakt med sub-bassen (samme `--sub` som spilleren). Ingen pulsering ved «redusert bevegelse».
    - Fargevelger som et rutenett av glødende prikker, delt i fanene Neon og Candy, med navn ved hover/langt trykk. Ny liste får en tilfeldig farge som ikke allerede er brukt av en annen liste, om mulig.
    - Fargen brukes på prikken i sidemenyen/lista, bakgrunnsgløden i listevisningen, «Spill»-knappen i lista og en tynn kant på mosaikken.
    - **Mens musikken spilles, styrer fortsatt coveret til låta rommet** (fargetyveriet). Listefargen er listens identitet, ikke spillerens.
    - Ikke legg gull (`#F0C030`-familien) i paletten. Gull er rammen for hele appen.

**Smarte lister (enkelt, gjenbruker søket)**
12. I Ctrl+K-søket: **Lagre som smart liste** lagrer selve søket (f.eks. `124 8A`, `sett`, `extended`) som en liste som oppdaterer seg selv. Den vises med eget ikon og kan ikke sorteres manuelt.
13. To innebygde smarte lister: **Nylig lagt til** (siste 14 dager) og **Live-sett**.

**Senere (ikke i denne delen):** «Gjør om til drop» (se utkastet til delingsfasen under), harmonisk forslag til neste låt etter Camelot, og eksport til M3U eller rekordbox.

**Tester:** API (opprett, legg til, flytt, fjern, 409 ved konflikt), at en ny versjon av en låt dukker opp i eksisterende lister, at smarte lister gir samme treff som søket, og at mobil og desktop ser samme liste etter en endring.

**Ferdig når:** Knut lager en liste på mobilen via Tailscale, legger til tre låter, åpner desktop-appen og ser den samme lista, endrer rekkefølgen der, og ser endringen på mobilen.

## Del 10 – Del en enkelt låt som fil (WhatsApp, e-post osv.)

Knut vil kunne sende én låt til noen via WhatsApp, e-post eller lignende. Dette steget sender **selve lydfila** via enhetens delingsmeny. Det trenger ingen sky, og ingen lenke peker tilbake til PC-en. Lenkedeling med forhåndsvisning og utløp kommer i delingsfasen under.

**Lage fila (server)**
1. `GET /api/share/:slug/:variant/:version?kind=full|preview|wav` lager og returnerer fila, og cacher den i `media/<slug>/<variant|main>/v<N>/share/`. Cachen gjelder til master-hashen endres.
   - `full` (standard): AAC `.m4a` 256 kbps fra **master-WAV-en** (ikke HLS-segmentene), uten loudness-endring. Metadata: tittel, artist «Echo Groove», album, `℗ <år> Groovehouse Records`, år og variantnavn. Coveret legges inn som bilde (`-disposition:v attached_pic`), med `-movflags +faststart`.
   - `preview`: den eksisterende 30-sekunders `preview.m4a`, med samme metadata og cover.
   - `wav`: original-WAV for samarbeidspartnere, kopiert med nytt filnavn (ikke konvertert).
   - **Filnavn:** `Echo Groove - <Tittel>.m4a`, eventuelt `Echo Groove - <Tittel> (<Variant>).m4a`. Ulovlige Windows-tegn fjernes, men æøå og apostrofer beholdes.
2. Endepunktet ligger bak samme PIN eller Tailscale-tilgang som resten av spilleren. Det er **aldri** tilgjengelig fra `/drop/...`.

**Dele (klient)**
3. Ny handling **Del…** på låter i ⋯-arket (mobil), på høyreklikk-menyen og i spillerdokken (desktop), og i fullskjermspilleren. Den deler versjonen og varianten som vises der (versjonslås fra lister respekteres).
4. Et lite ark med tre valg: **Hele låten** (standard, viser omtrentlig størrelse), **Smakebit 30 s** og **Original WAV**.
5. **Viktig:** Web Share API krever en brukerhandling, og den utløper hvis du først laster ned en fil på 10+ MB. Derfor skjer det i to steg. Når et valg trykkes, hentes fila som `Blob`, med fremdriftsindikator. Deretter viser knappen **Del nå**, som kaller `navigator.share({ files: [file], title, text })` direkte i klikket.
6. Teksten som følger med: `Echo Groove – <Tittel> · Groovehouse Records`. **Ingen URL i teksten.** Tailscale-adressen og LAN-IP-en skal aldri havne i en delt melding.
7. **Reserveløsninger:**
   - Hvis `navigator.canShare({ files })` er falsk, last ned fila i stedet. Dette skjer f.eks. på `http://10.0.0.47` (LAN-modus er ikke en sikker kontekst, så delingsmenyen finnes ikke der) og i nettlesere uten fildeling. Vis en kort forklaring: «Deling krever HTTPS – bruk Tailscale-adressen, eller send den nedlastede fila.»
   - På desktop finnes i tillegg **Vis i Utforsker**. Serveren åpner `explorer.exe /select,<fil>`, og bare for filer i share-cachen.
8. Edge-vinduet på Windows støtter `navigator.share` med filer. Da åpnes Windows' delingsmeny med WhatsApp, Mail osv. Test at dette faktisk virker i `--app`-vinduet, og bruk reserveløsningen hvis ikke.
9. Logg lokalt i `data/shares.json`: `{ slug, variant, version, kind, at }`. Ingen mottaker lagres (den vet vi ikke). Vis «Delt 3 ganger» i Studio → Arkiv.

**Ikke i denne delen:** deling av hele spillelister, vannmerke per mottaker, lenker med utløp.

**Tester:** filnavn-rensing, metadata og innebygd cover i `full` (sjekk med `ffprobe`), at cachen gjenbrukes og fornyes ved ny master, at endepunktet avviser uten PIN, og at delt tekst aldri inneholder vertsnavn eller IP.

**Ferdig når:** Knut deler en låt fra mobilen (via Tailscale) til seg selv på WhatsApp, og en annen låt fra desktop-appen på e-post. Begge spilles av hos mottakeren med riktig tittel og artist, og coveret vises i musikkappen og i e-postvedlegget.

## Del 11 – «⋯»-meny for låta som spilles

Mål: Når en låt spilles, er det alltid en «⋯»-knapp som gir alle valg for **akkurat den låta** (versjonen og varianten som spilles nå).

1. **Én komponent** for låthandlinger (`TrackActions`), brukt overalt: låtrader (del 9), fullskjermspilleren, minispilleren (mobil) og spillerdokken (desktop). Ikke lag flere varianter av menyen.
2. **Plassering:**
   - Mobil: «⋯» øverst til høyre i fullskjermspilleren, og hold inne på minispilleren.
   - Desktop: «⋯» i dokken ved siden av tittelen, og høyreklikk på coveret i dokken.
3. **Innhold**, i denne rekkefølgen (lenge-brukte øverst):
   - **Legg til i spilleliste** (arket fra del 9 punkt 1, med «+ Ny spilleliste»)
   - **Del…** (del 10)
   - **Spill neste** og **Legg til i køen** (gjelder låtrader; på låta som spilles: **Vis køen**)
   - **Bytt variant** (Original/Extended osv., beholder seksjonen som i dag via `mapPositionBetweenVariants`)
   - **Velg versjon** (v1…vN, fra versjonsvelgeren i del 9 punkt 13)
   - **Gå til seksjon** (Intro/Build/Drop … fra markørene)
   - **Info:** BPM, toneart/Camelot, LUFS, varighet, filnavn, dato for ingest
   - **Åpne i Studio** (kun desktop, eller når Studio er tilgjengelig)
4. Køen: legg til `insertNext(asset)` og `enqueue(asset)` i spiller-storen. Køvisning med dra for å endre rekkefølge og sveip for å fjerne. Køen overlever omstart (localStorage), men en ny `playFrom` erstatter den som før.
5. På mobil er menyen et ark nederfra med store treffflater (minst 48 px). På desktop er den en vanlig kontekstmeny med snarveier vist til høyre (f.eks. `Ctrl+Shift+P` for spilleliste).
6. Tastatur: `Shift+F10` eller menytasten åpner menyen for låta som spilles.

**Ferdig når:** Knut spiller en låt på mobilen, trykker «⋯» i fullskjermspilleren, legger den til i en liste og deler den, uten å forlate spilleren.

## Del 12 – Android-app (APK) med avspilling i bakgrunnen

Mål: Groovehouse Vault som en ekte Android-app på Knuts Samsung S22. Musikken fortsetter når skjermen er av eller han bruker andre apper. Den skal også kunne styres fra låseskjermen, varslingslinja, Bluetooth-hodetelefoner og bilen.

**Hvorfor native avspilling:** Chrome og WebView kan stoppe lyd i bakgrunnen, og Samsungs batterisparing dreper prosesser aggressivt. Løsningen er en Android-tjeneste i forgrunnen (foreground service) som eier avspillingen. Lyd i WebView-en er ikke nok.

**Arkitektur**
1. **Capacitor** (siste stabile), i `apps/android`. Den pakker den bygde web-appen (`apps/web/dist`) inn i APK-en. UI-et er det samme som på web, så del 9–11 følger med.
2. **Egen Capacitor-plugin `NativePlayer`** (Kotlin) med **AndroidX Media3**: `ExoPlayer` + `media3-exoplayer-hls` + `MediaSessionService`. Den spiller HLS-strømmene direkte og gir varsel med cover, låseskjermkontroller, Bluetooth-knapper og lydfokus (pause ved telefonsamtale).
3. **Motor-abstraksjon i spiller-storen:** `PlayerEngine` med `HtmlAudioEngine` (web/desktop, dagens kode) og `NativeEngine` (Android, snakker med pluginen). Storen skal ikke vite hvilken som brukes. Pluginen sender posisjon (hvert 250 ms når appen er synlig, sjeldnere i bakgrunnen), tilstand og «låt ferdig» tilbake. Visualiseringen interpolerer mellom posisjonene som i dag.
4. **Køen eies av den native spilleren** når appen er i bakgrunnen, så neste låt starter uten at JavaScript kjører. Send hele køen (URL-er, tittel, artist, cover-URL, varighet) til pluginen ved `playFrom`/endringer i køen.
5. Knapper i varselet: forrige, spill/pause, neste. Ekstra egendefinert knapp: **Neste seksjon** (samme som Shift+→). Fortsett-posisjonen lagres også fra native-siden.

**Tilkobling til PC-en**
6. Første oppstart: et skjermbilde **Koble til Vault** der Knut limer inn Tailscale-adressen og skriver PIN-en. Serveren gir tilbake et **enhetstoken** (langlivet, kan trekkes tilbake). Tokenet lagres kryptert (Android Keystore via en secure storage-plugin), aldri i vanlig `localStorage`.
7. **Adressen skal ikke ligge i koden eller i git.** Den lagres bare i appen. Valgfritt: QR-kode i Studio → Innstillinger som inneholder adressen og en engangskode for paring, i stedet for PIN.
8. Serveren: godta `Authorization: Bearer <enhetstoken>` på API og `/media/...` (ExoPlayer setter headeren via `DefaultHttpDataSource`). Legg til CORS kun for app-opprinnelsen (`https://localhost`). **Tilkoblede enheter** listes i innstillingene (del 8) med «Trekk tilbake».
9. Bare HTTPS (Tailscale). Ingen `cleartextTrafficPermitted`. Wi-Fi-adressen `http://10.0.0.47` brukes ikke i appen.
10. Er PC-en av eller utenfor rekkevidde: vis «Får ikke kontakt med Vault på PC-en» med «Prøv igjen», ikke en hvit side.

**Ting som oppfører seg annerledes i appen**
11. **Deling (del 10):** WebView har ikke Web Share API. I appen: last ned fila til appens cache med `@capacitor/filesystem` og del med `@capacitor/share`. Abstraher dette i samme `share()`-funksjon som web bruker.
12. **Volum:** `audio.volume`-dempingen (LUFS-utjevning) gjøres i ExoPlayer (`player.volume`), så den virker i appen.
13. Tilbake-knappen på Android: lukker ark og fullskjermspiller før den går ut av appen. Ut av appen = musikken fortsetter.

**Ikon, navn og bygg**
14. Appnavn **Groovehouse Vault**, `applicationId` `no.groovehouse.vault`. Adaptivt ikon fra ikonpakken i `assets/brand/` (forgrunn = merket, bakgrunn = `#07080B`), og varselikon i hvitt (monokrom). Mørk oppstartsskjerm.
15. Tillatelser: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS` (spør ved første avspilling), `INTERNET`. Ingen andre.
16. **Spør Knut før** du installerer JDK (17 eller 21), Android SDK (kommandolinjeverktøy eller Android Studio) og Gradle via winget, og før du skriver utenfor rotmappa.
17. **Signering:** lag en egen keystore utenfor repoet (`%APPDATA%\GroovehouseVault\android\release.jks`), med passordet i Windows Credential Manager. Samme nøkkel må brukes for alle oppdateringer, ellers må appen avinstalleres. Ta en backup-påminnelse i README.
18. `pnpm android:build` bygger web + APK. `pnpm android:install` installerer via `adb` over USB (sjekk at USB-feilsøking er på; forklar Knut hvordan han slår det på hvis ikke). Legg APK-en også i `dist/android/` for manuell installasjon.
19. **Samsung:** etter installasjon, vis Knut hvordan han setter appen til «Ubegrenset» under Batteri, så den ikke stoppes. Skriv det i README.

**Senere (ikke i denne delen):** Android Auto (krever `MediaLibraryService` og at «ukjente kilder» slås på i Android Auto for sideloadede apper), nedlasting for offline-lytting i bilen, og iPhone-app.

**Tester:** enhetstester for `PlayerEngine`-kontrakten (begge motorer), tokenpåkrevd på API og media, CORS kun for app-opprinnelsen, og at adressen ikke finnes i bygget/git (`git grep` etter `.ts.net`).

**Ferdig når:** Knut installerer APK-en på S22, kobler til via Tailscale, starter en spilleliste, låser skjermen og bytter til en annen app. Musikken fortsetter i 15 minutter med flere låtskifter, kan pauses og hoppes fra låseskjermen og fra Bluetooth i bilen, og «⋯ → Del…» sender fila til WhatsApp.

## Utkast: delingsfasen (drops til andre) – ikke bygg ennå

**Enkeltlåt som lenke (første steg i denne fasen):** «Del lenke» på én låt lager en drop med én låt. Lenken gir en fin forhåndsvisning i WhatsApp/iMessage med cover og tittel (Open Graph-bilde generert fra coveret og paletten), kan strømmes uten nedlasting, utløper, og gir lytteinnsikt. Dette er alternativet til fildelingen i del 10 når Knut vil ha kontroll over hvor musikken havner.

Dette krever invitasjonstokens, R2 og Supabase og bygges i en egen fase. Tailscale-adressen virker bare for Knuts egne enheter og kan **ikke** brukes til å sende lenker til andre. Tailscale Funnel (offentlig) skal ikke brukes til uutgitt musikk. Teksten under er designet å bygge videre på.

**Krav til lytteren (låst av Knut):** Mottakeren skal **aldri** trenge Tailscale, en app, en konto, et passord eller en adresse å skrive.
- Ett trykk på lenken i WhatsApp/SMS/e-post, og låta spiller i nettleseren innen et par sekunder. Lenken gir forhåndsvisning med cover og tittel.
- Lenken *er* tilgangen (personlig token per mottaker). Enheten huskes stille med en informasjonskapsel, så den virker igjen neste gang uten noe ekstra.
- Enhetsgrensen (f.eks. 2 enheter) håndheves stille. Prøver en tredje enhet å åpne lenken, vises «Denne lenken er personlig – be Knut om en egen», ikke en innloggingsside.
- Utløpt lenke: en vennlig side med «Be om ny tilgang», som sender Knut et varsel. Lytteren skriver ikke noe annet enn eventuelt navnet sitt.
- Ingen kode eller PIN som standard. En valgfri 4-sifret kode per drop finnes bare for særlig sensitive drops, og skrives da i samme melding som lenken.
- Alt dette kjører i skyen (Worker + R2), helt atskilt fra PC-en. Tailscale og PC-adressen brukes bare av Knut.
- **Domene: `listen.groovehouserecords.com`** (Knut eier `groovehouserecords.com`). Lenker ser slik ut: `listen.groovehouserecords.com/d/<token>`. Worker-ruter krever at DNS-sonen ligger i Cloudflare (gratisplan). Før nameserverne flyttes, kopier **alle** eksisterende DNS-poster (nettside, e-post/MX, SPF/DKIM, verifiseringer) og vis Knut lista. Nettside og e-post på domenet skal ikke falle ut. Domenet er registrert hos GoDaddy og har ingen nettside. Sjekk likevel om det finnes MX-poster eller e-postvideresending før flytting. Inntil DNS er på plass: `*.workers.dev`.

**Flyt**
1. **Samle:** en spilleliste (del 9) er utgangspunktet. «Gjør om til drop» på lista, eller velg låter i velgemodus/flervalg og velg **Opprett drop (3 låter)**.
2. **Konfigurere:**
   - **Mottaker** (påkrevd, f.eks. «Jorrit»): brukes i vannmerket og i lytteinnsikten.
   - **Nivå:** Partner (kun strømming, lytteinnsikt, låst til mottaker) eller Inner Circle (nedlasting av stems og kommentarer), med standarder fra innstillingene (del 8). Supporter og Teaser bruker samme mekanisme.
   - **Versjon per låt:** arves fra lista (låst versjon/variant).
   - **Drop-cover:** listens cover som standard (styrer fargene på drop-siden), ellers coveret til spor 1, eller et eget opplastet.
   - **Utløp og maks antall enheter.**
   - **Live-sett** tar med kapitler og markører automatisk.
3. **Sende:** lag en personlig magisk lenke og del den med mobilens delingsmeny (Web Share API) til Snapchat, iMessage osv. På desktop: kopier lenke + QR.
4. **Følge opp:** lytteinnsikt per mottaker i Command Center, som allerede er designet.

**Forutsetninger:** opplasting av HLS/cover/analyse til R2, Worker med tokensjekk, Supabase-tabellene `drops`, `invites`, `invite_devices`, `listen_events` (finnes i migrasjonen), håndheving av enhetsgrense, personvernerklæring for partnere og sletting av lyttelogger etter en periode.

## Ikke gjør nå

- **Volum på iPhone:** kan ikke fikses i en nettside (iOS ignorerer `audio.volume`). Først mulig i en native iPhone-app. Bare dokumenter det. (Android-appen i del 12 løser det for Android.)
- Tauri, iPhone-app, R2, partnerlenker med tokens og vannmerke i lyd: egne faser.
- Ikke last opp musikk til skyen i denne runden. Supabase brukes bare til innlogging og posisjoner.

## Avslutning

Oppdater README (oppsett på Windows, desktop-app, LAN-modus, markør-editor, analyse-treffrate, ytelsestall), commit per del med beskrivende meldinger på egen gren, spør før push, og gi Knut en kort oppsummering: hva som virker, hva som er målt, og hva som gjenstår.
