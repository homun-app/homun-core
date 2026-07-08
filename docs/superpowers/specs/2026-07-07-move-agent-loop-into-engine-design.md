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
- **5e.1+5e.2 ✅ (commit 32a93c00):** lo **split di `ctx` (Sync-unblock)**. `browser_session` — l'UNICO campo
  non-Sync di `ChatToolCtx` (i `Cell`/`RefCell` del `BrowserAutomationClient`) — tolto dalla struct; il loop
  lo possiede come locale e lo passa a `execute_browser_tool` diretto. Gli altri 8 campi browser sono Sync →
  restano (0025 li raggrupperà nel sotto-agente). Con `browser_session` fuori, `ChatToolCtx` è **`Sync`** →
  future `&ctx` condiviso è `Send` nel `tokio::spawn` → `execute_chat_tool`+`emit_approval_card` prendono
  **`&ctx`**. `execute_chat_tool` è ora la fn pura `name+args → (result, effects)`.
- **5e.3a ✅ (commit b7685f6e):** `GatewayCapabilityExecutor{ctx: &ChatToolCtx}` implementa
  `engine::CapabilityExecutor` delegando a `execute_chat_tool` (non-browser; browser resta branch separato del
  loop fino a 0025). `+ Send` aggiunto al trait. **Tutti i 5 seam hanno ora impl gateway** (ModelClient,
  EventSink, PlanProgress, CapabilityExecutor, MemoryRecallService) — port cablati, pronti per il loop-move.
  Dead-code fino a 5e.3.
- **5e.3 (la RELOCAZIONE — grande, NON completabile headless):** spostare il corpo del loop (`for round in
  0..hard_round_ceiling()`, ~860 righe) in `engine` dietro `HOMUN_ENGINE_CRATE`, parità turno-per-turno.
  **Evidenza di accoppiamento (scan del corpo loop):** chiama **decine** di helper gateway —
  `sanitize_model_text`, `replace_latest_plan_marker`, `collapse_plan_markers`,
  `append_vault_reveal_marker_if_missing`, `plan_steps_reconciled_on_delivery`, `fonti_section`,
  `extract_markers`, `end_browser_activity`, `workflow_route_blocked_tool_message`, `gateway_logs_dir`,
  `hash_hex`, … → vanno **portati nel crate o iniettati** (molti). Serve inoltre:
  - **3-way split di `ChatToolCtx`**: loop-state (piano, messages, accumulated, tool_trace, evidence, flag,
    provider) → struct engine-owned; tool-context (state, thread_id, request, read_only, autonomous, …) →
    contesto iniettato; browser-state → seam.
  - **validazione LIVE parità** turno-per-turno (query browsing tipo Polymarket) — NON esercitabile headless.
  → effort multi-sessione; da fare quando l'app è pilotabile. I 9 slice precedenti (5a→5e.3a) sono la PREP
  completa: tutti i port definiti+cablati, `ctx` Sync, chokepoint puro.
- **0025 / 5f (=inc 6):** sostituire il seam browser temporaneo con `browse(goal)` ricorsivo (il browser =
  sotto-agente che gira il loop del motore); ritirare model-switch + `try_advance_frontier` + parallela inline.

## Criteri d'accettazione 5c

1. `engine::PlanProgress` definito + esportato; mock `#[cfg(test)]` verde (usabile/mockabile).
2. `impl PlanProgress for GatewayPlanProgress` compila; delega verbatim ai tre helper esistenti (zero
   cambi di comportamento — il loop non lo chiama ancora).
3. `cargo test -p local-first-engine` verde; gateway `cargo check` verde; nessun nuovo warning.

---

## Piano d'esecuzione Punto 5 — la relocazione del corpo loop (aggiunto 2026-07-08)

Stato prep completa: `LoopState` **completamente engine-safe** (13 campi + `plan` come `Value`, 5.B1);
i 5 seam hanno impl gateway. Resta lo spostamento del corpo (`for round in 0..hard_round_ceiling()`
+ sintesi post-loop + epilogo, ~860 righe) nel crate dietro `HOMUN_ENGINE_CRATE` (default OFF).

### Interfaccia scoperta (enumerata dal codice, non speculativa)

