# Groovehouse Vault – fase 1

Privat lytterom og arkiv for Groovehouse Records. Fase 1 kjører helt lokalt: ingest-motoren lager ferdige filer på disk, og web-appen spiller dem.

```
apps/web            Drop-side (lytter) + Command Center (admin) – Vite, React, TS, Tailwind, Zustand
apps/server         Startfila: web-app + /media + /api på 127.0.0.1, watcher i samme prosess, launcher
packages/ingest     gh-ingest (CLI) + gh-watch (watcher) + make-fixtures + media/API-moduler
assets/brand/       ikonpakke (Windows, Web, Android, iOS)
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

## Desktop-app: «Groovehouse Vault» på skrivebordet

```powershell
pnpm vault:install     # bygger web-appen, lager launcher, ikon og snarveier
pnpm vault:uninstall   # stopper serveren og fjerner alt igjen (spør om loggene skal beholdes)
pnpm vault:server      # serveren i forgrunnen (feilsøking)
```

- **Dobbeltklikk** på «Groovehouse Vault» (skrivebordet eller Startmenyen – fest den derfra til oppgavelinja). Launcheren spør `GET /api/health`. Kjører ikke serveren, startes den usynlig, og spilleren åpnes i eget vindu (Edge `--app`, Chrome som reserve). Kjører den allerede, åpnes bare et nytt vindu.
- **Porter** står i `groovehouse.config.json`: server `41733`, dev `41734`. Alt binder kun til `127.0.0.1`, og serveren avviser forespørsler med fremmed `Host` (DNS-rebinding). Er serverporten opptatt eller reservert av Windows, prøves de neste 10 (dev-porten hoppes over), og valgt port skrives til `%LOCALAPPDATA%\GroovehouseVault\port`. Launcheren åpner aldri et annet program som svarer på porten – får den ikke startet Vault, sier den tydelig fra.
- **Watcheren** kjører i serverprosessen mot `GH_EXPORT_DIR` (leser bare).
- **Utenfor prosjektmappa** lages bare: snarvei på skrivebordet, snarvei i Startmenyen og `%LOCALAPPDATA%\GroovehouseVault\` (`launcher.vbs`, `groovehouse.ico`, `port`, `install.json`, `logs\server.log` med rotering på 2 MB × 5).
- **Ikon:** `assets/brand/Windows/Groovehouse_Vault_IconPack.ico` på snarveiene. App-vinduet får Groovehouse-ikonet på oppgavelinja (fra favicon), ikke Edge-ikonet.
- **Tauri** er ikke med nå: Edge-app-vindu gir samme opplevelse uten Rust-bygg. Tauri er neste steg hvis du vil ha automix med Web Audio på desktop.

### Autostart og varsel

- **Autostart ved pålogging:** `vault:install` lager en planlagt oppgave, «Groovehouse Vault» i Oppgaveplanlegging. Den gjelder bare din bruker og krever ikke administrator. Oppgaven kjører `launcher.vbs /bakgrunn`, som starter serveren og watcheren uten vindu og uten feilbokser (feil havner i loggen). `pnpm vault:autostart on|off|status`. `vault:uninstall` fjerner oppgaven.
- **Varsel når en ny bounce er klar:** «Would You Run (Extended) er klar – 125 BPM · 8A». Startmeny-snarveien får en AppUserModelID (`GroovehouseRecords.Vault`), så varselet vises med «Groovehouse Vault» som avsender. `pnpm vault:autostart test-varsel` sender et testvarsel. «Ikke forstyrr» i Windows demper varslene som vanlig.

## Innstillinger i Studio (`/studio/innstillinger`)

- **Eksport og watcher:** eksportmappa (sjekkes: finnes, kan leses, antall lydfiler), watcher-status (kjører, i kø, siste hendelse) og omstart. Mappa lagres i `groovehouse.local.json` (bare denne PC-en) og vinner over `GH_EXPORT_DIR`. Mange filer i en ny mappe importeres ikke automatisk – bruk `pnpm gh-ingest --backlog`.
- **Kategorisering:** grense for live-sett (standard 20 min) og filnavnregler med `*` (f.eks. `* (Live *)` → sett, `*Club*` → variant `club`), med forhåndsvisning på filene i eksportmappa.
- **Lyd:** målnivå −16 til −11 LUFS (standard −14). Spilleren demper bare, løfter aldri. Gjelder med en gang, også for låter som alt er ingestet.
- **Metadata:** standard artist, label, copyright-mal (`℗ {år} {label}`) og ord som fjernes fra titler, med forhåndsvisning.
- **Farger:** minste kontrast (3–7, standard 4.5:1) og om fargeløse cover skal få standardfargen grønn (`#06B211`). «Bruk på alle låter nå» regner ut fargene på nytt fra lagret cover (låter med egen farge røres ikke).
- **Tilgang:** Wi-Fi-modus av/på og ny PIN (bare fra PC-en), Tailscale-status med QR. PIN og hasher vises aldri.
- **Drops:** standarder lagres. «⋯ → Del…» kan lage en lyttelenke når `LISTEN_ADMIN_URL` og `LISTEN_ADMIN_TOKEN` er satt (se under). Uten det svarer serveren at tjenesten ikke er koblet til.
- **Per låt (Arkiv → Rediger):** egen primær-/sekundærfarge med kontrastmåling og forhåndsvisning, og for live-sett en forskyvning (±10 s, steg 50 ms) med «spill fra markør». Lagres i `media/<slug>/meta.json` og overlever ny ingest.
- Lagring valideres først, `groovehouse.config.json` skrives atomisk og forrige versjon ligger i `groovehouse.config.backup.json` (ikke i git). Lyttelenker (`/drop/…`) har aldri tilgang.

