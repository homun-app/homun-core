# Stato — Homun (documento vivo)

> **Ultimo aggiornamento: 2026-07-31 (doc reset).**
>
> Unico documento di sessione da aggiornare a ogni passo. Hub:
> [`README.md`](README.md). Mappa codice: [`architecture/`](architecture/).
>
> Storico STATO pre-reset:
> [`archive/STATO-history-pre-2026-07-31.md`](archive/STATO-history-pre-2026-07-31.md).
> Doc stantia spostata in
> [`archive/2026-07-31-doc-reset/`](archive/2026-07-31-doc-reset/).
> `CLAUDE.md` rimosso. Prompt lungo opzionale:
> [`HANDOFF-2026-07-31.md`](HANDOFF-2026-07-31.md).

## Identità Git (verificare a inizio sessione)

| Campo | Valore all’ultimo aggiornamento |
| --- | --- |
| Repo | `/Users/fabio/Projects/Homun/app` |
| Branch | `main` |
| HEAD tipico | baseline UI `9d2788e8`; handoff doc `f5d6fb6d` (+ commit doc reset dopo) |
| Versione prodotto | `0.1.1094` (`apps/desktop/package.json`) |
| Worktree | pulito prima di gate/release |

```bash
git status --short && git log -5 --oneline
```

## Dove siamo

Homun = gateway Rust + Electron/React + sidecar. Runtime durevole su **un**
contratto: `ExecutionContract → execute → ExecutionOutcome`
(`execution-protocol` + `task-runtime` + host gateway). Un loop:
`crates/engine::agent_loop::run_turn`. Niente secondo HITL, store memoria, o
dashboard Tasks.

Dettaglio as-built: [`architecture/overview.md`](architecture/overview.md).

### Fatto (codice)

- Engine estratto (ADR 0024); flag `HOMUN_ENGINE_CRATE` / `HOMUN_TURN_BROKER` assenti.
- Effect host + receipt tipizzati; `Uncertain` senza auto-rerun.
- Projection outbox + crash recovery; lease/heartbeat/park/resume/cancel.
- Browser sub-turno + sidecar checkpoint/generation.
- HITL in `engine/hitl.rs`; Tasks UI rimossa; attenzione in chat.
- Sandbox `SandboxMode` (`HOMUN_SANDBOX_MODE`); no `HOMUN_TOOL_SAFETY`.
- Memoria: pool default ON; `HOMUN_MEMORY_SERVICE` ancora OFF.
- UI fase 1: grammatica compatta, island adattiva, spacing rifinito.

### Non ancora prova di release

Gate/smoke su `9d2788e8` (grammar/Electron/UI/Vite/health) **non** equivalgono a
collaudo installer sullo SHA attuale. Matrice:
[`testing/release-candidate-matrix.md`](testing/release-candidate-matrix.md).

### Debito noto

- `desktop-gateway/src/main.rs` ~89k; `ChatView.tsx` ~10k.
- `OrchestratorBrain` ancora per materializzare task (`HOMUN_BRAIN_MATERIALIZE`).
- Dual path memoria service opt-in.

## Prossimo lavoro

### P0

1. Gate su HEAD: `cargo fmt --check`, `clippy -D warnings`, `pre_release_gate.py`,
   `cargo audit`, `npm --prefix apps/desktop audit --audit-level=high`.
2. Collaudo Electron **dev** (porte 1420/18765) + verifica journal/receipt/DB
   (turni, wait/resume, cancel/restart, browser, approval/uncertain, sandbox,
   Vault, memoria, connector, presentazioni, automazioni).

### P1

3. Rifinitura UI di dettaglio con contract test.
4. RC multipiattaforma draft (no publish) dopo gate verdi.

## Prompt di ripartenza

```text
Continuo Homun. Repo: /Users/fabio/Projects/Homun/app, branch main.

Leggi docs/README.md → docs/STATO.md → docs/architecture/ (as-built).
Principi: docs/CAPISALDI.md. ADR solo come storia: docs/decisions/.
Archive e vecchie mappe NON sono specifica. Codice = verità.

Invarianti: ExecutionContract→execute→ExecutionOutcome; un loop
engine::run_turn; nessun secondo HITL/store/Tasks UI.

Prossimo: P0 gate + collaudo Electron reale. Poi P1 UI / RC draft.
Non pubblicare. Non reimplementare il kernel già presente.
```