Il corpo che si sposta usa, oltre a `LoopState` (`&mut`) e ai 5 seam:
- **`EngineTurnCtx` (read-only, engine-safe):** `thread_id`, `memory_user_message`, `memory_prev_assistant`,
  `read_only`, model-override (da `request.model`), `mode`. Piccolo: il grosso dei campi read-only del
  vecchio `ChatToolCtx` (capability_corpus, catalog_index, request, scaffold, automation ids, composio_writes)
  è usato **dentro `execute_chat_tool`** → la costruzione di `ChatToolCtx` **resta lato gateway** dentro
  `GatewayCapabilityExecutor::execute_tool`, NON entra nel corpo engine.
- **Provider binding** (`base_url`/`model`/`api_key`/`endpoint`): foldato **qui, in-context** come
  `LoopState.provider: engine::ProviderBinding` + `endpoint` (57 usi di `model` collision-prone → si
  riscrivono mentre il corpo si muove, non con un rename scoped separato).
- **Closure/port iniettati** per gli stateful non-seamed che il corpo chiama: `learn_via_service_or_inline`
  (post-turn), `gateway_logs_dir` (path), `spawn_project_graph_refresh`, `schedule_stream_registry_cleanup`,
  lifecycle browser (`store_thread_browser_session`/`end_browser_activity`/`prune_browser_history`).
- **Scalari interni al corpo** (`final_done`/`plan_nudges`/`turn_used_tools`/`memory_answer`/`last_model_error`)
  → restano **locali** dentro la fn spostata (non passano ai tool → nessuna interfaccia).
- **Helper puri**: solo `summarize_tool_action` è zero-drag (si sposta in `engine::text`); gli altri
  (`should_force_synthesis`→strip-chain, `chat_endpoint`→`is_ollama_base`, `workflow_route_blocked`→tipo
  gateway) si **iniettano**, non si spostano.

### Sequenza (behavior-preserving, gated, additiva)

1. **5.D1a — extract-to-gateway-fn:** estrarre il corpo in una `async fn run_agent_rounds(...)` **gateway-locale**
   (main.rs), passando tutte le catture come parametri. Il **compilatore enumera l'interfaccia esatta** (niente
   design speculativo). Behavior-preserving, nessun flag. Gate: check + suite.
2. **5.D1b — group the interface:** raggruppare i parametri in `EngineTurnCtx` + `&mut LoopState` + i 5 seam +
   provider + closure. Fold provider qui. Gate: check + suite.
3. **5.D1c — move to crate:** spostare `run_agent_rounds` → `engine::run_turn`, adattando i tipi al crate-boundary;
   wire dietro `HOMUN_ENGINE_CRATE` (ON→engine, OFF→copia inline). Additivo, default OFF = zero rischio produzione.
4. **PARITÀ (serve co-pilotaggio):** oracolo deterministico = **`tool_trace_dump`** (`HOMUN_TRACE_DUMP=1`, già
   costruito per QUESTA estrazione — vedi i commenti "the upcoming extraction ... visible to the oracle").
   Guidare gli stessi prompt con flag OFF poi ON, **diffare i dump** (args/result hash, acc-delta, markers,
   pending_confirm, msgs_pushed, blocked, browser_image per ogni tool-call) → identici = parità tool-dispatch.
   Più LIVE su gattino / Rust / piano-forzato / browser per delivery+sintesi+reconcile.
5. **5.D2 — flip:** default ON + ritiro copia inline, **solo con parità dimostrata**.

### Perché additivo-dietro-flag è sicuro

Finché `HOMUN_ENGINE_CRATE` è OFF il gateway usa la copia inline invariata → un bug nella copia engine non
tocca la produzione. Il commit del corpo-engine è quindi committabile anche prima della parità completa; il
rischio si materializza **solo al flip** (5.D2), gated sull'evidenza dell'oracolo + LIVE.

---

## 5.D1c — DESIGN PASS (2026-07-08, dopo slice 5b)

Il dispatch di `run_agent_rounds` è engine-safe (slice 4+5). Prima di spostare il corpo servirebbe azzerare
la superficie di **helper gateway free-fn** che il corpo ancora chiama. Ho fatto l'inventario reale
(intersezione fn-definite-nel-gateway × token-chiamati nel corpo `run_agent_rounds` 24013→24882, 869 righe).

### Scoperta che ridimensiona il lavoro

