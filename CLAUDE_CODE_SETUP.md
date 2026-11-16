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
- Ikke endre de låste beslutningene uten å spørre: ingen Web Audio på mobil, aksentfarger kun fra `assets.palette` via CSS-variabler (coveret styrer alle aksenter; gull bare i logoen, se del 14), HLS AAC 256 kbps, ingest som CLI med watcher som trigger.
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

**Rekkefølge avklart med Knut:** del 6 (Wi-Fi) → del 7 (Tailscale) → **del 9 (spillelister)** → **del 11 («⋯»-meny)** → **del 12 (Android-app)** → **del 10 (del en låt som fil, både web og app)** → del 1 punkt 7–8 (autostart og varsel) → del 8 (innstillinger) → **del 15 (oppdatering av appen)** → **del 14 (nytt utseende)** → **del 16 (utkast)** → del 2 → del 4 → del 3 → **del 17 (settbygger)** → **del 18 (overgangs-presets)** → **del 19 (skins)** → **del 22 (visuell finpuss)** → **del 20 (jevnere autosett)** → **del 21 (Raspberry Pi)** → **del 13 (deling med lenker)**.

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
7. **Standarder for drops** (lagres nå, brukes av del 13): standard nivå, levetid i dager, maks antall enheter per lenke (standard 2), og vannmerke på/av som standard. Merk tydelig i UI-et at dette ikke har effekt før del 13 er bygget.

**Per låt (asset-siden i Studio)**
8. **Fargeoverstyring:** to fargevelgere (`primary`, `secondary`) med live forhåndsvisning av spiller og drop-side, kontrastmåling mot `#07080B` (rødt under minimum) og «Tilbakestill til automatisk». Lagres som `palette` i `meta.json` med `source: "manual"`. Ingest skal respektere den ved ny kjøring.
9. **Live-sett-offset:** slider (±10 s, steg 50 ms) som flytter alle live-logg-markører samtidig, med «spill fra markør»-knapp for å høre etter. Lagres i `meta.json` og brukes av ingest (i stedet for `--offset`). Henger sammen med markør-editoren i del 2.

**Krav**
- Endringer valideres før lagring. `groovehouse.config.json` skrives atomisk (tempfil + rename), og forrige versjon lagres som `groovehouse.config.backup.json`.
- Endringer som krever restart (porter, eksportmappe) sier det tydelig og tilbyr restart. Resten trer i kraft med en gang.
- Skriving til innstillinger er bare lov fra PC-en selv eller fra Knuts egne enheter (Tailscale, eller Wi-Fi med gyldig PIN). Lytterlenker (`/drop/...`) har aldri tilgang.
- Tester for validering, atomisk skriving, at manuell palett overlever ny ingest, og at offset flytter markørene riktig.

**Ikke i denne delen** (hører til del 13): oppførsel per nivå (nedlasting av stems, opplåsing, teaser kun med preview), håndheving av enhetsgrense, GDPR-sletting av lyttelogger og personvernerklæring for partnere, og klipp-eksport til sosiale medier.

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
15. **Fargekoding:** hver liste har en farge, valgt fra paletten i `docs/design/playlist-colors.json`: **40 farger i to grupper**, **Neon** (22) og **Candy** (18). Alle har `primary`, `secondary` og `onPrimary`, er testet til ≥ 4.5:1 kontrast mot `#07080B`, og farger som ligger for nær gullet i logoen er tatt ut. Forhåndsvisning: `docs/design/playlist-colors.png`.
    - **Neon-glød:** prikken, «Spill»-knappen og lista som er aktiv i sidemenyen får glød i listefargen: `box-shadow: 0 0 6px {primary}, 0 0 18px {primary}99, 0 0 36px {primary}55` (oppskriften ligger også i JSON-fila under `neonGlow`). Prikken får en lys kjerne (primary blandet 60 % mot hvitt) for neonrør-effekt. Mens lista spilles, kan gløden puste svakt med sub-bassen (samme `--sub` som spilleren). Ingen pulsering ved «redusert bevegelse».
    - Fargevelger som et rutenett av glødende prikker, delt i fanene Neon og Candy, med navn ved hover/langt trykk. Ny liste får en tilfeldig farge som ikke allerede er brukt av en annen liste, om mulig.
    - Fargen brukes på prikken i sidemenyen/lista, bakgrunnsgløden i listevisningen, «Spill»-knappen i lista og en tynn kant på mosaikken.
    - **Mens musikken spilles, styrer fortsatt coveret til låta rommet** (fargetyveriet). Listefargen er listens identitet, ikke spillerens.
    - Ikke legg gull (`#F0C030`-familien) i paletten. Gull er forbeholdt logoen.

**Smarte lister (enkelt, gjenbruker søket)**
12. I Ctrl+K-søket: **Lagre som smart liste** lagrer selve søket (f.eks. `124 8A`, `sett`, `extended`) som en liste som oppdaterer seg selv. Den vises med eget ikon og kan ikke sorteres manuelt.
13. To innebygde smarte lister: **Nylig lagt til** (siste 14 dager) og **Live-sett**.

**Senere (ikke i denne delen):** «Gjør om til drop» (del 13), harmonisk forslag til neste låt etter Camelot, og eksport til M3U eller rekordbox.

**Tester:** API (opprett, legg til, flytt, fjern, 409 ved konflikt), at en ny versjon av en låt dukker opp i eksisterende lister, at smarte lister gir samme treff som søket, og at mobil og desktop ser samme liste etter en endring.

**Ferdig når:** Knut lager en liste på mobilen via Tailscale, legger til tre låter, åpner desktop-appen og ser den samme lista, endrer rekkefølgen der, og ser endringen på mobilen.

## Del 10 – Del en enkelt låt som fil (WhatsApp, e-post osv.)

Knut vil kunne sende én låt til noen via WhatsApp, e-post eller lignende. Dette steget sender **selve lydfila** via enhetens delingsmeny. Det trenger ingen sky, og ingen lenke peker tilbake til PC-en. Lenkedeling med forhåndsvisning og utløp kommer i del 13.

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

## Del 16 – Utkast: umastrede låter holdt atskilt fra release-klare

Mål: Knut har mange umastrede låter han vil ha i spilleren for å planlegge sett og album. De skal **aldri blandes** med det som er ferdig eksportert fra Reason og klart for release, verken i biblioteket, i blanding, i smarte lister, i forslag eller i deling.

**Oppdatert 2026-11-15 (Knut):** filene i utkastmappa er **ferdige låter som bare ikke er mastret**. De skal være fullt tilgjengelige i spillerne, ikke gjemt.
- I UI-et heter statusen **Umastret**, ikke «Utkast».
- **Bibliotek og Hjem:** viser begge, i to tydelige seksjoner, med **Release-klar** øverst og **Umastret** under, og samme merking som under (brikke, stiplet kant). Segmentet Release-klar · Umastret · Alle står med standard **Alle (gruppert)**.
- **Ctrl+K og DJ-verktøy:** finner begge, med brikke.
- **Bland og autospill:** blander aldri automatisk på tvers. De holder seg innenfor gruppen avspillingen startet i, med mindre en liste eller plan eksplisitt inneholder begge.
- **Settbyggeren (del 17):** «Ta med umastret» er **på** som standard og huskes. Planen viser «x av y mastret».
- **Import:** importer alt i mappa uten å spørre per fil. Hopp bare over eksakte duplikater (samme lyd-hash) og filer som tydelig er stems ifølge navnet. Vis lista over det som ble hoppet over etterpå, så Knut kan hente inn noe likevel.
- Punktene 7–9, 11 og 13–14 under gjelder med denne justeringen.

**Status bestemmes av mappa, ikke av filnavnet**
1. To kilder:
   - `GH_EXPORT_DIR` (REASONDONE) = **Release-klar**, som i dag.
   - Ny `GH_DRAFT_DIR` = **Utkast**. Spør Knut hvor utkastene ligger. Mappa settes i Innstillinger og i `groovehouse.local.json`, ikke i git.
   - Begge er **kun lesing**.
2. Watcher og `--backlog` støtter begge mappene. Utkastmappa kan ha undermapper (f.eks. per prosjekt), og filnavnreglene og metadata-rensingen fra del 0b gjelder likt, også Suno-rensing.
3. I tillegg: **Importer som utkast** i Studio (dra inn filer). De kopieres til `data/drafts-inbox/` og ingestes derfra.
4. Manifestet får `status: "release" | "draft"`, som vises og filtreres overalt. En låt kan **aldri** bytte status av seg selv. Å gjøre et utkast om til release-klar skjer bare ved at master kommer i REASONDONE, eller ved et eksplisitt valg i Studio med bekreftelse.

