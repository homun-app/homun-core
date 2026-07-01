# Agent Loop — come funziona OGGI (mappa accurata)

> Stato: 2026-06-30. Reverse-engineered da `crates/desktop-gateway/src/main.rs`
> (`stream_chat_via_openai`, ~:17897→:22990) e da `crates/orchestrator`. Questa pagina
> descrive la **realtà attuale**, incluse le **divergenze dai [capisaldi](../CAPISALDI.md)**.
> È un punto fermo: ogni modifica al loop aggiorna questa pagina + il diagramma.
> Decisione di fondo: [ADR 0016](../decisions/0016-harness-owned-task-engine-cross-model.md),
> [0018](../decisions/0018-adaptive-harness-subagents-triggers.md),
> [0020](../decisions/0020-converge-chat-loop-onto-orchestrator.md) e
> [0021](../decisions/0021-single-guarded-loop-planning-as-tool.md).

## Cosa fa

Prende un messaggio utente, sceglie e chiama strumenti (browser, sandbox, filesystem,
skill, MCP, connettori) in più round, mantiene un **piano canonico**, e produce una
risposta finale aggiornando **memoria** e **artefatti**. È il cuore operativo del prodotto.
Condiviso da chat (`generate_stream`) e canali/automazioni (`run_agent_turn`).

## Come funziona OGGI

```mermaid
flowchart TD
    REQ[Messaggio utente] --> PRIV{Privacy Guard<br/>pre-turn}
    PRIV -- "dato sensibile" --> VAULT[Commit prompt redatto +<br/>card VAULT_PROPOSE<br/>raw solo in sidecar pending]
    PRIV -- "ok" --> SEED{Piano da<br/>riprendere?}
    SEED -- "store durevole / marker" --> PLAN0[Semina piano canonico]
    SEED -- "no + flag ADR0020" --> ORCH[Planner orchestrator plan_only<br/>F1.d+F3: ora vede il browser, pianifica gli step]
    SEED -- no --> PLAN0
    ORCH --> PLAN0
    PLAN0 --> LOOP{{Round loop 0..ceiling}}

    LOOP --> GUARD[Guardie harness:<br/>budget per-step F1, wander-cap,<br/>no-progress, is_final_round]
    GUARD -- "budget/wander/repeat break" --> SYNTH
    GUARD --> CALL[Chiama modello]
    CALL --> FORK{Il modello emette tool_calls?}

    FORK -- "SI scelta MODELLO" --> DISP[Dispatch per nome tool]
    DISP --> EXEC[Esegui tool: browser / sandbox /<br/>fs / skill / MCP / connettore]
    EXEC --> PLANUPD{update_plan / step_advance?}
    PLANUPD -- si --> F2[F2 verify_step_complete:<br/>done CLAIM tenuto DOING<br/>finche non verificato]
    F2 --> MARK[PLAN streamato + upsert store durevole]
    PLANUPD -- no --> CONFIRM{write tool → conferma?}
    MARK --> CONFIRM
    CONFIRM -- "si" --> ENDC[Card conferma → fine turno]
    CONFIRM -- no --> LOOP

    FORK -- "NO scelta MODELLO" --> NUDGE{Piano ha step aperti<br/>e budget nudge?}
    NUDGE -- "si, non finale" --> DIR[Nudge direttivo 'fai lo step X' → continua]
    DIR --> LOOP
    NUDGE -- "no / risposta sostanziale" --> FINAL[Risposta finale:<br/>sanitize + collapse PLAN + Fonti → Done]

    SYNTH[Sintesi forzata no-tools:<br/>'scrivi il deliverable ORA'] --> FINAL
    FINAL --> MEM[Estrazione memoria post-turn]
```

Punti caldi (con `file:line` in `main.rs`):

- **Seed piano** (`:~18979`): prima dal **runtime-plan store durevole**
  (`load_runtime_plan_from_state`), poi dal marker `‹‹PLAN››` in contesto; opzionale
  planner orchestrator dietro `HOMUN_ORCHESTRATED_CHAT` (ADR 0020 P1).
- **Privacy Guard pre-turn**: prima del loop e prima del modello chat, classifica
  il prompt con ruolo `privacy_guard` locale (fallback deterministico). Se rileva
  dati sensibili, emette solo `VAULT_PROPOSE`, passa al frontend il testo utente
  redatto per il commit e conserva il raw in un sidecar `pending_id` consumabile
  con PIN. Il loop ReAct non parte e il raw non entra nella history del modello chat.
