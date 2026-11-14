# Framdrift – Groovehouse Vault

Arbeidslogg for `setup/del-0` (alt pushes hit, ingenting merges til `main`). Les denne først hvis arbeidet blir avbrutt.
Detaljert status og testbevis står i `status_bundle.txt`. Spørsmål til Knut står i `docs/OPEN_QUESTIONS.md`.

**Rekkefølge (Knut, 2026-11-14):** 9 → 11 → 12 → 10 → 1 pkt. 7–8 → 8 → 2 → 4 → 3. Del 5 (Supabase) hoppes over (ingen nøkler i `.env`).

**Faste regler:** REASONDONE kun lesing · ingen hemmeligheter/PIN/Tailscale-adresse i git (`git grep -i "ts.net"` før push) · aldri Funnel · ingen musikk til skyen · ingen admin/brannmur · ikke essentia.js.

## Status

| Del | Status | Testet | Gjenstår / Knut må teste |
|---|---|---|---|
| 9 Spillelister | ✅ ferdig | 97 enhetstester, «Ferdig når» mot ekte server, 31/31 UI-sjekker i hodeløs Edge (desktop + mobil) | Fysisk telefon; avspilling av eldre låst versjon (ingen låt har >1 versjon ennå) |
| 11 «⋯»-meny | ✅ ferdig | 103 enhetstester (ny: kø), 29/29 UI-sjekker i hodeløs Edge (mobil + desktop), del 9-UI 31/31 på nytt | «Del…» slås på i del 10. Fysisk telefon: hold inne på minispilleren, sveip høyre/venstre |
| 12 Android-app | ✅ bygget (ikke kjørt på telefon) | 114 enhetstester (motor-kontrakt 7, paring/token/CORS 4), signert APK bygget, CORS/paring/401 verifisert live over Tailscale | Hele «Ferdig når» på S22: installer, koble til, skjerm av 15 min, låseskjerm, Bluetooth i bil. Ingen emulator på PC-en |
| 10 Del låt som fil | ✅ ferdig (web), app bygget | 5 ffmpeg-tester (FLAC bit-for-bit, AAC 256k, tags, cover, cache, WAV-lyd identisk, /drop/ 403), 4 tekst/filnavn-tester, ekte server via Tailscale (ffprobe), UI 13/13; del 9 og 11 på nytt 31/29 | «Ferdig når»: del til deg selv på WhatsApp fra mobilen (Tailscale) og på e-post fra desktop-appen. Del i Android-appen (ikke kjørt). Om navigator.share med filer virker i Edge --app-vinduet |
| 1 pkt. 7–8 Autostart + varsel | ✅ ferdig | Oppgaven laget uten admin; server stoppet → oppgaven startet → server oppe, ingen vindu (LastTaskResult 0); AUMID satt og lest tilbake; varsel vist (exit 0); 2 enhetstester for tekst/injeksjon | «Ferdig når»: start PC-en på nytt, og bounce noe nytt fra Reason – varselet skal komme av seg selv |
| 8 Innstillinger | ✅ ferdig | 11 nye enhetstester (validering, atomisk lagring + backup, regler, copyright-mal, forskyvning, manuell palett overlever ny ingest, offset flytter markører) + 1 i web (LUFS-mål); UI i hodeløs Edge 22/22 (alle seksjoner, lagre LUFS −12 → API → tilbake −14, ugyldig mappe avvises, kontrast rød under minimum, mobil uten sidescroll); API: ugyldig LUFS 400, Wi-Fi-endring via Tailscale 403 | «Ferdig når»: endre eksportmappe, LUFS-mål, standard artist/label og farge på én låt i Studio, start PC-en på nytt og bounce på nytt – alt skal stå seg |
| 2 Markør-editor | 🔨 neste | – | – |
| 4 Raskere ingest | ⏳ | – | – |
| 3 Analyse (uten fasit) | ⏳ | – | Fasit i `fixtures/truth.json` |
| 5 Supabase | ⏭ hoppet over | – | Krever Supabase-prosjekt og nøkler i `.env` |

## Del 11 – «⋯»-meny (plan)