**Samme låt i begge**
5. Samme slug i begge mappene = samme låt. Utkastene blir versjoner med status utkast, og masteren fra REASONDONE blir release-versjonen.
6. «Følg nyeste» i spillelister og visningen i biblioteket velger **release hvis den finnes, ellers nyeste utkast**. Når en låt blir mastret, går altså alle album- og settplaner automatisk over til masteren.

**Atskilt i grensesnittet**
7. Bibliotek, Hjem, «Nylig lagt til», Ctrl+K og DJ-verktøy («Passer etter denne») viser **bare release-klare** som standard. Et segment **Release-klar · Utkast · Alle** øverst bytter, og valget huskes per visning.
8. Utkast er tydelig merket overalt:
   - En liten **UTKAST**-brikke i mono.
   - Stiplet kant på cover og miniatyrer.
   - Dempet glød: aksenten på 50 % i stedet for full neon.
9. Bland, autospill og smarte lister bruker bare release-klare, med mindre lista eller visningen eksplisitt er satt til Utkast eller Alle.

**Planlegge sett og album**
10. Nytt felt på spillelister: **Type**: Vanlig, **Album-plan** eller **Sett-plan**. Planer kan blande utkast og release-klare, og viser:
    - Status øverst: «7 av 10 mastret».
    - Brikker per rad.
    - Total tid og BPM-/Camelot-flyt mellom låtene (grønn = harmonisk, gul = ±1, rød = brudd).
    - Filteret **Mangler master**.
11. Vanlige spillelister advarer når du legger til et utkast («Dette er et utkast – legg til likevel?»), med valget «Ikke spør igjen for denne lista».

**Lydnivå**
12. Umastrede låter er ofte mye svakere enn masterne. LUFS-utjevningen kan bare dempe (`audio.volume` ≤ 1), så utkast ville låte svake ved siden av masterne i en plan.
    - Løsning: ved ingest av **utkast** lages HLS-strømmen med loudness-normalisering til målnivået (ffmpeg `loudnorm` i to passeringer, true peak −1 dBTP).
    - `master.flac` lagres uendret.
    - Låtinfo viser både målt original-LUFS og «Normalisert for avspilling».
    - Release-låter rører vi ikke, som før.

**Deling**
13. Utkast kan **ikke** legges i drops (del 13) eller deles som lenke.
14. Fildeling (del 10) av utkast krever et ekstra valg: «Del utkast likevel». Da får filnavnet og tittelmetadata « (Utkast)», og albumfeltet blir «Groovehouse Records – Demo».

**Tester:** status fra mappe, samme slug i begge mappene gir riktig versjonskjede, «følg nyeste» foretrekker release, filtrene (bibliotek, bland, smarte lister, forslag, Ctrl+K), at utkast avvises i drops, loudnorm bare på utkast, og at REASONDONE og utkastmappa aldri endres.

**Ferdig når:** Knut peker utkastmappa på sine umastrede låter. Biblioteket viser fortsatt bare de release-klare, og «Utkast»-segmentet viser resten tydelig merket. Han lager en Album-plan med fem utkast og to mastrede låter og ser «2 av 7 mastret». Når han så eksporterer master av ett av utkastene til REASONDONE, står det «3 av 7» og planen spiller masteren.

## Del 17 – Settbygger: automatisk sammensatte DJ-sett

Mål: Knut velger varighet og stil. Vault setter sammen de beste settene av låtene han har, etter de reglene erfarne DJ-er faktisk bruker. Resultatet lagres som **planlagte sett** under **Live-sett**.

**Ærlig avgrensning:** vi har ikke data fra «verdens beste sett» å trene på. Kjente tracklister består av andres låter, og vi har ikke analyse av dem. Derfor bygges det på **etablerte prinsipper** (under) med vekter som kan justeres. Vault lærer i tillegg av Knuts egne valg: hva han bytter ut og flytter, og overgangene i hans faktiske live-logger (`live_log.json`).

**Forutsetninger:** del 3 (presis BPM og toneart) og del 2 (riktige intro- og outro-markører) må være på plass. Feil toneart eller BPM gir feil sett. Vis en advarsel på låter med lav analyse-sikkerhet og foreslå å sjekke dem.

**Kriterier (hver gir poeng per overgang eller for hele settet)**
1. **Harmonisk miksing (Camelot):**
   - Best: samme nøkkel, ±1 på hjulet og relativ dur/moll (8A↔8B).
   - Akseptabelt med vilje: «energiløft» +2 og +7 (halvtone opp).
   - Straff: alt annet. Vis relasjonen på hver overgang («8A → 9A»).
2. **Tempo:**
   - Nabolåter innen ±3 %. Over ±6 % straffes hardt.
   - Jevne tempoendringer over flere låter er bedre enn hopp.
   - Halv- og dobbelt-tempo regnes som match.
3. **Energikurve:**
   - Hver låt får en energiscore 1–10 fra analysen (lydstyrke i drop-seksjonene, bass-energi, transient-tetthet). Knut kan overstyre den i Studio.
   - Settet følger en valgt kurve:
     - **Oppvarming:** jevn stigning.
     - **Peak time:** høyt med små pustepauser.
     - **Reise:** bølger opp og ned med topp ved ca. 70 %.
     - **Avslutning:** fallende.
     - **Egen:** Knut tegner kurven.
4. **Mikspunkter:**
   - Foretrekk overganger der låt A har en ren outro og låt B en ren intro på minst 16 takter, fra strukturmarkørene.
   - Mikspunktene legges på frasegrenser (8/16/32 takter).
   - Første låt bør ha lang intro, siste låt en tydelig outro.
5. **Variasjon:**
   - Aldri samme låt to ganger. Ikke to versjoner eller varianter av samme låt i ett sett.
   - Unngå mange like låter etter hverandre: samme toneart mer enn tre ganger på rad, eller nesten lik energi for lenge.
6. **Lydnivå:** store sprang i LUFS mellom nabolåter straffes litt. For utkast brukes det normaliserte nivået (del 16).
7. **Varianter:** for DJ-sett foretrekkes **Extended**-varianter. For korte sett under 30 min kan originalversjonen brukes.

**Algoritme**
8. Lag en kostnadsmatrise for alle par av kandidatlåter (kriterie 1, 2, 4 og 6). Finn rekkefølgen med beam search, og forbedre med lokal søk / simulert nedkjøling mot hele målet (overganger + energikurve + variasjon + varighet).
   - Deterministisk med frø, så samme valg gir samme sett.
   - Raskt nok til å kjøre lokalt: under 3 s for 200 låter.
9. Lag **tre alternativer** med ulik karakter, f.eks. «tryggest harmonisk», «mest energi» og «mest variasjon». Vis totalscore og delscore per kriterium.

**Bruk**
10. **Lag sett** fra Live-sett (og fra DJ-verktøy):
    - Varighet: 30, 60, 90, 120 min eller fritt.
    - Kurve, og eventuelt BPM-spenn og starttoneart.
    - **Må være med:** fest låter, eventuelt på bestemte plasser. **Utelat** låter.
    - **Ta med utkast:** av som standard (del 16).
11. Resultatvisning:
    - Liste med overganger mellom låtene: Camelot-relasjon, tempojustering i %, mikspunkt («ut ved 5:12 / inn ved 0:32, 16 takter») og farge for hvor god overgangen er.
    - Energikurven tegnes oppå målkurven.
    - **Bytt ut** på en plass gir de 5 beste alternativene som passer begge naboene.
    - **Lås og bygg på nytt** beholder låste plasser og regner om resten.
12. **Lagre** gjør settet til en Sett-plan (del 16) under **Live-sett → Planlagte sett**. Den holdes atskilt fra **Innspilte sett**, som er Knuts faktiske live-opptak. Planlagte sett kan spilles som vanlige spillelister.
13. **Eksport** til rekordbox XML, med mikspunktene som hot cues / memory cues, og til M3U. Da kan settet brukes direkte i hybride live-sett.

**Læring (enkel i første versjon)**
14. Logg Knuts endringer (bytt ut, flytt, slett) og overgangene i innspilte sett. Bruk dem til å justere vektene litt over tid. Vis det åpent («Vektene er justert etter 12 av dine endringer»), med **Tilbakestill**.

**Senere (ikke i denne delen):** forhåndslytting av overganger med automatisk beatmatching (krever presis takt-fase fra del 3 og to avspillere), og vokal-deteksjon for å unngå vokal oppå vokal.