## Mobilen på samme Wi-Fi (LAN-modus)

> **Kun hjemme.** Dette er vanlig HTTP på lokalnettet: PIN og lyd går ukryptert over Wi-Fi-en. Ikke bruk det på offentlige nett, og ikke for partnere – partnerlenker kommer med R2 og invitasjonstokens i en egen fase.

```powershell
pnpm vault:lan on       # første gang: velg PIN (6–12 sifre), og svar på om brannmurregelen skal lages
pnpm vault:lan status   # PIN satt? brannmurregel? nettverksprofil? adresser
pnpm vault:lan pin      # ny PIN – alle mobiler må taste den på nytt
pnpm vault:lan off      # tilbake til kun denne PC-en, alle mobiler logges ut
```

- **Av som standard.** `on/off` lagres i `groovehouse.config.json` (`lan.enabled`) og overlever omstart. En kjørende server startes på nytt automatisk.
- **PIN** lagres bare som scrypt-hash i Windows Credential Manager (`GroovehouseVault/lan-pin`), aldri i klartekst og aldri i git. Etter riktig PIN får mobilen en signert, httpOnly informasjonskapsel som varer i 30 dager. Ny PIN eller `lan off` bytter signeringsnøkkelen, og da er alle mobiler logget ut. Maks 5 feil per enhet per 15 min (og 20 totalt per time).
- **Hva som slipper inn:** PC-en selv (127.0.0.1) som før, uten PIN – snarveien virker uendret. Fra nettverket bare private adresser (10.x, 172.16–31.x, 192.168.x), bare mot PC-ens egen IP, og bare med gyldig PIN-informasjonskapsel. Uten den vises bare PIN-siden; ingen app-kode eller musikk.
- **Brannmur:** `vault:lan on` spør før regelen lages. Regelen «Groovehouse Vault (LAN)» slipper inn TCP på serverportene, bare for Node, bare fra lokalt subnett og **bare på nettverksprofilen «Privat»**. Windows ber om administratortilgang. Står hjemmenettet som «Offentlig», må du endre det i Innstillinger → Nettverk og Internett → Wi-Fi → (nettverket) → Nettverksprofil: Privat.
- **QR-kode:** Studio → Mobil (`/studio#mobil`). Adressen er IP-en på kortet med standard gateway (hjemmenettet), ikke virtuelle kort som VirtualBox/WSL.
- **VPN:** er NordVPN e.l. slått på, kan den stenge for trafikk på lokalnettet. Slå på «LAN-synlighet»/«Invisibility on LAN: av» i VPN-appen hvis mobilen ikke når PC-en.
- **Låst skjerm:** spilleren bruker `<audio>` + Media Session (ingen Web Audio), så lyden fortsetter med skjermen låst, og låseskjermen har spill/pause/neste/spoling. På iPhone styres volumet med knappene på telefonen.

## Mobilen hjemmefra (Tailscale Serve)