Knuts svar gjelder: «Del…» vises deaktivert («kommer») til del 10 · «Kildefil» fra `data/sources.json` (gitignored, bare Info og Studio, aldri i deling/metadata/drop) · «Legg til i spilleliste» øverst · sveip til høyre på en rad i katalogen (mobil) = legg til i sist brukte liste, med angre.

1. ✅ Kildefil: ingest skriver `data/sources.json`; `gh-ingest --index-sources` koblet 24 eksisterende låter fra REASONDONE via hash (kun lesing). `GET /api/sources/...` (403 fra `/drop/`).
2. Kø i `@gv/shared` (`insertNext`, `enqueue`, `remove`, `move`) + spiller-storen, lagret i localStorage, gjenopprettes pauset. Liste-«Fortsett» overlever køendringer.
3. `TrackActions`: én komponent (ark på mobil, kontekstmeny på desktop): spilleliste · Del… (deaktivert) · spill neste / legg i kø / vis køen · bytt variant · velg versjon · gå til seksjon · info (med Kildefil) · åpne i Studio. Brukt på rader, fullskjerm, minispiller (hold inne), dokken (⋯ + høyreklikk på cover), Shift+F10/menytast.
4. Køvisning med dra/sveip (felles hook med spillelistene).
5. Studio: `#arkiv/<slug>` og Kildefil i arkivet.
6. Tester: kø (enhet), UI i hodeløs Edge.

**Del 11 ferdig:** alle punkter over er bygget. UI-test (29/29): menyrekkefølge med «Legg til i spilleliste» øverst, «Del…» deaktivert, ≥ 48 px på mobil, Info med Kildefil, «Ferdig når» (legg til i liste fra fullskjerm uten å forlate den), spill neste/legg i kø, køvisning med sveip, sveip høyre i katalogen, køen gjenopprettet pauset etter ny innlasting, høyreklikk og Shift+F10 på desktop, Studio `#arkiv/<slug>` med Kildefil. Funn som er rettet underveis: klikket etter langt trykk på minispilleren traff et valg i arket som gled opp.

## Del 12 – Android-app (plan)

1. Verktøy (forhåndsgodkjent): Microsoft OpenJDK 21 og Android SDK-kommandolinjeverktøy via winget, SDK i `%LOCALAPPDATA%\Android\Sdk`, Gradle via wrapper.
2. Capacitor i `apps/android`, som pakker `apps/web/dist`. `applicationId` `no.groovehouse.vault`.
3. Kotlin-plugin `NativePlayer` med Media3 (ExoPlayer + HLS + MediaSessionService): varsel med cover, låseskjerm, Bluetooth, lydfokus, «Neste seksjon».
4. `PlayerEngine` i spiller-storen: `HtmlAudioEngine` (web) og `NativeEngine` (Android). Den native spilleren eier køen i bakgrunnen.
5. Tilkobling: «Koble til Vault» (adresse + PIN → enhetstoken i Android Keystore). Serveren godtar `Authorization: Bearer`, CORS bare for `https://localhost`, og enheter kan trekkes tilbake.
6. Ikon fra `assets/brand/`, mørk oppstartsskjerm, minimale tillatelser, keystore i `%APPDATA%\GroovehouseVault\android\` med passord i Credential Manager.
7. `pnpm android:build` / `android:install`. APK i `dist/android/`.

**Del 12 bygget:** Capacitor 8.6.2 i `apps/android`, Kotlin + Media3 1.11.1 (`PlaybackService`, `NativePlayerPlugin`, `VaultAuthPlugin`), `PlayerEngine` med HTML- og native motor, enhetstoken + paring med PIN + CORS bare for `https://localhost`, «Koble til Vault», «Får ikke kontakt», tilbake-knapp, ikoner fra ikonpakken, mørk oppstart, signert APK via `pnpm android:build` (keystore i `%APPDATA%`, passord i Credential Manager). JDK 21 og SDK var allerede installert – ingenting nytt installert. **Ikke testet på enhet** (ingen telefon tilkoblet, ingen emulator).

**Del 10 ferdig:** Vaults egen master (`master.flac`) lages ved ingest; 25 eksisterende låter fylt inn fra REASONDONE (kun lesing, hash sjekket) og 3 fixtures via ny ingest. `media/` gikk fra 214 MB til ca. 0,75 GB. Delte filer i `share/` (aldri via /media). «Del…» i menyen, to-stegs ark, Vis i Utforsker bare fra PC-en, logg i `data/shares.json`, «Delt N ganger» i Studio. Appen deler via Filesystem + Share, og FileProvider er begrenset til appens cache.