**Molta superficie è GIÀ nel crate o GIÀ dietro un seam.** I marker/text helper che l'arco temeva
(`sanitize_model_text`, `replace_latest_plan_marker`, `collapse_plan_markers`,
`append_vault_reveal_marker_if_missing`, `fonti_section`, `extract_source_urls`, `is_low_value_source_url`,
`extract_vault_reveal_marker`) sono **tutti già in `crates/engine`** (`model_normalize`/`plan`/`markers`/`text`)
→ zero lavoro al move. E `build_chat_payload`/`verify_step_complete`/`begin|end_browser_activity`/
`set_memory_workspace` compaiono **0 volte** nel corpo: già assorbiti dentro gli impl dei seam (ModelClient/
PlanProgress/BrowserExecutor). La superficie residua è piccola e localizzata.

### Inventario residuo (per bucket → decisione)

**Bucket A — PURE, da rilocare in `crates/engine`** (arg solo `str`/`Value`/primitivi/std → leaf-safe):
| fn | firma | destinazione |
|---|---|---|
| `apply_tool_effects(&mut LoopState, &mut bool, usize, ToolEffects)` | pura su tipi engine | **`impl LoopState { fn apply_effects(…) }`** |
| `prune_browser_history(&mut [Value], &BTreeSet<String>)` | pura | `engine` (mod nuovo o `text`) |
| `summarize_tool_action(&str,&str)->Option<String>` | pura | `engine` |
| `connected_capability_execution_trace_line(&str,&[(String,String,Value)])->Option<String>` | pura (tuple slice, NON CapabilityEntry) | `engine` |
| `is_browser_granular_tool(&str)->bool` / `resolve_browser_chat_tool_name(&str)->Option<&'static str>` | pure | `engine` (accanto a BrowserExecutor) |
| `should_force_synthesis_for_empty_visible_answer(&str,&str)->bool` | pura | `engine` |

