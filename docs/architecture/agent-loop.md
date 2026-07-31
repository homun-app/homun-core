# Agent loop (as-built)

Verificato 2026-07-31.

## Path di un turno chat

1. **Enqueue** — `POST /api/chat/turns` → `enqueue_turn` in
   `crates/desktop-gateway/src/main.rs`, che usa il broker
   `local_first_task_runtime::broker` (`enqueue_chat_turn_atomic` /
   `enqueue_or_steer_chat_turn_atomic`).
2. **Worker** — con `HOMUN_TASK_EXECUTOR_WORKER` default **ON**,
   `execution_runtime` costruisce `GatewayExecutionHost`
   (`crates/desktop-gateway/src/execution_runtime.rs`, `execution_host.rs`).
3. **Chat task** — `ExecutionHost::execute_chat_turn` →
   `turn_executor::execute_chat_turn_task` →
   `run_agent_turn_into_message_with_fanout` / `stream_chat_via_openai` /
   `run_agent_rounds` (gateway).
4. **Motore** — `run_agent_rounds` chiama **incondizionatamente**
   `local_first_engine::agent_loop::run_turn`
   (`crates/engine/src/agent_loop.rs`). Flag `HOMUN_ENGINE_CRATE` **assente**.
5. **Live UI** — eventi su `GET /api/ws` (`ws_gateway.rs`).
6. **Proiezione terminale** — outbox `execution_projection_outbox` →
   `projection_worker` → `execution_projection::project_chat_execution`.

## Cosa possiede il crate `engine`

Moduli reali in `crates/engine/src/`:

| Modulo | Ruolo |
| --- | --- |
| `agent_loop` | Loop ReAct unico |
| `contract` | Trait seam gateway↔engine (`ModelClient`, `CapabilityExecutor`, …) |
| `hitl` | Un solo `HitlEnvelope` / wait utente |
| `plan` / `markers` / `model_normalize` | Piano e marker canonici |
| `browse` | Contratto `browse(goal)` → sub-turno (ADR 0025) |
| `execution_journal` / `turn_trace` | Journal / osservabilità in-turn |
| `loop_state` / `config` / `outcome` | Stato e risultato del turno |

Il gateway **implementa** i trait e costruisce lo stato; non contiene più una
copia inline del loop.

## Browser

- Tool browse → sub-turno: isolato `LoopState` + altro `run_turn` con
  `browser_subturn` (gateway + `engine::browse`).
- Sidecar: processo in `runtimes/browser-automation` (`npm run start`), con
  override `HOMUN_BROWSER_AUTOMATION_DIR`. Checkpoint/generation e crash recovery
  vivono nel sidecar + effect host (receipt `Uncertain` se process loss).

## HITL

Un chokepoint in `crates/engine/src/hitl.rs`. Wait durevoli e resume dello stesso
objective contract lato task-runtime/gateway (`hitl_resume.rs`). Il testo libero
non deve inventare uno stop parallelo.

## Cosa non è

- **`local-first-orchestrator`** non è il loop chat. Può ancora materializzare
  lavoro durevole (`HOMUN_BRAIN_MATERIALIZE` default ON) — residuo da non
  estendere come secondo motore.