**Tester:** Camelot-relasjoner (alle 24 nøkler), tempo med halv/dobbel, at energikurven treffer målet innen toleranse, at låste plasser respekteres, ingen duplikater eller varianter av samme låt, determinisme med frø, ytelse med 200 låter, at utkast utelates som standard, og gyldig rekordbox-XML (validér mot et kjent eksempel).

**Ferdig når:** Knut ber om et 60-minutters «Reise»-sett. Han får tre forslag på under 3 sekunder, ser hvorfor hver overgang er valgt, bytter ut én låt, lagrer settet under Live-sett → Planlagte sett, og åpner eksporten i rekordbox med mikspunktene på plass.

## Del 18 – Overgangs-presets (FX-planer for overganger)

Mål: Knut får en idé til en overgang og lagrer den med **ett trykk**, så han ikke glemmer den. Presetene legger seg automatisk på riktige steder (mikspunkt og frasegrenser), og følger med til rekordbox. Det skal ta sekunder, ikke minutter.

**Viktig:** dette er en **plan og en huskelapp**, ikke lydbehandling. Vault spiller ikke effektene (ingen Web Audio på mobil). Effektene gjøres på kontrolleren eller mikseren i live-settet.

**Ferdige presets** (standard, i kode; kan kopieres og endres)
1. Hver preset har navn, ikon, farge, lengde i takter, hvilken deck den gjelder (ut/inn/begge) og 2–4 korte steg festet til takter relativt til mikspunktet. Eksempel for **Bass swap 16**:
   - takt −16: B inn, bass av
   - takt 0: bytt bass A→B
   - takt +8: A ut med HPF

   Standardsett:
   - **Lang blend 32**: EQ-blend over 32 takter, bass swap på takt 16
   - **Bass swap 16**
   - **Filter fade**: HPF opp på A over 16, B inn rent
   - **Echo out**: echo/delay på A siste 4 takter, B starter på frase
   - **Reverb wash**: reverb-hale på A, B inn etter break
   - **Cut på drop**: hard cut fra A til B sitt drop på frasegrense
   - **Loop & build**: loop 4→2→1 takt på A og B inn på drop
   - **Loop roll / stutter**: kort roll siste takt, så B
   - **Backspin / brake**: stopp A, B rett inn
   - **Acapella-lag**: B sin intro under A sitt break
   - **Energiløft (+2/+7)**: kort overgang med toneløft, fra Camelot-forslaget
   - **Rolig fade**: lang volumfade ned, for avslutning og nedtrapping
2. Brukeren kan **duplisere og endre** en preset (navn, steg, takter, farge) på under et halvt minutt. Lagres i `data/fx-presets.json`.

**Automatisk plassering**
3. Settbyggeren (del 17) velger en **standard-preset per overgang** ut fra overgangen:
   - God harmoni, lite tempoavvik og lange intro/outro: **Lang blend 32** eller **Bass swap 16**
   - Toneartskollisjon: **Echo out** eller **Cut på drop**
   - Tempoavvik over 3 %: **Echo out** eller **Loop & build**
   - Stort hopp opp i energi: **Loop & build** eller **Cut på drop**
   - Ned i energi: **Filter fade** eller **Reverb wash**
   - Siste låt: **Rolig fade**

   Vis forslaget som en brikke på overgangen. Bytte er **ett trykk** (horisontal rad med de 6 mest brukte, «Flere…» for resten).
4. Stegene festes til takter ut fra mikspunktet og settes på **frasegrenser** (8/16/32). De vises som små markører i bølgeformen (zoom) for begge låtene.
5. **Læring:** velger Knut samme preset ut av eller inn i en låt to ganger, foreslås den automatisk neste gang («Echo out passer alltid etter *Blue Fire*»).

**Rask idéfangst (mens han lytter, også i bilen)**
6. Mens et planlagt sett eller to låter spilles etter hverandre, vises en knapp **Idé for overgang** i fullskjermspilleren og i «⋯»-menyen. Ett trykk åpner presetraden. Ett trykk til lagrer presetet på overgangen ut av låta som spilles. Valgfri kort tekst kan legges til, men kreves ikke.
7. Spilles en låt utenfor et sett: lagre idéen på låta («ut av denne: Echo out»). Den foreslås når låta havner i et sett senere.
8. Store treffflater og fungerer med én hånd. Ingen bekreftelsesdialog, bare en melding med **Angre**.

**Påminnelse når du øver**
9. Når et planlagt sett spilles, viser spilleren de siste 30 sekundene før mikspunktet: «Neste: **Echo out** – 8 takter igjen» med presetets farge, og stegene ett om gangen. Det vises også i varselet på Android (tekst under tittelen).

**Eksport**
10. **rekordbox XML:** hvert steg blir en navngitt memory cue på riktig takt («Echo out · A ut»), og mikspunktet blir en hot cue i presetets farge. Navn maks 32 tegn. **M3U:** presetnavn som kommentarlinje før hver låt.
11. **Utskrift/«jukselapp»:** én side per sett med låt, toneart, BPM og overgang (preset + steg), som PDF eller stor visning på mobil.

**Senere (ikke i denne delen):** talenotat for overgangsidéer (krever mikrofon-tillatelse i appen), og navn på effektene til Knuts egen kontroller.

**Tester:** regler for automatisk forslag, festing til frasegrenser, læring etter to like valg, rask lagring uten dialog og med angre, at påminnelsen kommer 30 s før mikspunktet, rekordbox-XML med navngitte cues og farger (validér mot kjent eksempel), og at egendefinerte presets overlever omstart.

**Ferdig når:** Knut spiller et planlagt sett i bilen, får en idé og lagrer «Echo out» på overgangen med to trykk. Hjemme ser han presetet i settet, med stegene plassert på takter, og etter eksport står cuene med navn i rekordbox.

## Del 19 – Skins (flere utseender)

Mål: Knut kan bytte hele utseendet med ett valg. Det skal være flere ferdige skins, ikke én fast farge. Grønn `#06B211`, som Antigravity satte som standard, blir ett av dem, ikke den eneste.

**Hva et skin er**
1. Et skin er en fil i `apps/web/src/skins/<id>.json` med:
   - Fargemodus: **Kameleon** (aksent fra coveret, som del 14) eller **Fast** (egen aksent og aksent-2).
   - Bakgrunn og panel-toning, styrke på glød (0–100 %), kantstyrke og hjørneradius.
   - Bølgeformstil: aksent/grå som i referansen, eller 3-bånd.
   - Om gull brukes i logoen (alltid ja) eller også i rammer (bare for skinnet «Gull klassisk»).

   Alt går via CSS-variablene som før. Ingen hardkodede farger i komponentene, og testen som stopper det, skal fortsatt gjelde.
2. **Ferdige skins:**
   - **Kameleon** (standard): coveret styrer, gull bare i logoen
   - **Cyan Studio:** fast cyan `#01E6FC`, som referansebildet
   - **Grønn Neon:** fast `#06B211` / `#14E177`, Antigravitys versjon
   - **Gull klassisk:** gull som ramme og coveret som aksent, det opprinnelige uttrykket
   - **Magenta Club:** fast magenta/rosa neon
   - **Ultraviolett:** fast lilla/blå
   - **Mono Studio:** nesten fargeløs: hvit/grå med svak glød, for lange økter
   - **OLED Svart:** ren svart bakgrunn og minimal glød, sparer batteri på S22

   - **Echo Groove Nights** (merkevareskin, se under)

   Alle aksenter må holde kontrastlåsen (≥ 4,5:1 mot bakgrunnen).

   **Echo Groove Nights:** bygd på Echo Groove-merkevareguiden i `docs/design/reference/echo-groove-nights.jpg`.
   - **Farger:**
     - Fast aksent hot pink/magenta (ca. `#FF2E9A`) og aksent-2 elektrisk fiolett (ca. `#8B3DFF`), med blålilla sekundærtone (ca. `#5B6CFF`).
     - Bakgrunn dyp natt-lilla (ca. `#0A0614`) med en svak rosa «måne»-glød (radial gradient) øverst til høyre bak hovedpanelet. Paneler med lilla toning.
     - Ta de eksakte verdiene fra bildet med pipette, og sjekk kontrasten.
   - **Glød:** sterk og myk neonrør-glød (som de skrevne tekstene i guiden), litt kraftigere enn i Kameleon. Bølgeformen spilt i rosa→fiolett-gradient.
   - **Logo:**
     - Skinnet kan vise **Echo Groove**-ordmerket (krom/holografisk skriftlogo) i stedet for Groovehouse-logoen øverst i sidemenyen og på oppstartsskjermen.
     - Krever ordmerket som PNG eller SVG med gjennomsiktig bakgrunn i `assets/brand/echo-groove/`. Spør Knut om fila, og bruk Groovehouse-logoen til den finnes.
     - Ikke prøv å gjenskape skriftlogoen med en font.
   - **Motiv:** hjerteslag-linja med hjerte fra guiden brukes som ikon for favoritter, som lasteanimasjon og som liten detalj under «Spilles nå».
   - **Skrift:**
     - UI beholder Satoshi og JetBrains Mono, for lesbarhet.
     - Små sitater og tomme tilstander kan bruke en neon-script (lisens som tillater selvhosting, f.eks. OFL) med glød, sparsomt.
     - Paneletiketter i sperret versal, som «MUSIC · PEOPLE · NIGHTS · NO LIMITS».
   - **Tomme tilstander og oppstart:** korte tekster i guidens tone, f.eks. «Let the music find you», «Music lives here», «Deeper · Louder · Hotter».
   - **Bilder:** ingen av fotografiene fra guiden brukes i appen. Coverne til låtene er innholdet.
