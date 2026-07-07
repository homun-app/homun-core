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

## Il nodo del 5d — e come si scioglie (la scoperta di questa sessione)

Provando a partire dal 5d è emerso un **ciclo**: per spostare il loop nell'engine (5e) ogni tool
dev'essere dietro un seam; ma `execute_chat_tool` non diventa un `CapabilityExecutor` pulito
(`name+args → risultato`, senza mutare `ctx`) **a causa del ramo browser** — dei ~54 mutamenti di
`ctx`, **~37 sono il ramo browser** (`browser_session`×14, snapshot/target×13, `browser_used`×2, e lo
**switch di modello a metà turno**, main.rs 19069–19071). E quel ramo è *proprio ciò che ADR 0025
elimina* (browse-as-recursion). Inoltre il runner sotto-agente attuale è `run_generate_json`
(forced-JSON, `crates/subagents/runner.rs:25`), **non** il loop ReAct → 0025 richiede il loop estratto
(5e). Quindi "0025 prima" è impossibile: 0025 dipende da 5e, 5e dipende dal domare il ramo browser, il
ramo browser è pulito solo da 0025.

**Si rompe il ciclo con un confine, non con una riscrittura.** Isolando il ramo browser dietro una
funzione dedicata, il *resto* di `execute_chat_tool` (~47 tool a mutazione leggera/nulla) diventa il
`CapabilityExecutor` pulito, il loop può muoversi (5e), e il ramo browser isolato è **esattamente** il
seam che 0025 sostituisce con un `browse` ricorsivo. Niente protocollo-effetti-browser usa-e-getta.

La strategia browse-as-recursion **è già decisa e scritta**: vedi
[ADR 0025](../../decisions/0025-browser-as-delegated-subagent.md) (browser = loop guardato invocato
ricorsivamente, il manager resta driver, si ritirano model-switch + `try_advance_frontier` + tool
granulari). Il suo rollout "passo 0 = estrazione motore (ADR 0024)" È questo inc 5.

## Sequenza (behavior-preserving, gated `HOMUN_ENGINE_CRATE` all'atto del 5e)

- **5c ✅:** `PlanProgress` + mock + impl-gateway. Loop invariato (adapter dead-code fino a 5e). Gate verde.
- **5d.0 ✅ (questa sessione, commit 8e0c1fd7):** estratto `execute_browser_tool` da `execute_chat_tool`
  (~850 righe, verbatim, behavior-preserving). Materializza il confine-browser: il seam che 0025 rimpiazza
  con `browse` ricorsivo, e lascia `execute_chat_tool` = i ~47 tool puliti. Gate: `cargo check` pulito +
  506/507 gateway (1 rosso `soffice` ambientale).
