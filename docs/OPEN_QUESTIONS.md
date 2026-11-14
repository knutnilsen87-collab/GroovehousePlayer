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