3. Låter med manuell farge fra Studio beholder den bare i Kameleon-skinnet. Faste skins overstyrer.

**Valg og lagring**
4. **Innstillinger → Utseende:** rutenett med forhåndsvisning (et lite kort med cover, bølgeform og play-knapp i skinnets stil). Byttet skjer umiddelbart, uten omstart.
5. Skinnet lagres **per enhet**, så PC-en og telefonen kan ha ulike skins. Valgfritt: «Bruk samme på alle enheter».
6. **Eget skin:** «Dupliser og tilpass» med fargevelger for aksent, styrke på glød og bakgrunn. Lagres i `data/skins/`. Viser kontrastvarsel.
7. Listefargene fra del 9 og lyttersiden i del 13 påvirkes ikke. Lyttersiden følger alltid coveret.
8. I Android-appen settes også statuslinje, navigasjonslinje og oppstartsskjerm etter skinnet. OLED Svart bruker ren `#000000`.

**Tester:** alle ferdige skins består kontrastkravet, bytte uten omstart, lagring per enhet, at manuell låtfarge bare gjelder i Kameleon, og skjermbilder av hvert skin i `docs/design/compare/skins/`.

**Ferdig når:** Knut bytter mellom Kameleon, Cyan Studio og Grønn Neon i Innstillinger på PC-en og ser hele spilleren skifte med en gang. Han velger OLED Svart på telefonen uten at PC-en endres.

## Del 20 – Jevnere autosett: groove-analyse, energitidslinje og renderte overganger

Mål: settene settbyggeren lager skal ha overganger som er **så jevne som mulig**, og Knut skal kunne **høre** overgangen før han spiller den. Delen bygger videre på del 17 (settbygger), del 18 (presets) og del 3 (presis analyse).

**Forutsetning:** analyse-feil gir dårlige overganger uansett hvor smart algoritmen er. Del 3 med fasit må være gjort først. BPM må være presis til 0,1, og takt-fasen (første downbeat) må ligge innen ±10 ms.

### A. Ny analyse per låt (bruk Demucs, som allerede er installert for tekst)
1. **Stem-separasjon én gang per låt** (trommer, bass, vokal, resten). Lagre bare utledede data i `analysis.json`, ikke stems, som standard (plass). Kjøres i bakgrunnen etter ingest, med fremdrift i Studio.
2. **Takt-rutenett:** downbeat-fase og takt-for-takt BPM (for live-sett med tempoendringer). Gjør det synlig i markør-editoren, så Knut kan justere første downbeat med ett dra.
3. **Groove (fra trommestammen):**
   - **Swing %:** forsinkelse av off-beat 16-deler målt på hi-hat-båndet.
   - **Perkusjonstetthet:** anslag per takt.
   - **Mønster:** 4/4-kick eller brutt.
   - **Hat-lysstyrke.**
4. **Bass-karakter (fra bass-stammen):** sub-tung eller mellombass, sustain («gummibass») eller korte toner, og om bassen er aktiv i intro og outro.
5. **Vokalkart:** tidsintervaller med vokal (fra vokal-stammen). Brukes til å unngå vokal oppå vokal.
6. **DJ-vennlighet per låt:** lengde på ren intro og outro (bare trommer, uten vokal og helst uten bass) i takter. Vises som et merke («Intro 32 · Outro 16», eller «Kort intro» i gult).
7. **Ikke** forsøk å gjenkjenne elementer som «gospel-stabs» eller sjanger fra lyden. Det blir upålitelig. Stil håndteres i D.

### B. Hvordan settbyggeren lager jevne overganger
8. Ny **overgangsscore** = vektet sum av:
   - Camelot-relasjon × toneartsikkerhet
   - Tempoavvik (med pitch-lås)
   - Fraselikhet (A sin outro-start og B sin intro-start på samme frasegrense, og B sitt første drop der A slutter)
   - Vokalkollisjon i overlappen (hard straff)
   - Bass-kollisjon (begge med aktiv bass i overlappen gir straff, med mindre presetet er bass swap)
   - Groove-likhet (swing-avvik over ca. 4 % straffes ved lange blends)
   - Energisprang (maks +1 eller −2 per overgang, med mindre kurven ber om løft)
   - Nivåforskjell (LUFS)
9. **Lengden på overgangen velges etter scoren, som en DJ ville gjort:**
   - Alt passer: lang blend (32 takter).
   - Delvis: 16 eller 8.
   - Dårlig toneart eller groove: kort overgang (cut på frase, echo out, loop & build).
   - Presetet fra del 18 velges ut fra dette.
10. Mikspunktene settes slik at overlappen ligger **inni** de rene intro- og outro-områdene. Ellers kortes overgangen ned eller bytter type.
11. Settbyggeren foretrekker låter med lang ren intro og outro. Det gir mest jevnhet.

### C. Rendering av overganger
12. **Hør før du spiller:** for hver overgang i et planlagt sett lager Vault en forhåndsvisning (30–60 s) med ffmpeg:
    - Tempo-justering med bevart tonehøyde (rubberband om tilgjengelig, ellers atempo).
    - Takt-justering ut fra rutenettet.
    - Volum- og EQ-automasjon etter presetet: bass swap, høypassfilter, echo og reverb-hale.

    Filen spilles som vanlig lyd og virker derfor også på mobil og i appen, uten Web Audio.
13. **Automatisk kvalitetssjekk** av hver rendret overgang:
    - Takt-justering: krysskorrelasjon av anslag. Mål < 15 ms avvik.
    - Bass-kollisjon: lavfrekvens-energi i overlappen.
    - Vokal oppå vokal.
    - Nivåhopp.

    Overganger som stryker, merkes rødt og får automatisk et alternativ (annen preset eller lengde, eller en annen låt).
14. **Tommel opp eller ned** på hver overgang mates inn i læringen fra del 17 og 18.
15. **Auto DJ-edit (eksperimentelt, slått av som standard):** for låter med kort intro eller outro kan Vault lage en DJ-versjon. Den forlenger med 16 takter trommer, laget fra trommestammen og festet til frasegrensen, og lagres som varianten «DJ Edit». Den blir aldri release-materiale og vises med egen brikke.

### D. Knuts fire forslag, tilpasset
16. **Energitidslinje** (utvider settbyggeren):
    - Settet vises som en tidslinje der x er tid og y er energi 1–10.
    - Målkurven kan tegnes og dras.
    - Låtene ligger som blokker i coverfarge, med overgangene som flater mellom dem, farget etter score.
    - Dra en låt for å flytte den, eller dra i kurven for å be om ny bølge. Settbyggeren foreslår så låter som treffer den nye toppen.
    - Viser BPM-linje og toneart under.
17. **Groove-matching:** filterknappen **«Match groove»** i DJ-verktøy og Settbygger. Den vekter swing, perkusjonstetthet, kick-mønster og bass-karakter i tillegg til Camelot og BPM. «Passer etter …» viser groove-likhet i % per forslag.
18. **Forhåndsvisning av cue og loop** i «Passer etter …»:
    - Hvert forslag får en miniatyr-bølgeform med fargekodede markører: drop, breakdown, vokalstart, intro/outro-slutt og foreslått mikspunkt.
    - Trykk på en markør spiller derfra. Hold inne gir en 4- eller 8-takts løkke.
    - Knappen **«Hør overgangen»** spiller renderingen fra C, fra låta som spilles nå til forslaget.
    - **Fargene kommer fra aktivt skin (del 19)**, ikke en fast palett.
