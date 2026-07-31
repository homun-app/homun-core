# Stato — Homun (documento vivo)

> **Ultimo aggiornamento: 2026-07-31 (P0 gates + live broker + restart).**
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
`/api/chat/turns` + poll events). Path legacy `generate_stream` rimosso.

**Live `electron:dev` (1420 / 18765):**

| Check | Esito |
| --- | --- |
| Health | `ok:true`, no recovery/projection error |
| Turno semplice / memoria (S1, S2) | PASS via production_smoke broker |
| Due chat concorrenti | entrambe `completed` |
| Cancel | 202 → `cancelled` |
| Task queue | 200 |
| Vault API | pin status + records OK; nessun CF fixture in plaintext nella list |
| Runtime sandbox | `sandbox_mode=workspace-write` (settings) |
| Uncertain effects API | 200 lista |
| Hard restart | `SIGKILL` gateway → watchdog ripristina; health pulita; enqueue OK |
| Piano URL morta (S7) | PASS (~4 min) |
| Vault propose (S4) | **FAIL** — nessun marker `VAULT_PROPOSE` (pin vault `configured:false` sul profilo) |

### Residuo live

- Vault reveal/propose con PIN/fixture sintetici
- Browser form fill / crash sidecar (S6)
- Write sandbox allow/deny end-to-end
- Approval + resolve `Uncertain` applicato
- Presentazioni template + automazioni `pending_verification`
- Smoke UI (menu/sidebar/temi) sullo SHA attuale
- `GET /api/workspaces/{id}/policy` è **POST-only** (405 in GET) — ok, mode già su settings/list

### Debito noto

- `main.rs` ~89k; `ChatView.tsx` ~10k
- `HOMUN_MEMORY_SERVICE` default OFF; `OrchestratorBrain` ancora materializza task

## Prossimo lavoro

1. Residuo live sopra (partire da Vault con PIN o S6 browser).
2. P1 rifinitura UI.
3. RC draft (`testing/release-candidate-matrix.md`) dopo evidenza sullo stesso SHA.

## Prompt di ripartenza

```text
Continuo Homun. Repo: /Users/fabio/Projects/Homun/app, branch main.
Leggi docs/STATO.md. P0 gate verde; production_smoke sul broker; hard restart OK.
Prossimo: residuo live (Vault+PIN, browser S6, presentazioni/automazioni) o P1 UI.
Non pubblicare.
```