- **Round loop** (`:~19031`, `for round in 0..hard_round_ceiling()`).
- **Guardie harness** (deterministiche): budget per-step F1 (`rounds_since_progress`,
  `:~19042`), wander-cap (`:~19046`), no-progress identico (`:~19574`), `is_final_round`
  (`:~19186`) che **rimuove i tool** dal payload sull'ultimo round.
- **Stream live tipizzato**: `emit_stream_event` espande i vecchi delta marker in eventi NDJSON
  canonici prima di inviare il delta legacy: `activity`, `plan_update`, `reasoning`,
  `choice_prompt`, `vault_propose`, `vault_reveal`, `payment_approval`. I marker restano nel
  testo solo come compatibilità/persistenza storica; il frontend espone `CoreChatStreamEvent` e
  `listenChatStreamDelta` è una vista filtrata dei soli `delta`. I nuovi messaggi salvano anche
  `chat_messages.event_parts_json`, una proiezione derivata dei marker, così il rendering storico
  non dipende esclusivamente da regex sul testo.
- **Fork act-vs-answer** (`:~19552`): il **modello** decide se chiamare tool o rispondere.
  Punto di **massima varianza**.
- **F2 verify** (`verify_step_complete`, `:~13783`): un `done` rivendicato è tenuto
  `doing` finché un giudice LLM non lo conferma sulle evidenze `step_evidence`.
- **Nudge F5** (`:~22771`, cap `MAX_PLAN_NUDGES=8`) + **over-running guard** (`:~22782`).
- **Sintesi forzata** (`:~22907`, ramo `!final_done`).

## I DUE motori (caposaldo #5: convergere, non duplicare → oggi VIOLATO)

| | Motore #1 — produzione | Motore #2 — in convergenza (F3) |
|---|---|---|
| Dove | `stream_chat_via_openai` (`main.rs`) | `crates/orchestrator` `OrchestratorBrain` |
| Guida | **il modello** (prompt-prosa ~2000 righe) | un piano DAG tipizzato |
| Piano | `Vec<Value>` mergiato — **`merge_plan` per TITOLO** (`:~6747`) | `ExecutionPlan` con `step_id` stabili + `depends_on` |
| Esecuzione | round loop con tool inline | due path: `execute_plan` (materializza task durabili) **e** `drive` (driver sincrono in-turn + arg-fill model-fills-slot, F3) |
| Subagenti | n/d (il loop fa tutto) | durabile = `generate_json`-only; **nel driver = loop agentico bounded read/gather** (`agentic.rs`, F3.2c, validato su gemma4) |
| Uso live | tutto | planner `plan_only` semina motore #1 (ADR 0020 P1); `drive` non ancora instradato |

### Precisazione su `execute_plan` e `depends_on` (correzione 2026-06-28)

Una versione precedente di questa pagina diceva che `execute_plan` "itera lineare, **ignora**
`depends_on`". È **impreciso**: (a) `validate_plan` (`brain.rs`) rifiuta ogni piano in cui una
dipendenza non **precede** il dipendente → l'array `steps` è già in ordine topologico, quindi
l'iterazione lineare *è* un ordine valido; (b) `enqueue_step` cabla i `depends_on` come **archi del
`TaskStore`** durabile. Il gap reale **non è lo scheduler**: è che `execute_plan` **materializza
task di sfondo e ritorna** (CapabilityCall = una call immediata o enqueue; SubagentTask =
`generate_json` senza tool). Non esiste(va) un **driver sincrono di turno**.

### Il driver in-turn (F3.1/F3.2 — punto fermo testato, validato su gemma4)

`crates/orchestrator/src/driver.rs` (`drive_plan`) è il control-flow **posseduto dall'harness**:
fa un **solo passaggio in avanti** sul piano (ordine topologico garantito da `validate_plan`), e per
ogni step chiama un `StepExecutor` iniettato; un `done` lo assegna il runtime **solo dopo** lo
`StepVerifier`, mai l'auto-report del modello. Le **3 invarianti** sono per costruzione: monotonìa
(un Done non si rivede), limitatezza (un risultato per step, il piano non cresce), identità =
`step_id` (i titoli non si consultano mai). È puro → unit-testabile con fake, senza modello/SQLite.