19. **Vibe Shifter:**
    - Raske brytere ved BPM-spennet: **Strammere / Bredere** (Camelot ±0 / ±1 / ±2 og BPM ±2 / ±3 / ±6 %), **Energi ↑ / → / ↓**, og **Stil**.
    - Stil bygger på **Knuts egne tagger**: ett trykk per låt («Deep», «Tech», «Cyber-Soul», egne navn) pluss en automatisk likhetsvektor fra analysen (BPM, swing, bass, lysstyrke, vokalandel). Vault foreslår tagger for nye låter ut fra likhet med de Knut har tagget. Ingen sjangergjenkjenning fra lyd utover det.
    - «Skift mot Tech» gjør at de neste forslagene og resten av settet glir mot låter tagget Tech, gradvis over 2–3 låter.

### Tester og ferdig når
**Tester:**
- Groove-mål på syntetiske filer med kjent swing (0/10/20 %) innen ±2 %.
- Vokalkart mot hånd-merkede tidsintervaller på 3 låter.
- Takt-justering i rendret overgang < 15 ms på fixtures.
- At overganger med vokalkollisjon aldri får lang blend.
- Determinisme.
- Rendering av et 60-min sett under 60 s på Knuts PC.

**Ferdig når:** Knut lager et 60-min sett. Alle overgangene har en rendret forhåndsvisning som han kan høre på telefonen. Ingen er rødmerket uten at et alternativ er foreslått. Han gir tommel opp på minst 80 % av overgangene ved første gjennomlytting.

## Del 21 – Vault på Raspberry Pi (alltid på, PC-en kan være av)

Mål: telefonen og appen virker som andre musikkapper, også når den store PC-en er av. En Raspberry Pi med ekstern disk står hjemme og spiller ut musikken døgnet rundt. PC-en er fortsatt studio: ingest, analyse, Demucs og rendering.

**Spør Knut først:** hvilken Pi-modell og hvor mye RAM, og hvilken disk (SSD eller HDD, størrelse).
- Pi 4 med 4 GB eller mer og Pi 5 er gode nok.
- Pi 3 eller eldre: si fra at den er for svak for HLS-servering til flere enheter samtidig og for ffmpeg.
- Disk: SSD via USB 3 anbefales. Det trengs minst 3× dagens `media/` for vekst.

**Arbeidsdeling**
1. **Pi = spillerserver.** Kjører `apps/server` i «spiller-modus»: API, `/media`, spillelister, favoritter, posisjoner, tekst, markører, enhetstokens, app-oppdateringer (del 15) og eventuelt fildeling (del 10, med ffmpeg på Pi-en).
   - **Ingen** ingest, Demucs eller rendering på Pi-en. Studio-handlinger som krever det, sendes til PC-en eller vises som «Krever PC-en».
2. **PC = studio.** Ingest og analyse som før. Etter hver ingest skyves nye eller endrede filer i `media/` til Pi-en (rsync over Tailscale eller LAN, kun endringer, med fremdrift i Studio).
   - **`master.flac` blir på PC-en.** Pi-en får bare strøm-filer, cover og analyse. Valgfritt: også masterne, hvis Knut vil ha delingen i del 10 tilgjengelig uten PC.
3. **Én sannhetskilde for brukerdata:** `data/` (spillelister, favoritter, posisjoner, tekster, markører, settplaner, presets, skins) bor på **Pi-en**. PC-ens server og Studio leser og skriver via Pi-ens API når den er tilgjengelig.
   - Når Pi-en er nede, går PC-en over til en lokal kopi og synker tilbake etterpå. Konflikter løses per element med `updatedAt`, uten stille overskriving.

**Oppsett på Pi-en**
4. Raspberry Pi OS Lite 64-bit og Node LTS. `media/` og `data/` på den eksterne disken (ext4), montert fast i `/etc/fstab`.
5. Vault kjører som **systemd-tjeneste** med automatisk omstart og logg i journald. Automatiske sikkerhetsoppdateringer (unattended-upgrades).
6. Lag et oppsettskript (`pnpm pi:setup` fra PC-en over SSH) og en README-guide steg for steg for Knut: brenne SD-kort med Raspberry Pi Imager (sett vertsnavn `vault`, bruker og SSH-nøkkel), koble disken, kjør skriptet. Spør Knut før hvert steg som endrer Pi-en.

**Tilgang utenfra (ingen porter åpnes i ruteren)**
7. **Tailscale på Pi-en**, med Tailscale Serve og HTTPS. Adressen blir f.eks. `vault.tail1110e6.ts.net`, og står bare i `groovehouse.local.json`.
8. **Valgfritt, Cloudflare Tunnel** fra Pi-en til `vault.groovehouserecords.com`, så appen virker **uten VPN**:
   - Bare API og `/media` eksponeres.
   - Enhetstoken kreves på alt.
   - Cloudflare Access foran Studio-sidene.
   - Rate limiting.

   Spør Knut før tunnelen settes opp.

**Appen**
9. Appen husker flere kilder og velger automatisk i denne rekkefølgen: **Pi via tunnel/Tailscale → PC via Tailscale → nedlastet på telefonen**. Ingen ny paring nødvendig: enhetstokens flyttes fra PC til Pi ved første synk.
10. **Nedlasting for offline:** last ned spillelister, sett eller hele biblioteket til appen. Det tar mest plass på telefonen og gjør bilen uavhengig av dekning. Vis brukt plass, og la Knut velge kvalitet.

**App-oppdateringer via Pi-en**
10b. Oppdateringene fra del 15 (web-bunt og APK) **serveres fra Pi-en**, så appen oppdaterer seg også når PC-en er av.
   - `pnpm android:release` på PC-en bygger som før og **skyver bunt, APK og `manifest.json` til Pi-en** i samme synk som media.
   - Appen spør den kilden den er koblet til (Pi via tunnel/Tailscale, ellers PC).
   - Bunt og APK signeres og kontrolleres med sha256 som før. Pi-en kan aldri lage eller endre dem, bare levere dem.
   - Test at en ny web-bunt når telefonen med PC-en av.

**Backup**
11. Nattlig kopi av Pi-ens `data/` til PC-en (H:) og omvendt for `media/`. Én disk er ikke backup. Status vises i Studio («Siste backup: i natt 03:00»).

**Tester:** synk av media (bare endringer, avbrudd og fortsettelse), konflikter i data/ (to enheter endrer samme liste), automatisk kildevalg i appen, at Pi-en aldri får ingest-jobber, at tunnelen avviser alt uten token, og omstart av Pi-en (tjenesten kommer opp av seg selv).

**Ferdig når:** Knut slår av den store PC-en. Han spiller en spilleliste i bilen fra telefonen, lager en ny liste, slår på PC-en igjen og ser lista der. En ny bounce fra Reason dukker opp på telefonen noen minutter etter at PC-en har ingestet den.

## Del 22 – Visuell finpuss: typografi, glass og stramt oppsett

Mål: grensesnittet skal føles eksklusivt og være **lynraskt å lese** i studio og under live-sett. Bort med flate grå bokser og harde kanter. Gjelder alle skins (del 19). Farger kommer fortsatt **bare fra skin-variablene**, aldri hardkodet cyan eller fiolett.

**1. Typografi** (erstatter Satoshi + JetBrains Mono som standard; alle selvhostet som woff2 med lisensfil)
1. **Display / titler:** **Clash Display** (Fontshare, ITF Free Font License, samme lisens som Satoshi) til låttittel i spilleren, sidetitler og store tall.
2. **Seksjonsetiketter:** **Syncopate Bold** (OFL) i versaler med sperring, små (11–12 px): «LÅTINFO», «SPEKTRUM», «PASSER ETTER …». Kun etiketter, aldri brødtekst.
3. **Brødtekst og lister:** **Inter** (OFL) med `font-feature-settings: "tnum", "cv11"`.
4. **Data:** **Geist Mono** (OFL) til BPM, toneart, LUFS, tider og format. Tabulære tall.
5. **Hierarki:**
   - Etiketter: tykk versal, dempet farge.
   - Data: lett/regular, full kontrast.
   - **Aktiv låt** i lister: Inter SemiBold/Bold i aksentfargen.
   - Minstestørrelser: 13 px data, 11 px etiketter, 15 px listetitler på mobil.
6. Skins kan overstyre display-fonten (f.eks. Echo Groove Nights). Resten er felles.

