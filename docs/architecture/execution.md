# Execution protocol & durable runtime (as-built)

Verificato 2026-07-31.

## Contratto (`crates/execution-protocol`)

Tipi pubblici in `src/lib.rs`:

- **`ExecutionContract`** / **`ValidatedExecutionContract`** — schema_version,
  execution_id, revision, fencing_token, scope, policy, budget, checkpoint, wake.
- **`ExecutionOutcome`** — `Completed` | `Suspended` | `Cancelled` | `Failed`.
- **`WakeCondition`** — `At` | `Signal` | `Resource` | `ModelAvailable` | `User` |
  `Approval` | `EffectResolution`.
- **`EffectReceiptStatus`** — `Prepared` | `Started` | `Completed` | `Failed` |
  `Uncertain` | `Compensated`.

`PROTOCOL_SCHEMA_VERSION = 1`.

## Host nel gateway

| Pezzo | File |
| --- | --- |
| `ExecutionHost` + `GatewayExecutionHost` | `crates/desktop-gateway/src/execution_host.rs` |
| Dispatch / fence / deadline | `execution_runtime.rs`, `execution_control.rs` |
| `EffectHost` (claim → Execute/Replay/Resolve; `mark_uncertain`) | `effect_host.rs` |
| Adapter context ristretto (no `AppState` ambientale) | `execution_adapter_context.rs` |

Invariante osservata nei test: un effect `Uncertain` / dispatch abbandonato **non**
viene rieseguito automaticamente; serve risoluzione esplicita
(`applied` / `not_applied`).

## Persistenza (`crates/task-runtime`)

| Modulo | Ruolo |
| --- | --- |
| `execution_store` | Contract/outcome/receipt persistiti |
| `projection_outbox` | Tabella `execution_projection_outbox`, enqueue/requeue |
| `lease` | Lease + heartbeat worker |
| `broker` | Enqueue/steer chat turn atomici |
| `store` / `facade` / `approval` / `scheduler` | Queue task, approval, schedule |

Drain outbox: `crates/desktop-gateway/src/projection_worker.rs` →
`execution_projection.rs`.

## Long-running

Lease, heartbeat, deadline, park/resume chat (`park_chat_turn` /
`unpark_chat_turn_to_queued`), cancel cooperativa. Un ritorno tardivo con fence
stale non completa il lavoro (controllo in `execution_control` / runtime).

## UI e Tasks

La dashboard Tasks **non esiste** più come view. Il task-runtime resta: la chat
consuma queue/approval/uncertain via bridge (`CoreTaskQueueSnapshot` in
`apps/desktop/src/lib/coreBridge.ts`) e le proietta come attenzione nella
conversazione.
