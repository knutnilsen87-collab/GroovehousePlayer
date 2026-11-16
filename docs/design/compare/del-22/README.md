# Del 22 – visuell finpuss, før og etter

Tatt i hodeløs Edge mot den kjørende Vault-serveren (bygget fra `setup/del-0` før del 22, 2026-11-16) med `skjermbilder.mjs` i denne mappa.

```
node docs/design/compare/del-22/skjermbilder.mjs docs/design/compare/del-22 <for|etter> [skins] [desktop|mobil]
```

- Tre skins: **Kameleon** (standard), **Echo Groove Nights** (egen display-font og laste-tekst) og **OLED Svart** (uten blur).
- Desktop 1536×1024 (Hjem med dekket) og mobil 390×844 (fullskjermspilleren, DPR 2).
- Samme låt i alle bilder («Signal In My Soul»), spolt til 45 %, så spilt og uspilt del av bølgeformen kan sammenlignes.
- Skriptet bruker bare Node 24 (innebygd WebSocket) og Edge via CDP. Ingen nye pakker.

| Skin | Desktop | Mobil |
|---|---|---|
| Kameleon | `for-kameleon-desktop.jpg` → `etter-kameleon-desktop.jpg` | `for-kameleon-mobil.jpg` → `etter-kameleon-mobil.jpg` |
| Echo Groove Nights | `for-echo-groove-nights-desktop.jpg` → `etter-…` | `for-echo-groove-nights-mobil.jpg` → `etter-…` |
| OLED Svart | `for-oled-svart-desktop.jpg` → `etter-…` | `for-oled-svart-mobil.jpg` → `etter-…` |

«Etter»-bildene tas med samme skript når del 22 er bygget.

**Observert under opptaket:** katalogen henter ~190 `analysis.json` (til sammen 18 MB) ved oppstart. I hodeløs Edge tok det fra 20 s til over 3 min før Hjem var klar. Dette er ikke en del av del 22, men bør ses på (f.eks. at lista bruker data fra `index.json`/manifest og henter analyse først når en låt åpnes).
