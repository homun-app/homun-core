# Stato — Homun (documento vivo)

> **Ultimo aggiornamento: 2026-07-31 (P0 live + Vault API).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identità Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Branch | `main` |
| HEAD base P0 | `75418ba8` (+ commit smoke/STATO successivi) |
| Versione | `0.1.1094` |

## Dove siamo

Homun = gateway Rust + Electron/React + sidecar. Contratto unico
`ExecutionContract → execute → ExecutionOutcome`. Loop unico
`engine::agent_loop::run_turn`. Vedi [`architecture/overview.md`](architecture/overview.md).

### P0 — fatto

**Gate deterministici (ALL GREEN)** su `75418ba8` (+ wasmtime 46.0.2):

- `cargo fmt` / `clippy -D warnings` / `pre_release_gate.py` **ALL GREEN**
- `cargo audit` verde; `npm audit --audit-level=high` 0 vuln
- Mappe `contained-computer` / `host-computer-control` ripristinate as-built

**`scripts/production_smoke.py`** migrato al broker (`POST /api/chat/threads` +
`/api/chat/turns` + poll events).

**Live `electron:dev` (1420 / 18765):**

| Check | Esito |
| --- | --- |
| Health / cancel / concurrent / restart | PASS (incluso SIGKILL → watchdog) |
| S1, S2, S6, S7 | PASS (broker smoke) |
| Runtime sandbox | `workspace-write` |
| Uncertain effects API | 200 |
| **Vault PIN setup** | PASS — PIN QA sintetico `246810` sul profilo locale |
| **Vault seed CF + targa** | PASS via `/api/vault/proposals/accept` |
| **Vault list redacted** | PASS — no CF/targa in plaintext |
| **Vault reveal + PIN** | PASS corretto; **FAIL chiuso** su PIN sbagliato (`invalid_vault_pin`) |
| Smoke S3/S4 (marker dal modello) | **FAIL** — modello locale non emette `VAULT_REVEAL`/`VAULT_PROPOSE`; contratto API Vault comunque verde |

### Residuo live

- Browser crash sidecar
- Write sandbox allow/deny end-to-end
- Approval + resolve `Uncertain` applicato
- Presentazioni template + automazioni `pending_verification`
- Smoke UI (menu/sidebar/temi)
- (Opzionale) S3/S4 con modello più capace per i marker in chat

### Debito noto

- `main.rs` ~89k; `ChatView.tsx` ~10k
- `HOMUN_MEMORY_SERVICE` default OFF; `OrchestratorBrain` ancora materializza task
- Profilo locale ora ha PIN Vault QA e due record sintetici (CF + targa) — solo metadata in list

## Prossimo lavoro

1. Residuo live: crash sidecar / sandbox write / uncertain resolve / presentazioni-automazioni.
2. P1 rifinitura UI.
3. RC draft dopo evidenza sullo stesso SHA.

## Prompt di ripartenza

```text
Continuo Homun. Repo: /Users/fabio/Projects/Homun/app, branch main.
Leggi docs/STATO.md. P0 gate + Vault API (PIN/reveal/redaction) OK; S3/S4 marker
model-driven ancora FAIL sul modello locale.
Prossimo: crash sidecar o sandbox write E2E o P1 UI. Non pubblicare.
```
