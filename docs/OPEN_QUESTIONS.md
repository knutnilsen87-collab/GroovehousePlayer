# Åpne spørsmål til Knut

Valg som er lette å gjøre om, er tatt (det tryggeste) og står under «Valgt». Det som ikke er lett å gjøre om, står under «Venter på svar» – den delen er hoppet over til du svarer.

## Venter på svar

_(ingen ennå)_

## Valgt (kan endres)

1. **Master som FLAC (del 10):** Vault lagrer en tapsfri kopi som `media/<slug>/<variant>/v<N>/master.flac`. Alle 25 filer i REASONDONE er 16-bit/44,1 kHz PCM, så FLAC er bit-for-bit lik lyden. «Original WAV» lages fra FLAC-en: samme samples, men ikke byte-identisk fil (header/ekstra chunks skrives på nytt). Er en framtidig eksport 32-bit flyttall (FLAC tåler ikke det), lagres den som WAV i stedet.
2. **Fixtures uten kildefil:** `blue-fire` og `live-sett-demo` kommer fra `fixtures/`, ikke REASONDONE, og har derfor ingen «Kildefil».