**Bucket B — CONFIG, da risolvere UNA volta gateway-side → `engine::TurnConfig`** (getter senza arg che
leggono env; il leaf-crate non deve leggere l'env):
`chat_max_rounds`, `chat_browser_max_rounds`, `chat_browser_nav_cap`, `hard_round_ceiling`,
`plan_reconcile_on_delivery_enabled`, `step_verification_enabled`, `plan_autoadvance_from_evidence_enabled`,
`dump_enabled`, `verbose_debug` (+ eventuali altri `*_enabled()` interni). Env-stabili nel turno → risolti
una volta = behavior-preserving.

**Bucket C — SEAM già esistente, basta sostituire la chiamata:**
- `emit_stream_event(&tx, ev)` → `event_sink.emit(ev).await` — **solo 8 siti nel corpo** (gli emit pesanti
  sono già dentro gli impl dei seam). Il corpo tiene un `&dyn EventSink` invece di `&StreamSink`.
- `upsert_runtime_plan_memory_from_state(state, tid, plan)` → `PlanProgress::persist_plan` — 3 siti (righe
  619/701/799 del corpo).

**Bucket D — GATEWAY-shaped, serve un SEAM nuovo o iniezione:**
- `try_advance_frontier_from_evidence(&mut ls, &AppState, tid, &StreamSink, round)` — composito: internamente
  usa `verify_step_complete`(HTTP) + persist + emit → **ri-esprimere sui seam PlanProgress+EventSink**, poi
  diventa pura (ls + seam) e si sposta.
- `compact_completed_step(&reqwest::Client, &mut Vec<Value>, &mut usize)` (riga 124, F3) — è una chiamata LLM
  di sintesi-compattazione → **seam nuovo `ContextCompactor`** (impl gateway avvolge la fn attuale).
- `ollama_capabilities(&str,&str)->Option<OllamaCapabilities>` (gating vision per l'inject immagine) — tipo
  gateway → **iniettare una probe `fn(&str,&str)->bool` (vision_capable)**, non spostare la cache.

**Bucket E — BRIDGE `Value`↔`ExecutionPlan`, resta gateway** (`ExecutionPlan` vive in `crates/orchestrator`,
il leaf `engine` non può referenziarlo):
- `plan_value_from(&Value)->ExecutionPlan` + `plan_steps_reconciled_on_delivery(&ExecutionPlan,&str)->Option<Vec<Value>>`
  → **un solo metodo-seam gateway-implementato** `reconcile_on_delivery(&Value,&str)->Option<Vec<Value>>` (fa
  from_value + reconcile). Il corpo lo chiama via seam e resta ExecutionPlan-free. (Se ci sono altri usi di
  `plan_value_from` nel merge di `update_plan`, passano dallo stesso bridge.)

**Bucket F — TAIL (ultime ~40 righe, dopo riga 830): NON si sposta.** `learn_via_service_or_inline` (834),
`lock_store`+`workspace_for_thread` (856-858), `spawn_project_graph_refresh` (862) + il cleanup transport
(`tx.entry.finished`) sono coda post-turno. Decisione: **`run_turn` ritorna un `TurnOutcome`; la coda learn/
graph/transport resta in `stream_chat_via_openai`** e consuma l'outcome. In un colpo esce dal corpo movibile
tutta la superficie memory-write-back + store + graph-refresh. (`workflow_route_blocked_tool_message(route:
&CapabilityRouteDecision,…)`: il gating workflow-route va **spostato dentro il seam CapabilityExecutor/
BrowserExecutor**, che già è il chokepoint dei tool → esce dal corpo.)

### Slice plan proposto (ognuna behavior-preserving, gated, committabile; loop ANCORA nel gateway fino a .10)

1. **5.D1c.1 — `engine::TurnConfig`** (Bucket B): risolvi i getter una volta, passa la struct, il corpo legge `cfg.*`.
2. **5.D1c.2 — riloca i PURE** (Bucket A) in `engine`; `apply_tool_effects`→`LoopState::apply_effects`. Gateway li chiama via `use`.
3. **5.D1c.3 — EventSink swap** (Bucket C): gli 8 `emit_stream_event`→`event_sink.emit`; il corpo tiene `&dyn EventSink`.
4. **5.D1c.4 — plan reconcile seam** (Bucket E): fold `plan_value_from`+`plan_steps_reconciled_on_delivery` dietro `reconcile_on_delivery`.
5. **5.D1c.5 — plan-progress swap** (Bucket C+D): 3× `upsert_*`→`persist_plan`; ri-esprimi `try_advance_frontier_from_evidence` sui seam → diventa movibile.
6. **5.D1c.6 — `ContextCompactor` seam** (Bucket D): avvolgi `compact_completed_step`.
7. **5.D1c.7 — vision-probe + route-gate** (Bucket D/E): inietta la probe vision; sposta il workflow-route-block dentro il seam tool.
8. **5.D1c.8 — split del TAIL** (Bucket F): `run_turn` ritorna `TurnOutcome`; learn/graph/store/transport restano gateway-side.
9. **5.D1c.9 — trace-dump come sink iniettato** (Bucket A-debug): il record+`extract_markers`/`hash_hex` puri in engine, l'`append` file resta gateway dietro un `Option<TraceSink>` (debug-only; ammesso anche droppare-e-riaggiungere).
10. **5.D1c.10 — IL MOVE**: il corpo ora referenzia solo tipi engine + seam + `TurnConfig` + `LoopState`. **Copia** il corpo in `engine::run_turn`, tieni la copia inline gateway, il dispatch sceglie su `HOMUN_ENGINE_CRATE` (default OFF, additivo = zero rischio prod). Parità via diff `tool_trace_dump` (io guido i turni API) + LIVE (utente co-pilota delivery/sintesi/reconcile).
11. **5.D2 — flip default ON + cancella la copia inline** — SOLO con parità dimostrata, **con l'utente presente**.

### Nota sul "duplicato temporaneo" (converge-don't-duplicate)

Il passo .10 crea una copia ~860-righe (inline gateway OFF vs `engine::run_turn` ON). È il pattern sanzionato
di estrazione behavior-preserving con via-di-fuga: **dup transitorio con cancellazione già schedulata** (5.D2).
Vive solo tra .10 e .2. Se preferisci evitare del tutto il dup: le slice 1→9 rendono il move meccanico e
l'oracolo prova la parità → si può spostare senza flag (nessuna copia OFF) e affidarsi a oracolo+test+LIVE.
Trade-off: flag = zero-rischio-prod al primo atterraggio ma 860 righe duplicate per poco; no-flag = niente dup
ma nessun interruttore di sicurezza runtime. **Raccomando il flag** (coerente con la metodologia del progetto).

### Ordine di rischio/effort

Basso e puramente meccanico: .1, .2, .3, .5(swap upsert). Medio (nuovo seam ma piccolo): .4, .6, .8.
Piccolo/periferico: .7, .9. Alto (attended, LIVE): .10 e .2. Le slice 1→9 sono TUTTE behavior-preserving
col loop ancora nel gateway → validabili con la suite + `tool_trace_dump` senza co-pilotaggio; il co-pilotaggio
serve solo da .10.