**2. Materialer og dybde**
7. **Fjern nesten alle synlige kantlinjer** rundt spiller, knapper, sidepanel og kort. Skill elementer med luft og små forskjeller i bakgrunn (1–3 % lysere lag). Kantlinjer kun der det trengs for fokus eller tilgjengelighet.
8. **Glass:** bunn i skinnets bakgrunn (obsidian eller midnattsblå). Paneler med svak gjennomsiktighet og `backdrop-filter: blur(20–28px) saturate(140%)`, og en hårfin lyskant øverst (1 px hvit på 6–8 %) i stedet for ramme.
   - **Ytelse:** på mobil og i Android-appen brukes blur bare på 1–2 store flater (minispiller og fullskjermspiller). Resten får en ferdig tonet, halvgjennomsiktig bakgrunn uten blur. Mål 30 fps på S22.
   - Skinnet OLED Svart bruker ingen blur.
9. Skygger i stedet for rammer: myke, store skygger i aksentfargen på lav styrke for flater som ligger øverst.

**3. Strammere oppsett**
10. **Bølgeformen fra kant til kant** i spillermodulen, uten indre boks eller marg. Tider legges oppå bølgeformen nederst i hvert hjørne.
11. **Transportknapper:** fjern sirklene rundt forrige/neste/bland/gjenta. Ikonene blir 15–20 % større. **Play/pause** beholder en myk glød (drop-shadow i aksent, sterkere ved hover og avspilling) uten hard ring. Treffflater minst 44 px.
12. **Låtinfo som rutenett av pills:** 2 kolonner. Hver verdi er en liten pill med etikett over (Syncopate, dempet) og verdi i Geist Mono. Pillens bakgrunn er aksent på 8–12 %, f.eks. `BPM 124.5`, `TONEART Bb · 6B`, `LUFS −15.3`, `TID 3:12`, `FORMAT WAV 16/44.1`. Camelot-pillen får harmoni-farge mot låta som kommer etter i køen.
12b. **Detaljer fra Knuts utkast (Next.js/WaveSurfer-utkastet). Bruk ideene, ikke koden:**
   - **Ikke** bruk WaveSurfer.js eller Next.js/`next/font`. Bølgeformen tegnes fortsatt fra `analysis.json` på canvas (virker på mobil og i appen uten Web Audio).
   - Bølgeformen tegnes som **stolper**: 3 px bredde, 2 px mellomrom, 2 px avrunding. Vertikalt normalisert så den fyller hele høyden.
   - Uspilt del i aksent-2 på ca. 30 %, spilt del i aksent på ca. 90 %.
   - **Skarpt hvitt spillehode** (2 px) med svak glød.
   - Et **glød-lag bak bølgeformen** (myk gradient i aksent og aksent-2, sterk blur). Det går fra ca. 30 % til 100 % styrke når avspillingen starter, over 0,7 s. Av ved redusert bevegelse.
   - **Play-knappen:** fylt sirkel i aksent med mørkt ikon (`--on-accent`) og glød, som skaleres litt opp ved hover. Andre transportikoner er uten sirkel.
   - **Aktiv rad i lister:** 2 px aksentstripe til venstre og aksent på 5 % i bakgrunnen. Nummer og tittel i aksent.
   - **Tabelloverskrifter** i Syncopate, små versaler med god sperring og dempet farge.
13. Se gjennom alle sider for samme regler: Hjem, Bibliotek, DJ-verktøy, Settbygger, Live-sett, Studio og Innstillinger. Fjern dobbel informasjon og grupper med luft i stedet for bokser.

**Tester:**
- Visuell sammenligning før og etter for desktop (1536×1024) og mobil (390×844), i tre skins, i `docs/design/compare/del-22/`.
- Testen som stopper hardkodede farger og fonter fra CDN gjelder fortsatt.
- Fps-måling i Android-appen.
- Kontrast ≥ 4,5:1 på data og ≥ 3:1 på etiketter.

**Ferdig når:** Knut sammenligner før og etter og synes det nye er tydeligere og mer eksklusivt. Han kan lese BPM og toneart på låta som spilles, fra en armlengdes avstand på PC-en, og appen er like jevn på S22 som før.

## Del 15 – Oppdatering av Android-appen

Mål: Knut skal ikke måtte bygge og sende APK-er for hånd hver gang noe endres. Endringer i grensesnittet kommer automatisk. Endringer i den native delen gir et «Oppdater»-varsel i appen, og da holder ett trykk.

**To typer oppdatering**
1. **Grensesnitt (web-bunten):** nesten alt Knut ser er web-koden i `apps/web` (del 9, 11 og 14 osv.). Den oppdateres uten ny APK.
   - Ved oppstart og når appen kommer i forgrunnen, spør appen `GET /api/app/bundle` → `{ version, sha256, size, minNative }`.
   - Er versjonen nyere og `minNative` ≤ appens versionCode: last ned zip-en, sjekk sha256, og bruk den **ved neste oppstart**. Aldri bytt mens musikk spilles.
   - **Automatisk tilbakerulling:** starter ikke den nye bunten riktig (appen melder «klar» innen 10 s), brukes den forrige.
   - Bruk en selvhostet oppdaterer, f.eks. `@capgo/capacitor-updater` i manuell modus, eller en enkel egen løsning. Sjekk lisensen, og spør hvis den er sterk copyleft.
2. **Native (APK):** endringer i Kotlin/Media3, tillatelser eller Capacitor-plugins krever ny APK.
   - Appen spør `GET /api/app/apk/latest` → `{ versionCode, versionName, sha256, size, notes }`.
   - Er versionCode høyere, vis et diskret banner: «Ny app-versjon – Oppdater».
   - Ved trykk: last ned APK-en til appens cache, sjekk sha256, og åpne Androids installasjonsdialog (FileProvider + `REQUEST_INSTALL_PACKAGES`).
   - Første gang ber Android Knut tillate «Installer ukjente apper» for Groovehouse Vault. Forklar det i en kort tekst før dialogen.

**Publisering fra PC-en**
3. `pnpm android:release` gjør tre ting:
   - Bygger web-bunten og legger den i `data/app/bundle/<versjon>.zip`.
   - Bygger APK-en hvis den native koden er endret siden sist (sjekk hash av `apps/android/android/` og pluginene), og legger den i `data/app/apk/`.
   - Oppdaterer `data/app/manifest.json`.

   `vault:install` og bygg av web-appen kaller bunt-steget automatisk, så grensesnittet på mobilen alltid følger PC-en.
4. **versionCode skal aldri gå ned.** Bruk en teller i `%LOCALAPPDATA%\GroovehouseVault\android\build-counter` (maks av teller + 1 og antall commits), ikke bare `git rev-list --count`. Ellers kan et bygg fra en annen gren gi lavere kode, og Android nekter å installere.
5. Endepunktene ligger bak samme tilgang som resten (Tailscale + enhetstoken) og er aldri tilgjengelige fra `/drop/` eller del 13.
6. **Studio → Innstillinger → Enheter:** vis hvilken app- og bunt-versjon hver tilkoblet enhet kjører (appen sender det i en header), og hva som er nyeste.

**Tester:** versjonssammenligning og `minNative`-regelen, sha256-feil avviser, tilbakerulling ved ødelagt bunt, ingen bytte under avspilling, versionCode-telleren, og at endepunktene krever token.

**Ferdig når:** Knut installerer APK-en med oppdatereren én gang for hånd. Etter det endrer Claude Code noe synlig i web-appen, og Knut ser endringen på telefonen etter å ha lukket og åpnet appen, uten å røre en APK. En endring i native kode gir «Oppdater»-banneret, og ett trykk pluss Androids bekreftelse installerer den.

## Del 14 – Nytt utseende: «High-End Studio»

Mål: spilleren skal se ut og føles som referansebildet. Det er et produsentverktøy med glasspaneler, neon-glød, tydelig hierarki og tekniske data i monospace. Referanse: `docs/design/reference/high-end-studio.png` og forklaringen `docs/design/reference/high-end-studio-breakdown.png`. Studer begge før du starter.

