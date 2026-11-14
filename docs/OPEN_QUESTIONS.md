# Åpne spørsmål til Knut

Valg som er lette å gjøre om, er tatt (det tryggeste) og står under «Valgt». Det som ikke er lett å gjøre om, står under «Venter på svar» – den delen er hoppet over til du svarer.

## Venter på svar

_(ingen ennå)_

## Valgt (kan endres)

1. **Master som FLAC (del 10):** Vault lagrer en tapsfri kopi som `media/<slug>/<variant>/v<N>/master.flac`. Alle 25 filer i REASONDONE er 16-bit/44,1 kHz PCM, så FLAC er bit-for-bit lik lyden. «Original WAV» lages fra FLAC-en: samme samples, men ikke byte-identisk fil (header/ekstra chunks skrives på nytt). Er en framtidig eksport 32-bit flyttall (FLAC tåler ikke det), lagres den som WAV i stedet.
2. **Enhetstoken er et ekstra lag (del 12):** over Tailscale slipper appen inn på Tailscale-identiteten alene, som nettleseren. Tokenet godtas også, kan trekkes tilbake (da sier appen fra), og kreves ved paring med PIN. Vil du at appen *må* ha gyldig token selv via Tailscale, er det én linje i `server.ts`.
3. **Tillatelser i APK-en (del 12):** spesifikasjonen sier bare INTERNET, FOREGROUND_SERVICE(_MEDIA_PLAYBACK) og POST_NOTIFICATIONS. Media3/AndroidX legger selv til `ACCESS_NETWORK_STATE`, `WAKE_LOCK` og en intern AndroidX-tillatelse (ingen av dem gir dialog). Jeg har latt dem stå, fordi fjerning kan få Media3 til å krasje og ikke kan testes uten telefon. `WAKE_LOCK` hjelper dessuten avspilling med skjermen av. Si fra om de skal fjernes.
4. **QR-paring (del 12, valgfritt):** ikke bygget. Paring skjer med adresse + PIN.
5. **Fixtures uten kildefil:** `blue-fire` og `live-sett-demo` kommer fra `fixtures/`, ikke REASONDONE, og har derfor ingen «Kildefil».
6. **Reservecover ved deling (del 10):** låter uten eget cover får et generert cover i den delte fila (merket, gullring, tittel). Det brukes bare i delte filer, ikke i spilleren. Vil du heller dele uten cover, er det én linje.
7. **«Original WAV» fra FLAC (del 10):** lyden er identisk sample for sample (testet med MD5 av dekodet lyd), men fila er ikke byte-identisk med originalen (header skrives på nytt, ingen BWF/markør-chunks fra Reason).
8. **Del 8 – Wi-Fi-modus og PIN bare fra PC-en.** Spesifikasjonen tillater skriving fra egne enheter, men en mobil som slår av Wi-Fi-modus eller bytter PIN kan låse seg selv ute. Resten av innstillingene kan endres fra alle egne enheter. Si fra om mobilen også skal kunne endre tilgang.
9. **Del 8 – Tailscale av/på i Studio.** Bare status og QR vises; av/på gjøres fortsatt med `pnpm vault:remote on|off` (kjører tailscale-kommandoer). Lett å legge til.
10. **Del 8 – brannmurregel.** Studio kan ikke lage brannmurregelen for Wi-Fi-modus (krever administrator) – den sier fra og viser kommandoen.
11. **Gammelt Tailscale-navn.** Står fortsatt i allowedHosts som du ba om, men svarer ikke lenger (Tailscale har byttet navnet). Fjern det når du vil: si fra, eller rediger groovehouse.local.json.
12. **⚠ Google Drive ser ut til å synkronisere prosjektmappa, også `media/` (oppdaget 2026-11-14, del 14).** `GoogleDriveFS.exe` kjører, og `F:\prosjekter_MAIN\.tmp.driveupload` har 82 272 filer (34 GB). En av filene i `media/` (`soul-purpose/.../analysis.json`) var hardlenket dit, altså i Drive sin opplastingskø. Hvis `F:\prosjekter_MAIN` (eller `GroovehousePlayer`) er en synkronisert mappe i Google Drive, havner musikken (HLS, `master.flac`, preview) i skyen, mot regelen «ingen musikk til skyen». Jeg har **ikke** endret noe i Drive eller i `.tmp.driveupload`. Forslag: i Google Drive → Innstillinger → Mappe fra datamaskinen, fjern `F:\prosjekter_MAIN` (eller i det minste `GroovehousePlayer`) fra synkroniseringen. Vault håndterer nå låste filer ved å bytte ut bare oppføringen i `media/`.
13. **Del 14 – spekteret som egen fil.** `spectrum48` lagres som rå Uint8 i `spectrum48.bin` ved siden av `analysis.json` (referert fra `analysis.spectrum48`), ikke som base64 inni JSON-en. Samme data, men et 2-timers sett ville ellers gjort `analysis.json` ca. 9 MB som lastes for hver bølgeform. Lett å snu hvis du heller vil ha alt i én fil.
14. **Del 14 – gull-reserven for låter uten fargerikt cover.** «Gull bare i logoen» er gjennomført i alle rammer og kontroller. Men README sier fortsatt «Fargeløst cover → gull», og innstillingen `colors.goldFallback` står på. Låter uten cover eller med fargeløst cover (f.eks. «Late Night») får derfor gull som *palett*, og da blir glød og knapper gull mens de spilles. Vil du heller ha nøytral sølv for slike låter, slå av «Fargeløse cover får gull» i Studio → Innstillinger → Farger (og «Bruk på alle låter nå»). Jeg har ikke endret standarden.
