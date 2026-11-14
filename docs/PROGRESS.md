# Framdrift – Groovehouse Vault

Arbeidslogg for `setup/del-0` (alt pushes hit, ingenting merges til `main`). Les denne først hvis arbeidet blir avbrutt.
Detaljert status og testbevis står i `status_bundle.txt`. Spørsmål til Knut står i `docs/OPEN_QUESTIONS.md`.

**Rekkefølge (Knut, 2026-11-14):** 9 → 11 → 12 → 10 → 1 pkt. 7–8 → 8 → 2 → 4 → 3. Del 5 (Supabase) hoppes over (ingen nøkler i `.env`).

**Faste regler:** REASONDONE kun lesing · ingen hemmeligheter/PIN/Tailscale-adresse i git (`git grep -i "ts.net"` før push) · aldri Funnel · ingen musikk til skyen · ingen admin/brannmur · ikke essentia.js.

## Status

| Del | Status | Testet | Gjenstår / Knut må teste |
|---|---|---|---|
| 9 Spillelister | ✅ ferdig | 97 enhetstester, «Ferdig når» mot ekte server, 31/31 UI-sjekker i hodeløs Edge (desktop + mobil) | Fysisk telefon; avspilling av eldre låst versjon (ingen låt har >1 versjon ennå) |
| 11 «⋯»-meny | 🔨 pågår | – | – |
| 12 Android-app | ⏳ | – | – |
| 10 Del låt som fil | ⏳ | – | – |
| 1 pkt. 7–8 Autostart + varsel | ⏳ | – | – |
| 8 Innstillinger | ⏳ | – | – |
| 2 Markør-editor | ⏳ | – | – |
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

## Logg

- 2026-11-14: Del 9 ferdig (bcdb20b). Del 11 påbegynt: kildefil (5e7c426). Main (7862d80) merget inn.
- 2026-11-14 02:56: `Out of Control.wav` ble skrevet av Reason under kildefil-skanningen (EBUSY, hoppet over). Ny bounce, ikke endret av Vault.