**Låste valg fra Knut (2026-11-14)**
- **Coveret styrer fargene.** Cyan i bildet kommer av at coveret er blått. Med rødt cover blir hele uttrykket rød neon. Alle aksenter, glød, aktiv fane, play-ringen, slider, aktiv rad og spilt del av bølgeformen går via `--accent`, `--accent-2`, `--glow` fra `assets.palette`, som før. Ingen hardkodet cyan i komponentene. Kontrastlåsen (≥ 4.5:1) gjelder fortsatt.
- **Gull bare i logoen.** Dette erstatter «gullet er rammen». Oppdater `README.md` og `docs/CLAUDE_CODE_PROMPT.md` tilsvarende. Rammer og paneler er nøytrale (glass) med en tynn kant i aksentfargen.
- **Menyen er tilpasset Knuts innhold**, ikke kopiert fra bildet (se under).
- **Ikke bygg** stripen nederst i referansebildet (Font pairing / Key traits / Design vibe). Den er en presentasjon, ikke en del av appen.

**Designsystem**
1. **Skrift:**
   - **Satoshi** (Fontshare, ITF Free Font License; legg lisensfila ved) til overskrifter og UI.
   - **JetBrains Mono** (OFL) til alle data: BPM, toneart, LUFS, tider, format og tallkolonner.
   - Selvhost begge som woff2 i `apps/web/public/fonts/`, ingen CDN. Tabulære tall.
2. **Flater:**
   - Bakgrunn `#07080B` med en svak radial toning av aksentfargen bak hovedpanelet.
   - Paneler som glass: `rgba(255,255,255,0.03)`, 1 px kant i aksent på 20–30 % alfa, avrundede hjørner 14–16 px og ytre glød i aksent på lav styrke.
   - Aktive elementer får full neon-glød, med samme oppskrift som `neonGlow` i del 9.
   - Unngå tunge `backdrop-filter` på mobil og i Android-appen.
3. **Etiketter:** små versaler med sperring (`TRACK INFO`-stil) for paneltitler. Tekstinnhold på norsk.
4. **Ikoner:** linjeikoner med 1,5 px strek, samme sett overalt.
5. **Redusert bevegelse** respekteres: ingen pulsering og ingen animert glød.

**Desktop-layout (≥ 1280 px), som i referansen**
6. **Venstre sidemeny:** Hjem, Bibliotek, Spillelister, Live-sett, DJ-verktøy, Analyse, Vault (Studio). Innstillinger nederst. Aktivt punkt får glød. Spillelistene med fargeprikker (del 9) ligger under «Spillelister» som en utvidbar liste.
7. **Øverste rad:**
   - **Cover-kort:** cover, tittel, artist, hjerte (favoritt) og «⋯» (`TrackActions` fra del 11).
   - **Spilles nå-panel:**
     - Faner: **Spilles nå · Kø · Tekst · Kreditering**, med utgang-/«⋯»-ikoner til høyre.
     - Stor bølgeform: spilt del i aksent med glød, uspilt i grått, tynn spillehode-linje og tider med millisekunder (`02:41.320`) i mono.
     - Transport: bland, forrige, play/pause i ring, neste, gjenta.
     - Nederste linje: volum, **A·B-løkke**, **hastighet** (1.0x) og lydinnstillinger.
   - **Høyre kolonne:** **Låtinfo** (BPM, toneart + Camelot, LUFS, tid, format), **Bølgeform-zoom** og **Spektrum (Hz)**.
8. **Låttabell under:**
   - Kolonner: #, cover, tittel, artist, BPM (sorterbar), toneart, LUFS, varighet, hjerte og «⋯».
   - Raden som spilles, markeres med aksent-bakgrunn og et lite equalizer-ikon i stedet for nummeret.
9. **1024–1279 px:** høyre kolonne blir faner under bølgeformen (Låtinfo / Zoom / Spektrum).

**Mobil og Android-app**
10. **Fullskjermspiller**, ovenfra og ned:
    - Cover
    - Tittel, artist, hjerte og «⋯»
    - Rad med brikker i mono: BPM, toneart, LUFS
    - Bølgeform med tider
    - Transport
    - Volum (skjules i appen, der volumknappene brukes), A·B og hastighet
    - Sveipbare kort: Låtinfo / Spektrum / Zoom
    - Fanene Spilles nå · Kø · Tekst · Kreditering som segmentert kontroll

    Minispiller og bunnmeny beholdes i ny stil. Listerader viser BPM og toneart i mono.

**Funksjoner bildet krever**
11. **Spektrum uten Web Audio:**
    - Utvid analysen med `spectrum48`: 48 logaritmiske bånd 20 Hz–20 kHz, 20 bilder/s, Uint8 base64.
    - Tegnes på canvas ut fra avspillingsposisjonen, med glatting (rask stigning, langsomt fall).
    - Virker likt på web, desktop og i Android-appen, der lyden spilles native og ikke kan analyseres fra WebView.
    - Øk analyse-versjonen og fyll inn for alle eksisterende låter fra `master.flac`.
    - Mangler data: vis «Analyserer…», ikke et tomt panel.
12. **Bølgeform-zoom:**
    - Vindu rundt spillehodet, standard ±8 s, justerbart 2–30 s med hjul eller klyp.
    - Dra for å spole.
    - Viser seksjonsmarkørene og et takt-rutenett ut fra BPM.
13. **A·B-løkke:**
    - Sett A og B med knappen, eller dra i bølgeformen.
    - Fester seg til takter, og Shift slår det av.
    - I Android-appen gjøres løkken native (`NativePlayer.setLoop(a, b)`), så den virker med skjermen av.
14. **Hastighet:**
    - 0,90–1,10 i steg på 0,01, med tonehøyden bevart (`preservesPitch` på web, `PlaybackParameters` i ExoPlayer).
    - Dobbeltklikk nullstiller. Hastigheten lagres ikke per låt.
15. **Favoritter:**
    - Hjertet lagres i `data/favorites.json` via API, med samme tilgangsregler som spillelistene.
    - Gir en innebygd smart liste **Favoritter**.
16. **Tekst:**
    - Fra `data/lyrics/<slug>.lrc` (synkronisert) eller `.txt`. Kan redigeres i Studio.
    - Synkronisert tekst ruller med avspillingen.
    - Tom tilstand: «Ingen tekst ennå – legg til i Studio».
17. **Kreditering:** artist, label, ℗, album, variant/versjon, ingest-dato, analyse-sikkerhet for BPM og toneart, og kildefil (privat, som i del 11).
18. **Format:**
    - Lagre kildeformatet fra masteren i manifestet ved ingest (f.eks. «WAV 16-bit / 44,1 kHz»), og fyll inn for eksisterende låter.
    - Vis det i Låtinfo med strømmeformatet under, i dempet tekst («Strømmes som AAC 256 kbps»).
19. **Nye sider, enkle i første versjon:**
    - **Hjem:** fortsett der du slapp, nylig spilt, nylig lagt til, spillelister med glød.
    - **DJ-verktøy:**
      - Camelot-hjul med låtene plassert.
      - Filter på BPM-spenn.
      - «Passer etter denne»: Camelot ±1 eller relativ dur/moll, og BPM ±3 %.
    - **Analyse:** egne avspillinger (mest spilt, tid lyttet) fra lokal logg. Lytteinnsikt fra andre kommer med del 13.

**Kvalitet**
20. Ytelse:
    - Bølgeform, zoom og spektrum tegnes på canvas og pauses når fanen er skjult.
    - Mål 60 fps på desktop og stabile 30 fps på S22 i appen.
21. Tilgjengelighet: tastaturnavigasjon, fokusringer i aksent, `aria`-etiketter på transport og faner.

**Tester:**
- Analyse: `spectrum48` (størrelse og frekvensakser).
- Avspilling: A·B-løkke (web og native-kontrakt), hastighet og tonehøyde, favoritter (API), parsing av LRC.
- Visuell sammenligning: skjermbilder i hodeløs Edge i 1536×1024 og 390×844, med to låter med ulik coverfarge. Legg dem side om side med referansen i `docs/design/compare/` så Knut kan se dem.

**Ferdig når:** Knut åpner desktop-appen og spiller en låt med blått cover, og det ligner referansebildet. Han bytter til en låt med rødt cover, og hele uttrykket blir rød neon. Fullskjermspilleren i Android-appen har samme stil, med spektrum som beveger seg i takt med musikken mens han spiller med skjermen på.

## Del 13 – Deling med lenker (drops)

Mål: Knut sender én låt, en spilleliste eller et live-sett til en bestemt person med **én lenke**. Mottakeren trykker og hører, uten noe annet. Lenken kan trekkes tilbake, utløper og gir lytteinnsikt. Dette er alternativet til fildelingen i del 10 når Knut vil ha kontroll over hvor musikken havner.

Tailscale-adressen virker bare for Knuts egne enheter og skal **aldri** havne i en lenke til andre. Tailscale Funnel skal ikke brukes.

