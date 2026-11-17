# Definition of Done – seksjon A (drift og sikkerhet)

Sist sjekket: 2026-11-17. ✅ = ferdig og testet · ⏳ = venter på Knut · ➖ = fantes fra før

| # | Krav | Status | Hvordan det er sjekket |
|---|---|---|---|
| 1 | GitHub Actions: `pnpm typecheck` og `pnpm test` (uten `-s`) på hver push og PR | ✅ | `.github/workflows/ci.yml` (Windows, Node 24, pnpm 9, ffmpeg via Chocolatey). Lokalt: typecheck grønn, alle tester grønne. Første kjøring på GitHub skjer når grenen pushes. |
| 2 | gitleaks over hele historikken | ✅ | Lokalt: `gitleaks detect --log-opts=--all` – 102 commits, **0 funn**. I CI: `gitleaks/gitleaks-action@v2` med `fetch-depth: 0`. Merk: tailnet-navnet står i eksempelet på linje 703 i `CLAUDE_CODE_SETUP.md` (fra main). Det er ikke en hemmelighet, men bør byttes til et oppdiktet navn. |
| 3 | `pnpm audit` uten høy eller kritisk | ✅ | Før: 4 høye og 3 kritiske (sharp 0.33, vitest 2 → tinypool, vite 5). Oppgradert: sharp ^0.35.5, vitest ^4.1.12, vite ^6.4.4. Etter: **0 høye, 0 kritiske** (1 moderat igjen). CI stopper på høy/kritisk i produksjonsavhengigheter. |
| 4 | Rate limiting på PIN | ➖ ✅ | Fantes: `LoginLimiter` (5 feil per adresse per 15 min, 20 totalt per time) på Wi-Fi-innlogging og paring av enheter (429). Testet i `apps/server/test/lan.test.ts` og `devices.test.ts`. |
| 5 | `pnpm vault:restore` med testet gjenoppretting | ✅ / ⏳ | `scripts/vault-restore.mjs`: henter `data/`, `media/` og `groovehouse.local.json` fra backupen, sikkerhetskopierer nåværende data først, nekter mens Vault kjører, og kontrollerer resultatet (0 forskjeller, JSON like med SHA-256). Automatisk test: `apps/server/test/restore.test.ts` (4/4). **Full test med ekte data** (backup til C: og gjenoppretting derfra) ble stoppet av lite minne på PC-en og kjøres på nytt når du ber om det. Den ekte backupen til H: tas etter at den har bestått. |
| 6 | «Siste backup» i Studio | ✅ | `pnpm vault:backup` skriver `%LOCALAPPDATA%\GroovehouseVault\last-backup.json`. Studio → Innstillinger → Server viser tid, mål, antall filer, og blir gul etter 7 dager. |
| 7 | Feilsøkingsside i README | ✅ | README → «Feilsøking» (oppstart, import, utgitte låter, mobiltilkobling, oppdatering, PIN-sperre, GPU, backup). |
| 8 | `docs/DOD.md` | ✅ | Denne fila. |

## Det du må gjøre selv
- Be meg kjøre den fulle gjenopprettingstesten og så backup til H: (`pnpm vault:backup`).
- Se at første CI-kjøring på GitHub blir grønn (Actions-fanen), og slå på «Require status checks» for main hvis du vil.
- Bytt tailnet-navnet i eksempelet i `CLAUDE_CODE_SETUP.md` (linje 703) til et oppdiktet navn.
