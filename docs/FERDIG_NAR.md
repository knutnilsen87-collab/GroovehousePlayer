# Gjennomgang mot «Ferdig når» (del 0–27)

Gjort 2026-11-17 på `setup/del-0`. Hver del er sjekket mot «Ferdig når» i `CLAUDE_CODE_SETUP.md`.

- ✅ = oppfylt og sjekket her (tester, hodeløs Edge eller ekte server).
- 🟡 = koden er ferdig, men kriteriet krever telefon, bil, rekordbox, landr.com eller en omstart som bare Knut kan gjøre.
- ⏸ = hoppet over etter avtale.

| Del | «Ferdig når» (kort) | Status | Bevis | Det Knut må gjøre |
|---|---|---|---|---|
| 0 | Låtene fra REASONDONE spilles i spilleren | ✅ | Vault kjører på 127.0.0.1:41733, 309 låter i katalogen, avspilling i Edge | – |
| 0b | Rene titler, REASONDONE uendret, ny bounce dukker opp | ✅ | Watcheren har ingestet nye bouncer (f.eks. «Out of Control»); REASONDONE leses bare | – |
| 1 | Snarvei åpner spilleren; etter omstart kjører serveren og varsler | 🟡 | Oppgaven «Groovehouse Vault» kjører (brukt for omstart i dag); testvarsel vist | Start PC-en på nytt og bounce noe nytt |
| 2 | Flytt Drop 1, `gh-ingest --force`, flyttingen står seg | 🟡 | Ende-til-ende-test med ffmpeg på fixtures | Gjør det på en ekte låt |
| 3 | Treffraten målt på egne låter | 🟡 | `pnpm eval:analysis`; syntetisk BPM 16/16 | Fyll inn `fixtures/truth.json` |
| 4 | Raskere ingest (ingen egen linje) | ✅ | 10 min: 10,6 → 6,4 s | – |
| 5 | Fortsett på mobilen fra samme sted | 🟡 | `/api/playback` med test (nyeste vinner) | Prøv PC → mobil |
| 6 | Mobilen på samme Wi-Fi (ingen egen linje) | 🟡 | Wi-Fi-modus og PIN i Innstillinger | Brannmurregelen krever administrator (OPEN_QUESTIONS 10) |
| 7 | Spilles over 4G via ts.net, ingenting åpent mot internett | 🟡 | Tailscale Serve (aldri Funnel), CORS/paring verifisert over Tailscale | Prøv på 4G |
| 8 | Innstillinger står seg etter omstart og ny ingest | ✅ | 22/22 i Edge, sjekket på nytt etter omstart | – |
| 9 | Liste lages på mobil, sees og endres på PC | 🟡 | 31/31 i Edge (mobil og desktop mot samme server) | Prøv med S22 |
| 10 | Del til WhatsApp og e-post, riktig tittel og cover | 🟡 | ffmpeg-tester (FLAC, AAC, tagger, cover) | Del én låt hver vei |
| 11 | ⋯ i fullskjerm: legg i liste og del uten å forlate spilleren | ✅ | 29/29 i Edge (mobilskjerm) | Prøv på telefonen |
| 12 | APK på S22: 15 min med skjermen av, låseskjerm og Bluetooth | 🟡 | Signert APK 120 lagt ut | Hele testen på S22 og i bilen |
| 13 | Drop-lenke på WhatsApp spiller på en annen telefon | ⏸ | Kodet og testet lokalt | Ikke lagt ut i Cloudflare (din beslutning) |
| 14 | Blått og rødt cover gir riktig uttrykk; samme stil i appen | ✅ | Bilder i `docs/design/compare/` | Se fullskjerm i appen |
| 15 | Web-endring vises etter at appen lukkes og åpnes; native gir «Oppdater» | 🟡 | Bunt 20261117…, APK 120 publisert | Trykk «Oppdater» i appen (APK 120) |
| 16 | Utkast holdes atskilt; Album-plan «2 av 7 mastret» | ✅ | 15/15 i Edge med ekte utkast | – |
| 17 | 60-min Reise-sett på under 3 s, eksport i rekordbox med mikspunkter | 🟡 | 3 forslag på 0,04–0,5 s; XML-test; 18 av 18 fil-URI-er finnes | Importer XML-en i rekordbox |
| 18 | «Echo out» lagret i bilen med to trykk; cuene i rekordbox | 🟡 | Tester for presets, cue-eksport og påminnelse | Prøv i bilen (APK 120) og i rekordbox |
| 19 | Bytte skin på PC med en gang; OLED Svart på telefonen | ✅ | Skins sjekket i Edge, valget lagres per enhet | Velg OLED Svart på S22 |
| 20 | «Lag sett fra denne»: tre sett på under 5 s, hver overgang har forhåndsvisning | ✅ | Tre forslag på 0,5 s; 13 overganger rendret på 22 s, 10/13 grønne, resten får alternativ automatisk; analyse av alle 309 låter på GPU (0 feil) | Hør overgangene på telefonen |
| 21 | Vault på Raspberry Pi | ⏸ | – | Venter på Pi-en |
| 22 | Før og etter er tydeligere | ✅ | Alle 6 «etter»-bilder i `docs/design/compare/del-22/` | Vurder bildene |
| 23 | Alle låter har cover; AI-cover for én låt | 🟡 | Vault-cover for alle som manglet (171); bulkIMG-koblingen er testet | Lag ett AI-cover sammen med bulkIMG |
| 24 | «Forbered utgivelse» gir mappe og kopier-knapper; status «Sendt til LANDR» | ✅ | Pakke for «Lost» laget i Edge (WAV, cover, metadata, sjekkliste, 13 felter); tester | Send inn én på landr.com |
| 25 | Utgitte låter som Utgitt; kobling etter bekreftelse; Spotify-lenke under Kreditering | 🟡 | Tester med midlertidig mappe | Kopier én utgitt låt inn i `utgitt-sync` |
| 26 | Album, 10 låter: tre forslag, 20 s utdrag, bytt ut, lagre, release-pakke | ✅ | Tre forslag på 0,3 s; «Forbered utgivelse …» på Album-planen (ny i dag) | – |
| 27 | Ny enhet uten hjelp; alle visninger har lenke; låst versjon overlever ny bounce | 🟡 | Tester og sjekker i Edge (mobil, desktop, 200 % zoom) | Koble S22 til i fire trinn og prøv de viktigste oppgavene |

**Ikke bygget, og står i OPEN_QUESTIONS:**
- Automatisk «DJ edit» og å dra første taktslag (del 20).
- CSV-import fra LANDR (del 25).
- Supabase (del 5): synken går via Vault-serveren.