**Krav til lytteren (låst av Knut):** Mottakeren skal **aldri** trenge Tailscale, en app, en konto, et passord eller en adresse å skrive.
- Ett trykk på lenken i WhatsApp/SMS/e-post, og låta spiller i nettleseren innen et par sekunder. Lenken gir forhåndsvisning med cover og tittel.
- Lenken *er* tilgangen (personlig token per mottaker). Enheten huskes stille med en informasjonskapsel, så den virker igjen neste gang uten noe ekstra.
- Enhetsgrensen (f.eks. 2 enheter) håndheves stille. Prøver en tredje enhet å åpne lenken, vises «Denne lenken er personlig – be Knut om en egen», ikke en innloggingsside.
- Utløpt lenke: en vennlig side med «Be om ny tilgang», som sender Knut et varsel. Lytteren skriver ikke noe annet enn eventuelt navnet sitt.
- Ingen kode eller PIN som standard. En valgfri 4-sifret kode per drop finnes bare for særlig sensitive drops, og skrives da i samme melding som lenken.
- Alt dette kjører i skyen (Worker + R2), helt atskilt fra PC-en. Tailscale og PC-adressen brukes bare av Knut.
- **Domene: `listen.groovehouserecords.com`** (Knut eier `groovehouserecords.com`). Lenker ser slik ut: `listen.groovehouserecords.com/d/<token>`. Worker-ruter krever at DNS-sonen ligger i Cloudflare (gratisplan). Før nameserverne flyttes, kopier **alle** eksisterende DNS-poster (nettside, e-post/MX, SPF/DKIM, verifiseringer) og vis Knut lista. Nettside og e-post på domenet skal ikke falle ut. **Status 2026-11-14:** DNS for `groovehouserecords.com` er flyttet til Knuts Cloudflare-konto (gratisplan, aktiv). Registrar er fortsatt GoDaddy. Det finnes ingen nettside og ingen e-post/MX. Eneste poster er GoDaddys parkerings-A-poster (`@`, `www`), som kan slettes når Worker-ruten for `listen.` settes opp. DNSSEC er av.

**Arkitektur (alt i Knuts Cloudflare-konto, gratisplan)**
1. **Worker** `groovehouse-listen` på ruten `listen.groovehouserecords.com/*`, i `apps/listen-worker` (TypeScript, wrangler).
2. **R2-bucket** `groovehouse-drops` (privat): HLS-segmenter, cover, `analysis.json` og eventuelt `.m4a` for nedlasting, **bare for låter som ligger i en drop**. Hele katalogen lastes aldri opp. Ingen offentlig tilgang til bucketen; alt går via Workeren.
3. **D1** `groovehouse-listen` for `drops`, `drop_items`, `invites`, `invite_devices`, `listen_events` og `access_requests`. Bruk skjemaet fra `supabase/migrations/20261113000000_init.sql` som utgangspunkt, oversatt til SQLite. **Endring fra tidligere plan:** D1 i stedet for Supabase, så alt ligger i én konto og ingen nye tjenester trengs. Supabase-migrasjonene beholdes til del 5.
4. **Lyttersiden** (`/d/<token>`) er en egen liten side servert av Workeren, på engelsk, i samme stil som spilleren: samme designsystem som del 14 (glasspaneler, Satoshi + JetBrains Mono, neon fra coveret). Bruk komponentene fra `apps/web` (bølgeform, spillerkontroller) der det går, men bygg den som eget lettvektig bundle. Ingen innlogging, innstillinger eller installering.
5. **PC-en** er admin: Studio/Command Center lager drops og snakker med Workerens admin-API med et admin-token. Tokenet ligger som Worker-secret og i Windows Credential Manager, aldri i git.

**Sikkerhet og tokens**
6. Lenketoken: minst 128 bit tilfeldig (base62, ca. 22 tegn). Lagres bare som hash i D1.
7. Ved første avspilling på en enhet settes en `HttpOnly; Secure; SameSite=Lax`-informasjonskapsel med enhets-id. Enhetsgrensen telles **når avspilling starter**, ikke når siden hentes. Ellers bruker WhatsApp/iMessage sine forhåndsvisnings-roboter opp en enhet.
8. HLS-segmentene hentes via Workeren med kortlivede signerte URL-er (HMAC, 10 min), knyttet til invitasjon og enhet. Segment-URL-er alene skal ikke kunne deles.
9. Trekk tilbake en lenke i Studio, så slutter den å virke umiddelbart (også midt i avspilling ved neste segment).
10. Rate limiting på `/d/*` og admin-API. Admin-API godtar bare admin-tokenet.

**Forhåndsvisning i WhatsApp/iMessage**
11. `/d/<token>` gir `og:title` («Echo Groove – <Tittel>» eller dropnavnet), `og:description` («Private listen · Groovehouse Records») og `og:image` 1200×630, laget ved publisering fra coveret med palett og gullramme. Bildet lastes opp til R2 og serveres med en egen langlivet signert URL. Sjekk at forhåndsvisningen faktisk vises i WhatsApp.

**Publisering fra PC-en**
12. «Opprett drop» (fra en liste, flervalg eller «⋯ → Del lenke» på én låt) laster opp de valgte låtene (allerede ingestet HLS + cover + analyse) til R2, oppretter drop og invitasjon via admin-API og returnerer lenken. Opplasting er idempotent på hash, så samme låt i flere drops lastes opp én gang.
13. Når en drop slettes eller utløper, og ingen andre drops bruker en låt, slettes låtens filer fra R2 etter 7 dager.
14. «⋯ → Del…» (del 10) får et nytt førstevalg: **Del lenke** (strømming, anbefalt), mens **Send fil** blir valg nummer to.

**Følge opp**
15. Lyttesiden sender `listen_events` (start, 30 s, 50 %, ferdig, hopp) til Workeren. Command Center henter dem via admin-API og viser lytteinnsikt per mottaker.
16. «Be om ny tilgang» fra en utløpt eller full lenke lagres i `access_requests`. PC-serveren sjekker hvert minutt og viser et Windows-varsel og et merke i Studio. Knut godkjenner med ett klikk, og får en ny lenke å sende.
17. Lyttelogger slettes automatisk etter 180 dager. En kort personvernerklæring (engelsk) lenkes fra lyttersiden.

**Oppsett Knut må godkjenne**
18. `wrangler login` åpner nettleseren der Knut godkjenner tilgang til Cloudflare-kontoen. Spør før du kjører den. Opprett så Worker, R2-bucket, D1 og ruten, og slett GoDaddys parkerings-A-poster for `@` og `www` i Cloudflare-DNS (vis Knut hva som slettes).
19. Kostnad: alt skal holde seg innenfor gratisplanen (Workers 100k forespørsler/dag, R2 10 GB, D1 5 GB). Lag en enkel bruksoversikt i Studio og varsle ved 80 %.

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

**Ikke i denne delen:** vannmerke i lyd, nedlasting av stems og kommentarer (Inner Circle får foreløpig bare nedlasting av hele låter som `.m4a`), offentlige lenker uten mottaker.

**Tester:** token-hash og utløp, enhetsgrense (robot-henting teller ikke, tredje enhet blokkeres), signerte segment-URL-er utløper og kan ikke gjenbrukes på annen invitasjon, tilbaketrekking virker midt i avspilling, `og:`-taggene, idempotent opplasting, opprydding i R2, og at `/d/*` aldri gir tilgang til noe fra PC-en. Bruk `wrangler dev` lokalt og en ende-til-ende-test i hodeløs Edge.

**Ferdig når:** Knut lager en drop med tre låter fra en spilleliste på mobilen, sender lenken på WhatsApp til en annen telefon, forhåndsvisningen viser cover og tittel, låtene spiller på den andre telefonen uten noe ekstra, og Command Center viser at de er spilt.

## Ikke gjør nå

- **Volum på iPhone:** kan ikke fikses i en nettside (iOS ignorerer `audio.volume`). Først mulig i en native iPhone-app. Bare dokumenter det. (Android-appen i del 12 løser det for Android.)
- Tauri, iPhone-app og vannmerke i lyd: egne faser.
- Ikke last opp musikk til skyen utenom del 13, og der bare låter som ligger i en drop. Supabase brukes bare til innlogging og posisjoner (del 5).

## Avslutning

Oppdater README (oppsett på Windows, desktop-app, LAN-modus, markør-editor, analyse-treffrate, ytelsestall), commit per del med beskrivende meldinger på egen gren, spør før push, og gi Knut en kort oppsummering: hva som virker, hva som er målt, og hva som gjenstår.