Med [Tailscale](https://tailscale.com) på PC-en og mobilen når du spilleren over HTTPS fra hvor som helst, men bare fra dine egne enheter i tailnettet.

```powershell
pnpm vault:remote on      # tailscale serve (HTTPS 443, kun tailnettet) → 127.0.0.1:<serverport>, og ts.net-navnet i allowedHosts
pnpm vault:remote status  # Serve-oppsett, allowedHosts, Funnel-advarsel og helse-sjekk via ts.net
pnpm vault:remote off     # fjerner Serve på 443 og navnet fra allowedHosts
```

- **Adresse:** `https://<pc-navn>.<tailnet>.ts.net/`, med ekte sertifikat fra Tailscale. Mobilen må ha Tailscale-appen på og være logget inn på samme konto. `pnpm vault:remote status` viser adressen.
- **Lokal config:** navnet lagres i `groovehouse.local.json` (står i `.gitignore`), ikke i `groovehouse.config.json`. Den lokale fila leses i tillegg til den delte, og kan også overstyre andre seksjoner for denne PC-en (f.eks. `lan`). PC-navn og tailnet-ID havner derfor aldri i git.
- **Ingen PIN:** Serve proxyer fra PC-en selv, så forespørselen kommer fra 127.0.0.1. Serveren godtar den uten PIN bare når `Host` står **eksakt** i `allowedHosts` (ingen jokertegn, så ikke `*.ts.net`) **og** Tailscale har satt `Tailscale-User-Login`. Den headeren setter Serve bare for innloggede enheter i tailnettet. Funnel-trafikk fra internett har den ikke og får 403. Et annet navn gir 421, og ts.net-navnet sendt fra en enhet på Wi-Fi gir også 421, så PIN gjelder fortsatt der.
- **PC-en må være på** og serveren kjøre for at mobilen skal nå musikken. Tailscale lagrer ingenting selv.
- **Funnel slås aldri på** av `vault:remote`, og `status` advarer hvis det er på.
- **Uavhengig av LAN-modus:** serveren kan binde bare til 127.0.0.1, og Wi-Fi-modus kan være av.
- **Delte maskiner:** deler du PC-en med andre i tailnettet (Tailscale «Share»), når de også spilleren uten PIN.
- `vault:uninstall` rører ikke Tailscale-oppsettet, men minner deg på `vault:remote off`.

## Spillelister

Lagres av serveren på PC-en i `data/playlists.json` (gitignored, atomisk skriving, forrige versjon i `playlists.backup.json`). Mobil og desktop snakker med samme server, så listene er like overalt. De hentes på nytt når appen kommer i forgrunnen og hvert 10. sekund.

- **Mobil:** fanen **Lister** (i stedet for Søk, som ligger øverst til høyre). ⋯ på en låt eller i fullskjermspilleren → **Legg til i spilleliste** (3 sist brukte øverst, + Ny spilleliste). Hold inne på en låt i Katalog for velgemodus. I en liste: hold inne og dra for å flytte, sveip til venstre for å fjerne. Alt har «Angre».
- **Desktop:** listene i sidemenyen. Dra låter (Ctrl/Shift-klikk for flere) til en liste, eller høyreklikk → Legg til i spilleliste. `Ctrl+Shift+P` legger låta som spilles til i sist brukte liste. I lista: dra for å flytte, Delete fjerner, og variant kan låses per rad.
- **Oppføringer peker på slug + variant**, så en ny bounce (`_v4`) dukker opp i alle lister av seg selv. Per oppføring kan du velge **Følg nyeste** (standard), **Alltid <variant>** eller en **bestemt versjon** («Demo v3 · låst»): nedtrekkslista på desktop, ⋯ på raden på mobil. Eldre versjoner blir liggende i `media/<slug>/<variant>/vN` og i `media/index.json`, og hentes ved behov. Står en låst versjon ikke lenger der, vises raden som utilgjengelig med forklaring. I Studio → Arkiv har hver låt med flere versjoner en versjonsvelger.
- **Eget cover:** ⋯ → Eget cover … i lista. Bildet lagres i `data/playlist-covers/` (1200 px + 300 px, JPEG, uten EXIF/GPS), paletten hentes med samme kontrastlås som låtcoverne, og det forrige slettes. Uten eget cover vises mosaikken.
- **Smarte lister:** **Lagre som smart liste** i søket lagrer selve søket (`124 8A`, `sett`, `extended`) og oppdaterer seg selv. Innebygd: **Nylig lagt til** (14 dager) og **Live-sett**.
- **Farger:** hver liste får en farge fra `docs/design/playlist-colors.json` (40 farger, Neon og Candy), med neon-glød på prikken, «Spill»-knappen og aktiv liste i sidemenyen. Gløden puster med sub-bassen mens lista spilles (ikke ved «redusert bevegelse»). Coveret til låta som spilles styrer fortsatt rommet.
- **Samtidige endringer:** hver endring sendes med `updatedAt`. Er lista endret et annet sted, svarer serveren 409, og appen regner endringen ut på nytt mot den ferske lista i stedet for å overskrive.
- API: `GET/POST /api/playlists`, `PATCH/DELETE /api/playlists/:id`, `PUT/DELETE /api/playlists/:id/cover`, `GET /api/playlist-covers/:fil`. Samme tilgang som resten av appen (PC-en, Tailscale, eller Wi-Fi med PIN).

## Låtmeny («⋯») og køen

Én meny for alt du kan gjøre med en låt, med nøyaktig den versjonen og varianten som vises eller spilles. På mobil er den et ark nederfra, på desktop en kontekstmeny.

- **Hvor:** ⋯ på låtrader og i fullskjermspilleren, hold inne på minispilleren, ⋯ ved tittelen i dokken, høyreklikk på en rad eller på coveret i dokken, og **Shift+F10** eller menytasten.
- **Innhold:** Legg til i spilleliste · Del… (kommer i del 10) · Spill neste / Legg til i køen (rader) eller Vis køen (låta som spilles) · Bytt variant · Velg versjon · Gå til seksjon · Info · Åpne i Studio (desktop). I en spilleliste kommer også «Låsing i lista» og «Fjern fra lista».
- **Ikon for lista:** «⋯ → Ikon …» på en liste gir de ti Groovehouse-ikonene (Groovehouse House, Deep House, Tech House, Soulful / Vocals, Club Bangers, Night Drive, Chill / Lounge, Live DJ Sets, Favorites, Rooftop / Sunrise). Eget cover vinner over ikonet; uten noen av dem vises coverne til låtene. Kildefilene ligger i `assets/brand/Playlists/` (PNG 512 px og Windows-ICO); web-appen bruker webp-versjoner i `apps/web/public/playlist-icons/` (lages med `node apps/android/scripts/playlist-icons.mjs`).
- **Rask vei på mobil:** sveip til høyre på en rad i katalogen legger låta sist i køen, og sveip til venstre legger den i sist brukte spilleliste – begge med angre. (Uten noen liste ennå åpnes listevelgeren.)
- **Info → Kildefil:** originalfilnavnet fra eksportmappa. Det lagres privat i `data/sources.json` (gitignored) og vises bare i Info og i Studio, aldri i delte filer, tags eller noe lyttersiden ser. Låter som ble ingestet før dette, kobles med `pnpm gh-ingest --index-sources` (leser bare eksportmappa, matcher på hash).
- **Køen:** «Spill neste» setter låta rett etter den som spilles, «Legg til i køen» legger den bakerst. I køvisningen: hold inne og dra for å flytte (dra og slipp på desktop), sveip for å fjerne. Låta som spilles står fast. Køen lagres i nettleseren og legges tilbake pauset etter omstart. En ny liste eller låt fra katalogen erstatter køen som før.

## Del en låt som fil

**⋯ → Del…** på en låt (i lister, fullskjerm, dokken eller via høyreklikk) sender selve lydfila via delingsmenyen, til WhatsApp, e-post osv. Det trengs ingen sky, og ingen lenke peker tilbake til PC-en.

- **Tre valg:** **Hele låten** (AAC 256 kbps fra masteren, uten loudness-endring), **Smakebit 30 s** og **Original WAV** (tapsfri, for samarbeid). Arket viser omtrentlig størrelse og filnavnet: `Echo Groove - Tittel (Variant).m4a`.
- **To steg:** først hentes fila (med framdrift), så trykker du **Del nå**. Nettleseren krever at deling skjer direkte i et trykk.
- **Med fila følger:** tittel, artist «Echo Groove», album, `℗ <år> Groovehouse Records`, år og cover. Har låta ikke cover, lages et reservecover med merket og tittelen. Teksten er `Echo Groove – Tittel · Groovehouse Records`, uten URL, vertsnavn eller IP.
- **Vaults egen master:** `media/<slug>/<variant>/v<N>/master.flac` (tapsfri). Den lages ved ingest, så deling ikke avhenger av at fila fortsatt ligger i eksportmappa, og ingenting deles fra HLS. Eldre låter fylles inn med `pnpm gh-ingest --backfill-masters`. Den leser bare eksportmappa, og bare hvis fila har samme hash som da den ble ingestet. «Original WAV» lages fra FLAC-en (samme lyd sample for sample).
- **Nytt utseende «High-End Studio» (del 14):** Satoshi (UI) og JetBrains Mono (data), selvhostet i `apps/web/public/fonts/` med lisensene. Glasspaneler, neon-glød og alle aksenter fra coveret (`--accent`), gull bare i logoen. Desktop: sidemeny (Hjem, Bibliotek, Spillelister, Live-sett, DJ-verktøy, Analyse, Vault, Innstillinger), dekket øverst på Hjem og Bibliotek (cover-kort, Spilles nå med faner Spilles nå · Kø · Tekst · Kreditering, stor bølgeform med ms-tider, transport med bland/gjenta, volum, A·B-løkke, hastighet 0,90–1,10), høyre kolonne med Låtinfo, Bølgeform-zoom (±8 s, hjul/klyp 2–30 s, takt-rutenett) og Spektrum (Hz), og låttabellen (sorterbar BPM, toneart, LUFS, hjerte, «⋯»). 1024–1279 px: høyre kolonne blir faner.
- **Favoritter, tekst og egne avspillinger (del 14):** hjertet lagres i `data/favorites.json` og gir smartlista «Favoritter». Sangtekst i `data/lyrics/<slug>.lrc|.txt`, redigeres i Studio (Rediger på låta; Ctrl+Enter setter tidsstempel fra spillehodet mens låta spilles). Egne avspillinger logges i `data/listens.json` og vises under Analyse og «Nylig spilt» på Hjem. Samme tilgangsregler som spillelistene.
- **A·B-løkke:** knappen (A her → B her → av) eller dra i bølgeformen. Fester seg til takter; hold Shift for å slå det av. Hastigheten beholder tonehøyden og lagres ikke per låt.
- **Utkast (del 16):** umastrede låter holdes atskilt fra de release-klare.
  - **Status fra mappa:** eksportmappa (REASONDONE) gir release-klare. Utkastmappa (Studio → Innstillinger, lagres i `groovehouse.local.json`, undermapper tillatt) og «Importer som utkast» i Studio (`data/drafts-inbox/`) gir utkast. Begge mappene leses bare. Eldre filer tas inn med `pnpm gh-ingest --backlog --drafts`.
  - **Versjoner:** utkast får egne versjonsnumre (1000 + N, vist som «Utkast vN»), så de aldri kolliderer med master-versjonen av samme låt. Katalogen og «følg nyeste» velger release hvis den finnes, ellers nyeste utkast. Når en låt blir mastret, går lister og planer over til masteren. En låt bytter aldri status av seg selv; «Gjør release-klar …» i Studio krever bekreftelse.
  - **I spilleren:** Bibliotek, Hjem, Ctrl+K og DJ-verktøy viser bare release-klare som standard, med segmentet Release-klar · Utkast · Alle (huskes per visning). Utkast har UTKAST-brikke, stiplet cover og halv glød. Smarte lister bruker bare release-klare.
  - **Planer:** spillelister kan være Album-plan eller Sett-plan («⋯ → Gjør til …»), med «N av M mastret», total tid, BPM-/Camelot-flyt (grønn, gul, rød) og filteret «Mangler master». Legges et utkast i en vanlig liste, spør appen først.
  - **Lydnivå:** utkast får HLS normalisert med `loudnorm` i to passeringer (−1 dBTP). `master.flac` er uendret, og Låtinfo viser både målt og normalisert nivå.
  - **Deling:** krever «Del utkast likevel». Fila får « (Utkast)» i navn og tittel og albumet «Groovehouse Records – Demo».
- **Settbygger (del 17):** Live-sett → «Lag sett» (også i DJ-verktøy). Velg varighet (30/60/90/120 min eller fritt), kurve (Oppvarming, Peak time, Reise, Avslutning eller Egen med glidere), BPM-spenn, starttoneart, «Må være med» (eventuelt på fast plass) og «Utelat». Utkast er utelatt til du huker av «Ta med utkast».
  - **Reglene:** Camelot (samme, ±1, relativ dur/moll; +2 og +7 som energiløft), tempo innen ±3 % (opptil ±6 %, halv/dobbel teller som match), energikurven 1–10, mikspunkter på 8/16/32 takter fra ren intro/outro, variasjon (ikke samme toneart > 3 på rad), jevnt lydnivå, og Extended foretrekkes i sett på 30 min eller mer. Én versjon per låt.
  - **Søket:** kostnadsmatrise, beam search og simulert nedkjøling med fast frø (samme valg gir samme sett). Tre forslag: Tryggest harmonisk, Mest energi og Mest variasjon, med score per kriterium. 200 låter tar under 0,3 s.
  - **Resultatet:** hver overgang vises som «8A → 9A», relasjon, tempo i %, ut/inn-tid og antall takter, med grønn/gul/rød prikk. Energien tegnes mot målkurven. «Bytt ut» gir fem alternativer, piler flytter, og «Lås og bygg på nytt» beholder låste plasser.
  - **Lagre og eksportere:** «Lagre under Planlagte sett» lager en Sett-plan (del 16), holdt atskilt fra Innspilte sett. «rekordbox XML» har tempo, toneart og mikspunktene som hot cues (A = Mix inn, B = Mix ut) og memory cues; importer med Fil → Importer i rekordbox. «M3U» virker i de fleste spillere.
  - **Læring:** når du bytter ut låter, får kriteriene som ble bedre litt mer vekt (±4 % per bytte, 0,5×–2×). Overganger du har spilt i innspilte sett gir bonus. Loggen ligger i `data/setbuilder.json`; «Tilbakestill» tømmer den.
- **BPM og toneart (del 3):** `pnpm eval:analysis <mappe>` analyserer filene (bare lesing) og sammenligner den gamle og den nye metoden med fasiten i `fixtures/truth.json` (slug → `bpm`, `camelot`). `pnpm eval:analysis --synthetic` bruker en syntetisk house-samling med kjent fasit: akkorder over bass-pedal, kick og hi-hat, noen med halvtempo-kick, mye støy eller feilstemming opp til ±45 cent.
  - **Tempo (i bruk):** autokorrelasjon av bass-onset lest som en kam over 1, 2, 4 og 8 slag, i et rutenett på 0,05 BPM. Halv eller dobbel tempo velges i 118–132 når pulsen er tydelig. Sett får tempo per kapittel (`bpm` på kapittelmarkøren), og tempoendringer står i ingest-loggen.
  - **Toneart:** HPCP med 5-cent oppløsning (240 per oktav), bare harmoniske rammer (lav spektral flathet, ikke trommer), spektraltopper med harmonisk vekting (h = 1–4), tuning-estimat før folding, og EDMA-profilene til Faraldo et al. (2016). Den gamle Krumhansl-metoden er fortsatt standard (`analysis.keyMethod: "krumhansl"` i `groovehouse.config.json`) til fasiten avgjør. Sett `"edma"` for å bytte.
  - Essentia.js er ikke tatt inn (AGPL-3.0).

  | Treffrate (syntetisk, 16 filer) | Toneart | BPM ±0,5 |
  |---|---|---|
  | Før (Krumhansl, tempo 90–150) | 16/16 | 12/16 |
  | Nå (HPCP + tuning + EDMA; kam + house) | 16/16 | 16/16 |

  På de 26 ekte låtene i REASONDONE er metodene enige om BPM (stort sett innenfor ±1), men uenige om toneart på 10 låter, nesten alltid dur mot parallell eller relativ moll. Det avgjøres av fasiten.
- **Raskere ingest (del 4):** alt som bare leser masteren, kjører samtidig: analyse (med spektrum og format), LUFS, HLS, cover og master-kopi. Tempo, toneart, struktur og preview venter bare på analysen. Sett over 20 minutter viser fremdrift i prosent i terminalen og på ingest-kortet i Studio (`media/ingest-progress.json`, finnes bare mens det kjører). Mål selv med `pnpm ingest:bench` (bruker en midlertidig mediemappe, rører ikke `media/`).

  | Fil (i9-13900F, 32 kjerner) | Før (etter hverandre) | Etter (parallelt) |
  |---|---|---|
  | 10-minutters testfil (støy + tone, 44,1 kHz/16-bit) | 10,6 s | 6,4 s (−40 %) |
  | `fixtures/blue-fire` (2 varianter) | 8,5 s | 4,8 s (−44 %) |
  | `fixtures/live-sett-demo` | 5,5 s | 3,7 s (−33 %) |

  HLS-kodingen (AAC 256k, ca. 6 s for 10 minutter) setter nå grensen. Før var tiden summen av stegene.
- **Markør-editoren (del 2):** Studio → Arkiv → «Markører» på en låt. Dra markørene (fester seg til takt når BPM finnes, Alt = fritt), dobbeltklikk for ny, gi nytt navn, slett, godkjenn én eller «Godkjenn alle». Tastatur: ←/→ én takt, Shift = fire takter, Delete sletter, Enter godkjenner. Lagres i `markers.json` ved siden av `manifest.json`. Godkjente og manuelle markører og slettede forslag står seg ved `gh-ingest --force`. En ny versjon (`_v4`) får markørene fra forrige rettede versjon som ubekreftede forslag. Spilleren bruker de rettede markørene med en gang.
- **Oppdatering av Android-appen (del 15):** `pnpm android:release` bygger web-bunten til `data/app/bundle/`, bygger ny APK til `data/app/apk/` bare når den native koden er endret, og oppdaterer `data/app/manifest.json`. Hvert web-bygg (også `vault:install`) lager bunten automatisk. Appen sjekker ved oppstart og når den kommer i forgrunnen (`/api/app/...`, bare med enhetstoken). En ny bunt lastes ned, sjekkes med sha256 og brukes ved neste oppstart, aldri mens musikken spiller. Melder den ikke «klar» innen 10 s, ruller appen tilbake. Ny native kode gir banneret «Ny app-versjon – Oppdater». versionCode går aldri ned (teller i `%LOCALAPPDATA%\GroovehouseVaultndroiduild-counter`). Studio → Innstillinger → Enheter viser hva hver enhet kjører.
- **Skysynkronisering:** ligger prosjektmappa i en mappe som Google Drive, OneDrive, Dropbox, iCloud eller Box synkroniserer, sier serveren fra ved oppstart (logg og Windows-varsel), i `vault:install` og i Studio → Innstillinger. `media`, `data`, `.env` og `node_modules` skal ikke til skyen.
- **Spektrum og kildeformat (del 14):** ingest lager `spectrum48.bin` (48 log-bånd 20 Hz–20 kHz, 20 bilder/s, én byte per bånd, fra masteren i 44,1 kHz) og lagrer kildeformatet («WAV 24-bit / 48 kHz») i manifestet. Eldre versjoner fylles inn med `pnpm gh-ingest --backfill-analysis` (leser bare `master.flac` i `media/`, ingen ny HLS-koding).
- **Uten HTTPS** (Wi-Fi-modus over `http://10.0.0.47`) finnes ikke delingsmenyen. Da lastes fila ned i stedet. På PC-en finnes også **Vis i Utforsker**, som bare virker fra PC-en selv.
- **Cache:** delte filer caches i `.../v<N>/share/` og lages på nytt når master, cover eller metadata endres. De serveres bare via `/api/share`, aldri via `/media`, og aldri til lyttersiden.
- **Logg:** delinger logges lokalt i `data/shares.json` (låt, versjon og type, aldri mottaker), og Studio → Arkiv viser «Delt N ganger».
- **I appen:** fila skrives til appens cache og deles med Androids delingsmeny.

## Android-app (APK)

Samme spiller som på web, pakket med Capacitor (`apps/android`), men avspillingen eies av en Android-tjeneste med **Media3/ExoPlayer**. Musikken fortsetter med skjermen av og i andre apper, og styres fra varselet, låseskjermen, Bluetooth og bilen. Varselet har også **Neste seksjon**. Neste låt i køen starter selv om appen sover.

```powershell
pnpm android:build     # web-bygg → Capacitor → signert APK i dist\android\
pnpm android:install   # installerer via adb (USB-feilsøking på)
```

- **Koble til:** første gang skriver du Vault-adressen (Tailscale, bare HTTPS) og PIN-en (den samme som for Wi-Fi-modus). Appen får et **enhetstoken**. Det og adressen lagres kryptert med Android Keystore. Adressen ligger aldri i koden eller i git, og byggeskriptet stopper hvis den finnes i bygget.
- **Tilgang på serveren:** Tailscale-identiteten holder som før. Tokenet er et ekstra lag. Enheter står i `data/devices.json` (bare hash av tokenet). Liste: `GET /api/devices`. Trekk tilbake: `DELETE /api/devices/<id>`, og da må appen kobles til på nytt. CORS gis bare til appen (`https://localhost`).
- **Er PC-en av:** «Får ikke kontakt med Vault på PC-en» med «Prøv igjen».
- **Tilbake-knappen** lukker ark, menyer og fullskjerm først. Går du ut av appen, fortsetter musikken.
- **Signering:** `%APPDATA%\GroovehouseVault\android\release.jks`, med passordet i Windows Credential Manager (`GroovehouseVault/android-keystore`). **Ta backup av begge.** Samme nøkkel må brukes for alle oppdateringer, ellers må appen avinstalleres først.
- **Samsung:** sett appen til «Ubegrenset» under Innstillinger → Apper → Groovehouse Vault → Batteri, ellers kan batterisparingen stoppe avspillingen.
- **USB-feilsøking (S22):** Innstillinger → Om telefonen → Programvareinformasjon → trykk 7 ganger på «Versjonsnummer». Så Utvikleralternativer → «USB-feilsøking», koble til og trykk «Tillat».

## Prøv hele kjeden

```powershell
pnpm make-fixtures                      # lager fixtures/blue-fire og fixtures/live-sett-demo
pnpm gh-ingest fixtures/blue-fire       # HLS, bølgeform, LUFS, preview, palett → media/
pnpm gh-ingest fixtures/live-sett-demo  # sett: kapitler fra live_log.json, justert etter sync-klikket
pnpm dev                                # http://127.0.0.1:41734 (porter i groovehouse.config.json)
```

- **Din spiller:** <http://127.0.0.1:41734/> (mobil og desktop – prøv å gjøre vinduet smalt)
- **Studio / Command Center:** <http://127.0.0.1:41734/studio>
- **Drop-siden (det lytteren ser):** <http://127.0.0.1:41734/drop/blue-fire-pitch?r=Jorrit>

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
    cover.png                         ← valgfri, men uten cover blir paletten standardfargen grønn
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

Filene havner i `media/<slug>/<variant eller main>/v<N>/` og serveres under `/media/...`. `media/index.json` er katalogen web-appen leser. `apps/web/public/` er vanlig public (ikoner, manifest).

### Analysen – hva den kan og ikke kan

- **BPM:** autokorrelasjon av basstransientene, 90–150 BPM, med preferanse for 115–135 ved oktavtvil. Treffer innen ±0,2 BPM på testfilene. Stigende/fallende tempo i et sett gir ett snitt.
- **Toneart:** Krumhansl–Schmuckler på kromagram (150 Hz–5 kHz). Sikkerheten vises i terminalen – lav sikkerhet betyr «sjekk med øret». Overstyr med `camelot` i `meta.json`.
- **Struktur:** fra energikurven, snappet til takt. Alt merkes som forslag (`confirmed: false`). Godkjenning/flytting i Command Center kommer i neste runde.
- **Ytelse (målt i testmiljøet):** ~10 s for en 3-minutters låt, 28 s for 10 minutter. Et 2-timers sett blir da rundt 5–6 minutter. Alt skjer i ett strømmepass, uten å laste hele fila i minnet.

## Beslutninger som er bygget inn

- **Ingen Web Audio API.** Avspilling via `<audio>` (native HLS i Safari, hls.js lastes bare i andre nettlesere) + Media Session. Visualisering fra `analysis.json`.
- **Coveret styrer fargene, gull bare i logoen** (endret 2026-11-14, oppdatert 2026-11-15, se del 14 i CLAUDE_CODE_SETUP.md). Aksentfarger kommer kun fra `assets.palette` via CSS-variablene `--accent`, `--accent-2`, `--glow`. Paletten velger mest *levende* farge og løftes til ≥ 4.5:1 mot `#07080B`. Mangler cover eller er det fargeløst → standardfargen grønn `#06B211` / `#14E177`, også før noen låt er valgt. Gull brukes bare i logoen. Konfignøkkelen heter nå `colors.colorFallback` (den gamle `goldFallback` leses fortsatt).
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
- Drop-side: standardfargen grønn → coverfarger ved avspilling, spolbar bølgeform, DROP-markør, kapitler for sett, sporliste, vannmerke med navn, utløp og nedtelling
- Command Center: drops, ingest-kort med stegstatus, mottakertabell med lyttedekning beregnet fra lyttehendelser, lyttelogg, arkiv, live-sett, mini-spiller
- Databasemigrasjon validert mot Postgres 16
- 28 enhetstester (palett, navn/varianter, lyttedekning, deler/variantbytte, live-logg, tempo, toneart, struktur)

**Eksempeldata:** drops, mottakere og lyttehendelser ligger i `apps/web/src/lib/seed.ts` til Supabase kobles på. Mottakernavn i klammer er plassholdere.

**Fortsett på en annen enhet (del 5).** Posisjonen lagres fortsatt lokalt (`gv:pos:…`) og sendes til Vault-serveren (`PUT /api/playback`, filen `data/playback.json`). Nyeste tidsstempel vinner. Banneret «Fortsett her» vises når en annen enhet har en nyere posisjon, minst 10 sekunder inn i låten, og ikke bare noen sekunder unna der du allerede er. «Fortsett her» pauser den andre enheten i løpet av et par sekunder. Supabase-tabellen `playback_positions` er ikke koblet på.

**Lyttelenke (del 13).** «⋯ → Del… → Del lenke» poster til `/api/drops`. Serveren laster opp HLS, smakebit og cover til Workeren og logger bare id, tittel og mottaker i `data/drops.json` (aldri tokenet). Lenken er `https://listen.groovehouserecords.com/d/…`. Mottakeren trenger ikke Tailscale. Koden ligger i `packages/shared/src/listen.ts` og `apps/listen-worker`. Den er ikke publisert: `wrangler login` åpner nettleseren og skal bare kjøres når du sier ja. Sett deretter `LISTEN_ADMIN_URL` og token (miljø eller Credential Manager, navn `listen-admin`).

**Gjenstår**
- Fasit for BPM og toneart i `fixtures/truth.json` (del 3). Metoden er fortsatt Krumhansl.
- Legge ut lytter-Workeren (D1, R2, ruten `listen.groovehouserecords.com`) etter `wrangler login`
- Supabase-klient i web er ikke koblet på. Innlogging med magic link krever et Supabase-prosjekt.
- Vannmerke i selve lyden, klipp-eksport, katalogmatching for sett
- Tauri (desktop) og Capacitor (iPhone, med native bakgrunnslyd)
- Forenklet logo som SVG for ikoner og favicon
