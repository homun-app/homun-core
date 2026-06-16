# Stato del progetto — sintesi (2026-06-16)

> Aggiorna lo snapshot `state-of-project-2026-06-13.md` (che resta come storia).
> Riconcilia la doc con la realtà del codice dopo la settimana 13→16 giugno: durabilità,
> proattività, onboarding wizard e **migrazione multilingua i18n completa** (PR #72,
> squash-mergiata in `main` come `5bdb8b5`).

---

## TL;DR

- I pilastri reattivi (chat, memoria, canali, browser, connettori, sicurezza) restano
  **fatti e funzionanti** (~95%).
- **Chiusi dal 13/06**: heartbeat/lease watchdog, retention + VACUUM, export completo,
  onboarding wizard, proattività (consegna), e la **migrazione multilingua i18n completa**
  (frontend a `t()`, prompt/messaggi backend in inglese, 0 italiano residuo, detector
  `scripts/find_italian.py`).
- **Unico blocker hard rimasto verso la prima release**: **firma + notarization macOS**.
  Il packaging è scaffoldato (electron-builder mac/win/linux, entitlements, staging del
  gateway, `package:smoke`) ma **manca code-signing + notarytool**.
- Il resto è rifinitura (intervista onboarding multi-turno più profonda, migliorie SOTA
  memoria) e verifica live continua.

---

## 1. Chiuso dal 13/06 (deriva risolta)

| Item (era blocker/⚠️ il 13/06) | Stato 16/06 | Riferimento |
|---|---|---|
| `heartbeat()` mai chiamato → task lunghi scadono | ✅ Agganciato nel task loop + guard furto-lease | `desktop-gateway/src/main.rs:16260`, ADR 0015 (fix #3) |
| Pulizia dati on-delete + retention SQLite | ✅ Cascade purge + VACUUM periodico | ADR 0015 (fix #1) |
| Export dati parziale | ✅ `GET /api/export` completo (GDPR-style) | ADR 0015 (fix #2) |
| Proattività non consegna | ✅ Tolto 45% random, primo check-in +2min, checkin-now + pulsante, log gate | commit `00e4671` |
| Onboarding superficiale | ✅ Wizard setup (Docker check + validazione LLM) | fix #4 (`d0e2347`) |
| Multilingua i18n parziale | ✅ Completa: full `t()`, backend EN, en/it 917 chiavi in sync, plugin self-contained | ADR 0014, PR #72 |

**Nuovo strumento durevole:** `scripts/find_italian.py` — detector di stringhe italiane
(parole-funzione + morfologia `-zione/-mento/-ità` + vocali accentate + lessico UI +
elisioni `dell'/l'`; salta commenti, `tests/`, `#[cfg(test)]`, `it.json`). Esce non-zero
se trova residui → usabile come **gate CI**. Limite noto: bassa recall su parole corte
non accentate (`locale`, `stato`, `redatto`) → per i file-dati/lib densi leggerli interi.

**Italiano che resta — di proposito (27 righe):** logica multilingua che *deve* capire
l'input italiano — parser date (IT/ES/FR/DE), liste ack/conferma, parser approvazioni
(`OK|SI|APPROVA`), pattern sicurezza acquisto/login. Più ~50 righe di fixture di test.

---

## 2. Verso la prima release — cosa resta

### 2.1 ✅ Release macOS firmata + notarizzata — funzionante (verificata 2026-06-16)

**La CI di release** (`.github/workflows/build.yml`) builda mac/win/linux su tag `v*`
(+ bozza GitHub Release) o via `workflow_dispatch` (solo artifacts). Il mac job fa build
**firmato + notarizzato** (`electron-builder --mac -c.mac.notarize=true`); electron-builder
firma da solo il gateway bundlato.

**Verificato end-to-end** (run 27623629097, 16/06): `signing … identity=89244906…
type=distribution` → `notarization successful` → `Homun-0.1.0-arm64.dmg`. Gli artifacts
`homun-mac/win/linux` sono prodotti correttamente.

Due problemi trovati e risolti lungo la strada: (1) `MAC_CSC_LINK` era **vuoto** (cert
Developer ID mai caricato davvero) — ricaricato il `.p12` base64; (2) la notarization dava
`401 Invalid credentials` perché `APPLE_APP_SPECIFIC_PASSWORD` non era una app-specific
password valida — rigenerata su appleid.apple.com. Inoltre il gate cert è stato spostato in
uno step `run` (`steps.signing.outputs.has_cert`) che logga lo stato (più robusto: è così
che si è diagnosticato `MAC_CSC_LINK` vuoto). Procedura completa: `docs/release-macos.md`.

**Per tagliare la prima release firmata:** push di un tag `v*` → il workflow builda e crea
una bozza di GitHub Release con i `.dmg`/`.zip` firmati allegati, da pubblicare a mano.

### 2.2 🟡 Rifinitura (non bloccante per la release)

- **Intervista onboarding multi-turno** più profonda (oggi: wizard statico + ~85% via
  persona thread; manca l'intervista guidata "chi sei / cosa fai / cosa salvare" → memoria
  personale → "ecco cosa ho appreso" + prime curiosità/automazioni).
- **Verifica LIVE continua** che il check-in proattivo arrivi end-to-end nel thread `homun`
  (heartbeat è agganciato; confermare la consegna su un'esecuzione reale osservata).

---

## 3. Migliorabile (SOTA) — post-release

(invariati dal 13/06, ancora validi)

- **`epistemic_source` in memoria** (search ≠ fatto): non dedurre "ha programmato un
  viaggio" da una ricerca prezzi.
- **Consolidamento su TUTTI i tipi + re-embed periodico**: oggi `consolidate_scope` non usa
  il coseno come il dedup-on-write → i duplicati personali pregressi (es. "Trenitalia" ×4)
  non si fondono.
- **MCP secret-store** cifrato (oggi metadata JSON in chiaro, non come Composio) +
  always-allow per le write MCP + OAuth-remote.
- **Rigenerazione grafo incrementale** (oggi all-or-nothing); **ChannelProvider trait**
  (dispatch a stringa sparso); **coda outbound persistente** per i canali (oggi
  fire-and-forget); **trash/recovery memoria** (i soft-deleted restano invisibili).

---

## 4. Prossima azione (consigliata)

1. **Release track (P0):** wiring firma + notarization macOS in electron-builder + `npm run
   dist` + smoke Gatekeeper. (Richiede credenziali Apple Developer.)
2. **In parallelo (P1, nessuna dipendenza):** verifica live proattività + approfondire
   l'intervista di onboarding.
3. **Post-release:** le migliorie SOTA del §3.
