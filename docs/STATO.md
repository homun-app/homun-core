# Stato — Homun (documento vivo)

> **Ultimo aggiornamento: 2026-07-31 (P0 gates + live broker smoke).**
>
> Hub: [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
> Archive stantia: [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> Prompt lungo: [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identità Git

| Campo | Valore |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Branch | `main` |
| HEAD collaudo P0 | `75418ba8` (`fix(deps): bump wasmtime…`; doc reset `3a82de4a`) |
| Versione | `0.1.1094` |
| Worktree | pulito dopo i commit doc/deps |

## Dove siamo

Homun = gateway Rust + Electron/React + sidecar. Contratto unico
`ExecutionContract → execute → ExecutionOutcome`. Loop unico
`engine::agent_loop::run_turn`. Vedi [`architecture/overview.md`](architecture/overview.md).

### P0 — fatto su questo HEAD

**Gate deterministici (ALL GREEN):**

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `python3 scripts/pre_release_gate.py` → **ALL GREEN** (capabilities → gateway →
  electron 155 → UI contract → Vite build → deck/doc render…)
- `cargo audit` — verde dopo bump `wasmtime` 45 → **46.0.2** (`RUSTSEC-2026-0222`)
- `npm --prefix apps/desktop audit --audit-level=high` — 0 vuln

**Fix durante il gate:** ripristinate mappe as-built
`architecture/contained-computer.md` + `host-computer-control.md` (test Electron
leggevano i path dopo il doc reset).

**Live `electron:dev` (porte 1420 / 18765, PID gateway sul worktree):**

| Check | Esito |
| --- | --- |
| Vite HTTP | 200 |
| `GET /api/health` | `ok:true`, `recovered_stores:[]`, `projection_worker_error:null` (anche dopo i turni) |
| Enqueue `POST /api/chat/turns` su thread creato | 201 → `completed` (events≥2) |
| Due thread concorrenti | entrambi `completed` |
| `DELETE /api/chat/turns/{id}` | 202 → stato `cancelled` |
| `GET /api/tasks/queue` | 200 (projection attenzione ancora raggiungibile) |

Nota: `scripts/production_smoke.py` punta ancora a `/api/chat/generate_stream` → **404**
(path legacy rimosso). Il collaudo live ha usato il broker (`/api/chat/turns`).

### Non ancora collaudato live in questa sessione

Matrice HANDOFF ancora aperta: hard restart gateway, browser crash/sidecar,
approval/`Uncertain`, sandbox allow/deny, Vault plaintext, linked memory,
connector on/off, presentazioni template, automazioni `pending_verification`,
smoke UI Electron (menu/sidebar/temi) sullo SHA attuale.

### Debito noto

- `main.rs` ~89k; `ChatView.tsx` ~10k.
- `HOMUN_MEMORY_SERVICE` default OFF; `OrchestratorBrain` ancora per materializzare task.
- `production_smoke.py` da aggiornare al broker.

## Prossimo lavoro

1. Completare collaudo live residuo (browser/Vault/sandbox/presentazioni/automazioni +
   restart) e/o aggiornare `production_smoke.py` al path turns.
2. P1 rifinitura UI dettaglio.
3. RC multipiattaforma draft dopo evidenza sullo stesso SHA (`testing/release-candidate-matrix.md`).

## Prompt di ripartenza

```text
Continuo Homun. Repo: /Users/fabio/Projects/Homun/app, branch main.
HEAD P0 verde: 75418ba8. Leggi docs/README.md → docs/STATO.md → docs/architecture/.

P0 gate + smoke broker fatti. Prossimo: collaudo live residuo (browser, Vault,
sandbox, presentazioni, automazioni, hard restart) e/o fix production_smoke.py
al broker; poi P1 UI / RC draft. Non pubblicare.
```