`CapabilityStepExecutor` (`step_executor.rs`, generico su `JsonRuntime`) è l'esecutore reale dei
`CapabilityCall`: (1) risolve il tool come `validate_plan` (tolleranza #11), (2) se gli `arguments`
sono **vuoti** — il planner-seme produce la FORMA del piano, non gli args (ADR 0020 P1) — il **modello
li riempie vincolato allo schema del tool** (`fill_arguments`, constrained decoding ADR 0016 Pilastro
3; args concreti → salta la generazione), (3) esegue sul `CapabilityFacade` canonico (policy +
validazione + dispatch + audit). Il Brain espone `drive(request, plan) → DriveOutcome`.

**Step agentici (`SubagentTask`, F3.2c — `agentic.rs`, validato su gemma4):** ADR 0016 Pilastro 2
definisce DUE modalità sullo stesso grafo — *workflow* (slot-fill, il `subagents::run_generate_json`
durabile single-shot) e *agent* (uno step la cui esecuzione è un mini-loop). `run_agentic_step` è la
modalità *agent*: loop **bounded** (`MAX_AGENTIC_ROUNDS`, ultimo round forza la sintesi) in cui il
modello **sterza** (sceglie il prossimo tool read/gather o conclude) mentre l'harness possiede
l'envelope. **Due fasi per round** (cura il fallimento "invalid arguments" osservato su gemma4):
(1) scelta del tool vincolata a un **enum** dei tool gather disponibili (#6), (2) `fill_arguments`
riempie gli args vincolati allo schema di QUEL tool (riuso del meccanismo capability → caposaldo #5).
Scope **solo read/gather** (Read/Draft; le scritture restano fuori, servono single-threaded+approval).
Il `done` resta del gate verify del driver, mai dell'auto-report.

**Convergenza chiave (CORREZIONE 2026-06-28 — la direzione era invertita):** una versione precedente
diceva che il path "canonico" per il browser è il `CapabilityProvider` sul sidecar condiviso
(`call_shared_browser_sidecar`) e che la `chat_browser_call` inline di motore #1 era "la parallela da
ritirare". È **SBAGLIATO**, verificato dal vivo (vedi [browser.md](browser.md) §Divergenze e
[STATO.md](../STATO.md) sessione 5e). Il path **maturo e fedele a OpenClaw** è quello di **motore #1**:
loop osserva→agisci con **native tool-calling** (gli args li impone il provider, contro l'intero
snapshot in contesto) + le arm inline + il pannello "Computer LIVE". Il path del **drive** —
`run_agentic_step` (loop `generate_json` su un digest da 4k) — è la **REGRESSIONE**: rianima esattamente
il `RuntimeBrowserLoopPlanner`/`BrowserLoopRunner` che il codebase aveva già **ritirato** convergendo su
OpenClaw. La convergenza giusta: il drive **possiede il piano/envelope** (le 3 invarianti, quando-done,
verify) e **DELEGA l'esecuzione browser** al loop native di motore #1 — non la reimplementa. È
l'estrazione & delega (Increment B, in corso).

**Validato su gemma4:** `orchestrated_brain_drives_plan_on_gemma4` (CapabilityCall: planner→driver→
arg-fill→execute→done) e `orchestrated_subagent_gathers_on_gemma4` (F3.2c: gemma4 sceglie il tool,
riempie la query vincolata, raccoglie, sintetizza — `evidence=[gather:web_search]`). Il verticale di
motore #2 regge sul tier debole (caposaldo #2). **Residuo F3:** (a) **instradare il turno** di
`stream_chat_via_openai` sul `drive` dietro `HOMUN_ORCHESTRATED_CHAT`, validare flag-ON vs motore #1
(F3.3 — il pezzo rischioso sul path vivo); (b) ritirare `merge_plan` per-titolo e il prompt-prosa di
control-flow (F3.4); (c) estendere lo scope agentico oltre read/gather (scritture single-threaded +
approval).

## Gli strati (su cui ricostruire, bottom-up)

- **L0 — Normalizzazione I/O modello**: come ogni modello risponde → forma unica
  `{content, reasoning, tool_calls}`. Vedi [model-io.md](model-io.md). *Chiave di volta.*
- **L1 — Tool/Capability**: browser, sandbox, fs, skill, MCP, connettori — contratti
  affidabili. Vedi [browser.md](browser.md), [tools-mcp-skills.md](tools-mcp-skills.md),
  [capability-registry.md](capability-registry.md).
- **L2 — Loop di controllo**: questa pagina. Harness possiede l'envelope; inner loop
  **dovrebbe** essere libero per i capaci / scaffolded per i deboli (ADR 0018, **non
  implementato**: floor default-off).
- **L3 — Convergenza**: ADR 0020 — instradare il turno su UN motore guidato.

## Divergenze dai capisaldi (da chiudere)

- **Caposaldo #2** ("orchestrazione = proprietà dell'harness; piano non creato/seguito =
  **bug di design**"): **VIOLATO**. Il control-flow (act-vs-answer, quale tool, quando
  `done`, quando fermarsi) è del **modello**; l'harness interviene solo reattivamente.
- **Caposaldo #6** ("stato e control-flow di CODICE; identità non inferita"): **parziale**.
  `merge_plan` inferisce l'identità per **titolo** (`:~6747`) sotto la vernice `ExecutionPlan`.
- **Caposaldo #5** ("un solo motore"): **violato** — due motori coesistono.
- **ADR 0018** (inner loop tier-adattivo): **parziale, default-off**. Il meccanismo È cablato:
  `scaffold_for(turn_tier)` (`scaffold.rs`) deriva le manopole e, sotto `adaptive_floor=on`,
  **workflow_bias** rilassa la rotta (`relax_route_for_tier`) e **verify_depth** modula il gate
  F2; `format` è MOOT (chat già native tool-calling); `slot` è observe-only. **F2.1 (fatto):** la
  decisione `{tier, profilo, mode}` è persistita nel `tool_trace` (→ memoria/learning,
  `scaffold::floor_trace_for_mode`) in `shadow`|`on` — la telemetria Fase-1 prerequisito per
  accendere il floor. Resta off di default finché la eval bi-popolazione (gemma4 vs capace) non lo
  valida; e i modelli capaci ricevono ancora lo scaffolding dei deboli **finché il floor è off**.

### Conseguenze osservate (sintomi)
- "Il piano a volte parte, a volte no, lo segue e non lo segue" → creazione piano lasciata
  al modello + F2 che tiene `done`→`doing` + il deliverable esce da canali no-tools che
  **bypassano** il piano. **F2.2 (default-on, opt-out `HOMUN_PLAN_RECONCILE=0/off`):** quando
  l'over-running guard ACCETTA la risposta con l'ultimo step ancora aperto (`answer_concludes_plan`),
  l'harness riconcilia quello step a `done` + persiste (`upsert_runtime_plan_memory_from_state`),
  così il piano persistito riflette il deliverable e il turno DOPO non riprende il piano a vuoto
  (`thread_has_active_runtime_plan`). La sintesi forzata (esaurimento round) NON riconcilia: lì il
  lavoro è genuinamente incompiuto e il piano DEVE restare aperto per la ripresa. Promosso dopo
  evidenza live: risposta `.invalid` consegnata ma pannello rimasto 1/2 perché lo step finale era
  ancora `doing` nello store.
- "Stesso prompt, risultato diverso" → temp 0 senza seed (seme piccolo) **amplificato** dal
  control-flow ramificato (pianifica-o-no, profilo browser ephemeral, numero turni variabile).
- **Ripresa-piano che cicla all'infinito (F4 — gated `HOMUN_PLAN_STALL_ABORT`).** I contatori
  di recovery sono **per-turno** (`nav_failures`, `rounds_since_progress` sono `let mut` dentro il
  turno → resettati a ogni ripresa). Un piano RIPRESO dallo store (`load_runtime_plan_from_state`,
  channel/resume) riavvia il suo step corrente coi contatori a zero, quindi uno step che fallisce in
  modo deterministico (URL morto, form non riempibile) **si ritenta a ogni ripresa, per sempre**.
  Fix: un **segnale cross-turno** persistito sulla memoria del piano (`stall_turns`/`last_resume_done`,
  preservati attraverso gli upsert di mid-turno) conta le riprese che NON chiudono nessun nuovo step;
  dopo `MAX_PLAN_STALL_RESUMES` (3) l'harness **blocca** lo step stallato (`block_stalled_step`).
  Perché funzioni la terminazione: il piano si stala (stop auto-resume) quando è **`settled`** (ogni
  step `done` **o** `blocked`), non solo quando è `complete` (tutti `done`) — altrimenti uno step
  `blocked` lo terrebbe "attivo" in eterno. E `blocked` è reso **sticky** in `merge_plan` (il modello
  non può riaprirlo e ri-armare il loop). Puro+testato (`next_plan_stall`, `plan_is_settled`,
  `block_stalled_step`). **Validazione live 2026-06-29:** non promuovere ancora default-ON. Il
  tentativo con URL `.invalid` ha mostrato che il piano può essere sostituito/contaminato da un
  runtime-plan non correlato recuperato dalla memoria/recall, prima che il contatore F4 arrivi al
  log atteso. Fix successivo: i runtime-plan restano memorie `open_loop` per il lifecycle/graph,
  ma non vengono più iniettati nel briefing generico `OPEN LOOPS`; il resume passa solo dal loader
  per-thread (`runtime_plan_memory_matches`). Il wiring resta gated finché il cap `3` non viene
  riverificato live.
- **"Il modello a volte non produce la risposta" (F3-deep — cutoff/budget).** Un modello di
  ragionamento può spendere l'intero budget token a *pensare* (`finish_reason:length`, `content`
  vuoto): la frontiera canonica (`model_normalize::assistant_response`) produce allora
  `‹‹REASONING››…‹‹/REASONING››` con **body vuoto**, e il loop lo **committava** come risposta finale
  (`final_done=true`) → bolla vuota / solo-ragionamento. Fix: prima di finalizzare, se
  `answer_body_is_empty(&content)` (lo `strip_chat_markers` toglie ogni marker → resto vuoto = niente
  prosa) **e** non c'è già contenuto accumulato, si fa `break` **senza** `final_done` → scatta la
  **sintesi forzata** esistente (`!final_done`): una call no-tools con budget token FRESCO e direttiva
  "scrivi la risposta finale ORA", con la catena di fallback (`accumulated`/`last_model_error`/canned).
  `break` esce dal round-loop → la sintesi gira **una volta sola**, niente spin né contatore. Riuso del
  meccanismo esistente (caposaldo #5), non un terzo path. Puro+testato (`answer_body_is_empty`).
  Per validarlo senza introdurre un secondo path, esiste solo in debug
  `HOMUN_DEBUG_MAIN_LOOP_MAX_TOKENS`: abbassa il budget del loop principale ma NON quello della
  sintesi forzata, così il log `[answer] empty answer body (...) → forced synthesis` è esercitabile
  live in modo deterministico.
- **Marker display-only che rientrano nel contesto del modello (fix).** `build_chat_runtime_prompt`
  (`lib.rs`) rendeva la history dell'assistant nel prompt **verbatim**, marker `‹‹REASONING››`/`‹‹PLAN››`/…
  inclusi. Su un follow-up (peggio sul "Continue") un modello di ragionamento **rileggeva il proprio
  trace** e lo scambiava per testo incollato dall'utente ("il testo che hai incollato è già completo").
  I marker sono display-only (la UI li rende, i canali già li strippano via `strip_chat_markers`): non
  devono mai raggiungere il modello come contenuto. Fix: `strip_display_markers` canonico in `lib.rs`
  (gestisce anche un trace **non chiuso** da `finish_reason:length` → drop fino a fine stringa), usato in
  `normalize_context_text`; `strip_chat_markers` del gateway converge su di esso (caposaldo #5/#13). La
  ripresa-piano NON è toccata: legge `request.context` direttamente, non il prompt renderizzato.

## File chiave

- Loop: `crates/desktop-gateway/src/main.rs` → `stream_chat_via_openai`.
- Stream live: `local_first_subagents::GenerateStreamEvent`, `emit_stream_event`,
  `expand_legacy_delta_to_chat_events`, `apps/desktop/src/lib/coreBridge.ts` /
  `chatApi.ts` (`CoreChatStreamEvent`).
- Persistenza chat: `chat_messages.event_parts_json` in `crates/desktop-gateway/src/chat_store.rs`
  conserva una proiezione strutturata derivata dai marker per i nuovi messaggi.
- Piano: `runtime_execution_plan`, `merge_execution_plan`/`merge_plan`, `verify_step_complete`,
  `load_runtime_plan_from_state`, `parse_plan_marker`, `collapse_plan_markers`.
- Motore #2: `crates/orchestrator` (`brain.rs` incl. `drive`, `driver.rs` il driver in-turn +
  seam `StepExecutor`/`StepVerifier`, `step_executor.rs` `CapabilityStepExecutor`, `types.rs`,
  `planner.rs`).
