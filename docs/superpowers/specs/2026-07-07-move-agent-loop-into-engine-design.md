# Spostare il corpo del loop nell'engine — Design (ADR 0024, inc 5)

> Mini-design richiesto esplicitamente da `2026-07-07-extract-modelclient-design.md` §"Increment 5".
> Copre inc 5 nel suo insieme (slice 5a→5e); la parte implementata da questa sessione è **5c**.

## Contesto

Inc 4 (`ModelClient`) verde. `stream_chat_via_openai` (`main.rs` 22195–24672) è ancora inline. Va
spostato il **corpo del round loop** (`for round in 0..hard_round_ceiling()` a 23810) nel crate
`engine`; il gateway resta il postino (HTTP, setup, costruzione degli impl concreti da iniettare).

## Scoperta chiave — la mappa reale corregge l'ipotesi dell'arco

L'arc-memory ipotizzava che l'inc 5 avesse bisogno di "port per chat/task/browser". **Falso, letto il
codice.** La superficie di accoppiamento a `AppState` è ~45 free-fn che prendono `&AppState`, e si
dividono nettamente per **funzione contenitore**:

- **Dentro `execute_chat_tool` (18989–22193)** = quasi tutto: project-fs (chat_store), task/automation
  (task_store), recall/decisioni/code-graph/artifact (memory_facade), connettori Composio/MCP
  (capability_registry + secret_store), pagamenti (payment_approvals), browser/contained-computer
  (browser_thread_sessions / browser_capability_client / computer_store), vault. → **Tutto questo viaggia
  con il seam `CapabilityExecutor` (5d)**, la cui impl-gateway È `execute_chat_tool`. Non serve un port
  per-sottosistema: serve UN chokepoint tool (già definito come trait) + la ridefinizione `&mut ctx →
  effetti` (il vero lavoro duro di 5d, precondizione di ADR 0025 browse-as-recursion).
- **Setup pre-loop (22195–23809)** = privacy-guard (`pending_vault_proposals`), briefing
  (`memory_service`), assemblaggio system-prompt/tool-schemas, clone di `http`. → **Resta lato gateway**:
  costruisce il contesto iniettato PRIMA di chiamare l'engine. Nessun port.
- **Corpo del round loop (23810–24672)** — l'unica cosa che *si muove* — tocca `AppState` in un solo
  cluster coeso, oltre ai seam già estratti:

| Chiamata in-loop | Riga | Natura |
| --- | --- | --- |
| model round | (via `ModelClient` ✅ inc 4) | inferenza |
| sintesi forzata (empty-answer) | 24525+ | inferenza → **riusa `ModelClient`** (`is_final_round:true`) |
| tool dispatch | `execute_chat_tool` 24203-area | → `CapabilityExecutor` (5d) |
| eventi | `emit_stream_event` | → `EventSink` ✅ 5b |
| recall (setup) | `memory_service` | → `MemoryRecallService` ✅ 0022 |
| **`upsert_runtime_plan_memory_from_state`** | 24383, 24465, 24588 | persistenza piano (memory_facade) |
| **`record_runtime_plan_step_outcome_from_state`** | via `try_advance_frontier` 24203 | episodio (memory_facade) |
| **`verify_step_complete`** | via `try_advance_frontier` | giudice LLM (http + role="memory") |

`try_advance_frontier_from_evidence` è chiamata **una sola volta**, a 24203, dentro il loop (NON da
`execute_chat_tool`). Muove con il loop; le sue uniche dipendenze `AppState` sono le tre righe in
grassetto sopra.

**Conclusione:** l'unico port NUOVO che il loop richiede è quello del **progresso-piano runtime**.

## Il port di inc 5c — `PlanProgress`

Trait in `engine::contract`, tre metodi (async, `+ Send` come gli altri seam — il loop gira in
`tokio::spawn`):

```rust
pub trait PlanProgress {
    fn persist_plan(&self, thread: Option<&str>, steps: &[Value]) -> impl Future<Output=()> + Send;
    fn record_step_outcome(&self, thread: Option<&str>, step: &Value, evidence: &[String]) -> impl Future<Output=()> + Send;
    fn verify_step_complete(&self, title: &str, criterion: &str, evidence: &str) -> impl Future<Output=(bool, String)> + Send;
}
```

Impl-gateway `GatewayPlanProgress { state: AppState }` (in `main.rs`, accanto a `impl EventSink for
StreamSink`, perché delega a tre helper `fn` privati — nessuna promozione di visibilità, come EventSink;
`ModelClient` andò in file separato solo perché era un lift da 300 righe). `persist_plan`/`record` fanno
lo `spawn_blocking` (facade sync); `verify` inoltra a `verify_step_complete(&state.http, …)`.

### Decisione di convergenza — port a sé, NON dentro `MemoryRecallService`

Gli helper persistono il piano *come entità di memoria* (`lock_memory_facade`), quindi la tentazione è
piegarli in `MemoryRecallService`. **No, port separato**, perché:

1. `MemoryRecallService` è `brief`/`recall`/`learn` — ciclo di vita della *conoscenza*. Il piano runtime
   è **stato di control-flow dell'harness** (caposaldo: control-flow in codice) che usa lo store memoria
   solo come backend durevole. Semanticamente distinto → tenerli separati mantiene coerenti entrambi i
   contratti (SRP).
2. `verify_step_complete` è **inferenza** (giudice LLM), non un'operazione di memoria: non appartiene a un
   trait di recall in nessun caso.
3. Un port stretto e a sé combacia col pattern `ModelClient`/`EventSink`/`CapabilityExecutor` e resta
   *provabilmente minimo*.
4. ADR 0025 (browse-as-recursion) **ritira** questo intero meccanismo (il manager giudica le risposte, non
   un verifier a metà turno): un port standalone si cancella in un colpo solo, non intrecciato in memoria.

## Sequenza (behavior-preserving, gated `HOMUN_ENGINE_CRATE` all'atto del 5e)

- **5c (questa sessione):** definire `PlanProgress` + mock + impl-gateway. Loop **invariato** (chiama
  ancora le fn concrete); l'adapter è consumato a 5e (dead-code annotato). Gate: engine test + gateway compila.
- 5d: avvolgere `execute_chat_tool` come `CapabilityExecutor::execute_tool` — la ridefinizione `&mut ctx →
  effetti applicati dall'engine` (il crux; precondizione ADR 0025).
- 5e: spostare il corpo del loop in `engine` dietro `HOMUN_ENGINE_CRATE`, parità turno-per-turno; il loop
  consuma i port (`ModelClient`/`CapabilityExecutor`/`EventSink`/`MemoryRecallService`/`PlanProgress`).
- 5f (=inc 6): ritirare la parallela inline + i band-aid.

## Criteri d'accettazione 5c

1. `engine::PlanProgress` definito + esportato; mock `#[cfg(test)]` verde (usabile/mockabile).
2. `impl PlanProgress for GatewayPlanProgress` compila; delega verbatim ai tre helper esistenti (zero
   cambi di comportamento — il loop non lo chiama ancora).
3. `cargo test -p local-first-engine` verde; gateway `cargo check` verde; nessun nuovo warning.