**Del 1 pkt. 7–8 ferdig:** planlagt oppgave «Groovehouse Vault» (AtLogOn, bare Knut, uten admin) som kjører `launcher.vbs /bakgrunn`; varsel via WinRT i Windows PowerShell (ingen ny npm-pakke) med AUMID på Startmeny-snarveien. Funn: AUMID via filsti-egenskapslager ble ikke lagret, og «-Command -» kjørte ikke Add-Type pålitelig – løst med ShellLink + IPersistFile i en midlertidig .ps1.

## Del 8 – Innstillinger i Studio (plan)

1. Config: nye seksjoner `audio` (målnivå −14 LUFS, −16…−11), `ingest` (sett-grense 20 min, filnavnregler → type/variant), `colors` (min. kontrast 4.5, ≥ 3; gull for fargeløse cover), `drops` (lagres nå, ingen effekt). Validering før lagring, atomisk skriving + `groovehouse.config.backup.json`. Eksportmappa lagres i `groovehouse.local.json` (maskinspesifikk sti, ikke i git).
2. Brukes av ingest (sett-grense, regler, LUFS-mål, kontrast/gull). LUFS-målet gjelder avspilling med en gang (klienten regner demping fra målt LUFS). Farger: «Bruk på alle låter nå» regner paletten på nytt fra lagret cover.
3. Per låt (Studio → Arkiv): fargeoverstyring (primary/secondary, kontrast mot #07080B, tilbakestill) og live-sett-forskyvning (±10 s, 50 ms) i `meta.json`; overlever ny ingest.
4. API `/api/settings` (bare fra PC-en eller egne enheter, aldri /drop/): les/lagre, eksportmappe med validering og varsel ved mange filer, watcher-status og omstart, Wi-Fi av/på og ny PIN, Tailscale-status med QR, enheter, omstart av serveren.
5. Side `/studio/innstillinger`.
6. Tester: validering, atomisk skriving, manuell palett overlever ny ingest, forskyvning flytter markørene.

**Endret etter ønske fra Knut (2026-11-14):** i katalogen på mobil er sveip høyre = legg i køen, sveip venstre = legg til i sist brukte spilleliste (begge med angre). Erstatter «sveip høyre = sist brukte liste» fra del 11.

**Ikonpakke for spillelister (2026-11-14):** de ti ikonene fra Knut kan velges per liste («⋯ → Ikon …»), lagres som `icon` på lista (validert mot kjente id-er). Rekkefølge: eget cover → ikon → mosaikk. UI-test 9/9.

## Logg

- 2026-11-14: Del 9 ferdig (bcdb20b). Del 11 påbegynt: kildefil (5e7c426). Main (7862d80) merget inn.
- 2026-11-14 02:56: `Out of Control.wav` ble skrevet av Reason under kildefil-skanningen (EBUSY, hoppet over). Ny bounce, ikke endret av Vault.
- 2026-11-14: Del 11 ferdig (UI 29/29, del 9 31/31 på nytt). «Out of Control» (ny bounce) ingestet av watcheren og koblet til kildefil.
- 2026-11-14: Del 12 bygget (APK 7,3 MB, signert). Keystore laget i %APPDATA%GroovehouseVaultandroidelease.jks.
- 2026-11-14: Del 10 ferdig. Master-kopier for 28 versjoner. APK bygget på nytt (7,4 MB) med Filesystem/Share.
- 2026-11-14: Del 1 pkt. 7–8 ferdig. Planlagt oppgave og AUMID installert via vault:install. To testvarsler vist på skjermen.
- 2026-11-14: Del 8 backend-del committet (ikke UI/ruter ennå). Brukskvoten nådd – fortsett fra «Gjenstår» i tabellen.
- 2026-11-14: Del 8 ferdig. Tailscale-navnet byttet til «groovehouse» (lagt i groovehouse.local.json ved siden av det gamle, Serve peker på 127.0.0.1:41733, /api/health svarer 200).