- **5d.1a ✅ (questa sessione, commit 6e8a97dc):** raffinato il contratto. `CapabilityExecutor::execute_tool`
  ritorna `Result<ToolOutcome, String>` (`ToolOutcome{ result, effects: ToolEffects }`). `ToolEffects` è
  radicato 1:1 nelle mutazioni `ctx` reali di `execute_chat_tool` (post-estrazione browser), mappate questa
  sessione: `append_output`→`accumulated`, `plan`, `load_tools`→`loaded_tools`/`tool_schemas`, `trace`,
  `clear_evidence`, `request_confirm`, `request_compaction`, `reset_stall_guards` (il reset di progresso-reale
  dell'arm `update_plan`). Mock+test aggiornati; nessuno implementa ancora il trait → engine-only. Gate: engine 6/6.
- **5d.1b ✅ (questa sessione, commit a5e8039d):** la conversione. `execute_chat_tool` ritorna
  `(String, ToolEffects)`; gli arm non-browser scrivono nel buffer `effects`, il call site applica con
  `apply_tool_effects(&mut ctx, effects)` subito dopo. **Behavior-preserving per costruzione**; completezza
  verificata da compiler + grep (zero mutazioni `ctx` residue in `execute_chat_tool`). Note chiave:
  - **`merge_execution_plan(ctx.plan)` mutava in place** (mutazione nascosta che uno scan iniziale aveva
    perso!) + `*ctx.plan` accumulatore riletto → entrambi su un **`current_plan` locale**; `effects.plan`
    porta l'**intero piano serializzato** (route/steps/…) round-trip via serde in `apply` — NON solo gli
    step (`ExecutionPlan` ha route/direct_answer/plan_propose/needs_more_tools; rebuild-da-step li perderebbe
    nel path senza-verifica).
  - reset F1 (`progress_anchor_round`/`repeat_count`/`last_round_sig`) + compaction F3 + `clear_evidence`,
    idempotenti per-step, **issati** a un solo `if any_verified` come effetti.
  - i 2 helper deck (`emit_rendered_deck_artifacts`, `ctx.accumulated` by-ref) appendono a un buffer locale
    poi confluito in `effects.append_output`. `LoadedTool.schema` = `Option` (un connector può marcare la key
    loaded senza schema).
  - **Gate:** `cargo check` pulito (nessun nuovo warning, 42 baseline) + engine 6/6 + gateway 506/507
    (1 rosso `soffice` ambientale) + tutti i test plan/merge/step verdi. **Caveat:** rilocazione
    behavior-preserving, ma **validazione LIVE del plan-engine** ancora consigliata quando l'app è pilotabile
    (i test coprono poco l'avanzamento piano) — non esercitabile headless.
  - **Nota:** `execute_chat_tool` tiene ancora `&mut ctx` solo per delegare a `execute_browser_tool` (il seam
    browser temporaneo, 5d.2); i suoi arm non toccano più `ctx`.
- **5d.2 ✅ (questa sessione, commit df5ba8d4):** dispatch browser spostato **fuori** da `execute_chat_tool`,
  al call site del loop (`is_browser_granular_tool(name)` → `execute_browser_tool`, il seam `&mut ctx`
  temporaneo, che muta ancora `ctx` diretto e confluirà nell'impl `CapabilityExecutor` — col model-switch
  come effetto — a 5e/0025). Convertito anche `emit_approval_card` (helper che lo scan di 5d.1b aveva perso:
  mutava `accumulated`/`pending_confirm`) → effetti; scoperto dal **compiler** tentando `&ctx`. Ora
  `execute_chat_tool` + `emit_approval_card` hanno **0 mutazioni `ctx`**.
  - **⭐ SCOPERTA che vincola 5e:** `execute_chat_tool` **non può ancora prendere `&ctx`**. `ChatToolCtx`
    non è `Sync` (i `Cell`/`RefCell` della browser session), e una future con `&ctx` condiviso non è `Send`
    dentro il `tokio::spawn` del loop (`&mut T` è Send se `T:Send`; `&T` richiede `T:Sync`). Quindi il
    `CapabilityExecutor` **`&self` pulito è bloccato** finché lo stato browser non lascia `ctx` (0025 / lo
    **split di `ctx`** a 5e: loop-state→engine, tool/browser-state→executor gateway). `&mut ctx` tenuto solo
    per `Send`; gli arm non lo mutano.
- **5e:** spostare il corpo del loop in `engine` dietro `HOMUN_ENGINE_CRATE`, parità turno-per-turno; il loop
  consuma i port (`ModelClient`/`CapabilityExecutor`/`EventSink`/`MemoryRecallService`/`PlanProgress`) + il
  seam browser temporaneo. **Prerequisito emerso da 5d.2:** lo **split di `ChatToolCtx`** — i campi loop-state
  (piano, accumulated, tool_trace, evidence, flag…) vanno al motore; i campi browser/tool-state (browser
  session non-Sync, ecc.) restano nell'impl gateway del `CapabilityExecutor`. È lo split che rende il
  loop-state `Sync`/iniettabile e sblocca il `&self`.
- **0025 / 5f (=inc 6):** sostituire il seam browser temporaneo con `browse(goal)` ricorsivo (il browser =
  sotto-agente che gira il loop del motore); ritirare model-switch + `try_advance_frontier` + parallela inline.

## Criteri d'accettazione 5c

1. `engine::PlanProgress` definito + esportato; mock `#[cfg(test)]` verde (usabile/mockabile).
2. `impl PlanProgress for GatewayPlanProgress` compila; delega verbatim ai tre helper esistenti (zero
   cambi di comportamento — il loop non lo chiama ancora).
3. `cargo test -p local-first-engine` verde; gateway `cargo check` verde; nessun nuovo warning.
