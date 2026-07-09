# Ledger — Stato reale del sistema Homun (`app/`)

> **Audit di riconciliazione e convergenza — FASE 1 (inventario grounded, sola lettura).**
> Scopo: sciogliere il groviglio "cosa è davvero vivo?" prima della presentazione (fra ~10 giorni).
> Questo documento è il **registro**; le decisioni LAND/KILL/KEEP sono di Fabio (Fase 2).

- **Data:** 2026-07-09
- **Commit HEAD analizzato:** `65291162` (`fix(router): plan/research first-turn prompts take plan precedence over one-shot workflow routing`)
- **Branch di lavoro:** `fix/workflow-route-plan-precedence` (tree pulito). NB: **non** `main` — la linea ADR 0024/0025-completa + il fix router vivono qui.
- **Metodo:** 6 subagent read-only in parallelo su domini indipendenti (flag; engine/browse/orchestrator; memory/sandbox/broker; router/tier; drift STATO+architecture; dead-code+ADR-status), poi **verifica personale via grep** dei claim ad alto impatto. Ogni riga cita `file:line` reale. Dove non verificato → "NON VERIFICATO".
- **Convenzione verdetti:** `vivo` / `dietro-flag(default=X)` / `mezzo-fatto` / `morto` / `doc-stale`.
- `main.rs` = `crates/desktop-gateway/src/main.rs` (**59.585 righe**).

---

## 0. Sommario esecutivo (le verità che contano)

1. **Il motore È convergiuto.** Il loop agentico (motore #1, ADR 0021) vive **solo** in `crates/engine/src/agent_loop.rs:129` (`run_turn`); `run_agent_rounds` (`main.rs:24231`, ~114 righe) lo chiama **incondizionatamente** (`main.rs:24315`). `grep 'for round in 0..' main.rs` = **0** (nessuna copia inline). ADR 0024 è **fatto**, non "Proposed". ✅
2. **Il browser È convergiuto.** Il manager offre **un solo** `browse(goal)` (`main.rs:23393`); i 6 tool granulari vivono solo nel sotto-turno ricorsivo (`GatewayBrowseExecutor` → `run_turn` a `main.rs:22436`). Il model-switch mid-turn è cancellato. ADR 0025 è **fatto**, non "Proposed (non iniziato)". ✅
3. **I 3 flag "da cancellare a regime" sono cancellati dal codice** (`HOMUN_ENGINE_CRATE`, `HOMUN_CHAT_BROWSE_SUBAGENT`, `HOMUN_TURN_BROKER` = 0 letture `env::var`). Restano solo **4 doc-comment stantii** che descrivono `HOMUN_ENGINE_CRATE` come vivo. 🧹
4. **La confusione residua è scaffolding non rimosso**, non doppio-motore: doc-comment ghost, status ADR mai aggiornati, e la doc `architecture/*` congelata al **2026-07-06** (pre-0024/0025).
5. **"Shipped" ≠ "attivo di default".** Quattro sottosistemi sono **codice presente ma dietro flag default-OFF**: memory-service, memory-pool, **sandbox (ADR 0023)**, adaptive-floor (ADR 0018). Out-of-the-box, l'esecuzione tool sul progetto reale è **non sandboxata**. Questa è la voce più delicata per una presentazione onesta.
6. **L'unico vero "secondo motore" è `crates/orchestrator`**, e la parte drive-as-chat è **dormiente dietro 2 flag default-OFF** legati ad **ADR 0020 (superseded)** → candidato KILL. Ma il crate **non è morto**: `ExecutionPlan` (plan data-model) e `OrchestratorBrain::plan_only` (planner dei deliverable `make_deck`/`make_document`) girano **senza flag**. Kill mirato, non del crate.
7. **Il router ONORA il CAPISALDO #7** (routing primario = BM25 su un unico corpus registry, `capabilities/src/search.rs:45`). Un solo watch-item: `atomic_pdf_operation_reason` (`main.rs:8130`) è un classificatore keyword che pre-empta il registry per la sola classe PDF (prefilter difendibile, non verità primaria generale).
8. **Debito CAPISALDI:** il #6 ("il modello riempie **slot vincolati**; output strutturato **imposto**") è in tensione col reale — la chat usa **native tool-calling**, e il knob `format: ForcedGrammar` **non ha consumatori** (ADR 0021 ha emendato la tesi slot-filling di 0016/0019).

---

## 1. Census dei flag / toggle `HOMUN_*` (il cuore della confusione)

### 1a. Flag COMPORTAMENTALI (verdetto-critici)

| Flag | Default | Cosa gate (file:line) | Verdetto | Note |
|---|---|---|---|---|
| `HOMUN_BRAIN_MATERIALIZE` | **ON** | read `main.rs:38824`; caller `main.rs:2461` (`create_task_from_chat_message`) | **vivo** | Materializza task via `OrchestratorBrain`. |
| `HOMUN_SEMANTIC_ROUTER` | **ON** | `main.rs:39845` | **vivo** | `=0` → router euristico cheap. |
| `HOMUN_VERIFY_STEPS` | **ON** | read `main.rs:14253`; callers `21145`,`24154` | **vivo** | F2 step-verification. |
| `HOMUN_PLAN_RECONCILE` | **ON** | read `main.rs:6367` | **vivo** | Reconcile step aperto→done alla consegna. |
| `HOMUN_PLAN_AUTOADVANCE` | **ON** | `main.rs:6378` | **vivo** | Auto-advance frontiera su evidenza verificata. |
| `HOMUN_TASK_EXECUTOR_WORKER` | **ON** | `main.rs:32031` | **vivo** | Worker del task-runtime. |
| `HOMUN_BROWSER_HEADLESS` | **ON** | `main.rs:46122` | **vivo** | `=0` mostra la finestra browser. |
| `HOMUN_MEMORY_SERVICE` | **OFF** | read `main.rs:6385`; caller `811` | **dietro-flag(OFF)** | ADR 0022 T1. Sceglie **service-object vs costruzione inline delle STESSE fn del crate** — il path OFF già usa le fn del crate. Scaffold transitorio (STATO dice "done" ma non flippato). |
| `HOMUN_MEMORY_POOL` | **OFF** | `crates/memory/src/store.rs:63` | **dietro-flag(OFF)** | ADR 0022 T2. OFF → `Single(Mutex<Connection>)` legacy; ON → pool WAL reader/writer. Scaffold transitorio. |
| `HOMUN_TOOL_SAFETY` | **OFF** | `main.rs:18773` (`== Ok("1")`); enforcement `12200`, approval `21858`/`21973`, assess `19734` | **dietro-flag(OFF)** | **ADR 0023.** Default OFF ⇒ `run_in_project` esegue **non sandboxato** sul progetto reale + approval legacy. "behavior-preserving until flipped". |
| `HOMUN_ADAPTIVE_FLOOR` | **OFF** (`off`/`shadow`/`on`) | read `main.rs:14267`; env override; caller `22570` | **dietro-flag(OFF)** | **ADR 0018.** OFF ⇒ tier calcolato ma **non modula nulla**. Vedi §2. |
| `HOMUN_PLAN_STALL_ABORT` | **OFF** | read `main.rs:6343`; caller `23822` | **dietro-flag(OFF)** | F4 abort su stallo; "ships gated… flip on to validate". Scaffold. |
| `HOMUN_ORCHESTRATED_CHAT` | **OFF** | `orchestrated_chat_enabled()` `main.rs:38842`; caller `23782` | **dietro-flag(OFF)** ⚠️ | **ADR 0020 (SUPERSEDED by 0021).** Semina piano via `OrchestratorBrain` dormiente. Scaffold di un motore ritirato. |
| `HOMUN_DRIVE_CHAT` | **OFF** | `drive_orchestrated_chat_enabled()` `main.rs:38976`; caller `23898` | **dietro-flag(OFF)** ⚠️ | **ADR 0020 (SUPERSEDED).** Routing del DRIVER (`drive_plan` a `39321`). Secondo motore, fail-open al loop. |
| `HOMUN_ZAI_THINKING` | OFF | `main.rs:14943` | dietro-flag(OFF) | Riabilita GLM "thinking" (off evita empty-content). |
| `HOMUN_COMPOSIO_DENSE` | OFF | `main.rs:18527` | dietro-flag(OFF) | Re-rank denso opzionale del catalogo Composio. |
| `HOMUN_STREAM_LEGACY_MARKER_DELTAS` | OFF | `main.rs:30649` | dietro-flag(OFF) | Re-emette delta marker raw legacy. |
| `HOMUN_INFERENCE_CLOUD` | OFF | `main.rs:41200` | dietro-flag(OFF) | `cloud_flag` in `resolve_active_model`. |
| `HOMUN_BROWSER_ISOLATED_CONTEXT` | OFF | `main.rs:46801` | dietro-flag(OFF) | Context browser freddo/isolato (warm shared è default). |
| `HOMUN_CONTAINED_COMPUTER`/`_CDP` | OFF (on-host) | `main.rs:46214`/`46213` | dietro-flag(OFF) | ADR 0010, browser in container. |
| `HOMUN_ADDONS` | OFF | `main.rs:11199` | dietro-flag(OFF) | Abilita addon. |
| `HOMUN_ELECTRON_DEVTOOLS` | OFF (packaged) | `electron/main.cjs:458` | dietro-flag(OFF) | Forza DevTools nei build pacchettizzati. |
| `HOMUN_ENGINE_CRATE` | — | **solo doc-comment**: `engine/src/{lib.rs:11, agent_loop.rs:10;126, loop_state.rs:6}` | **morto** | **0 letture `env::var`.** Flag cancellato (5.D2). Restano 4 `//!`/`///` che lo descrivono ancora "default OFF" + "inline copy". → scrub. |
| `HOMUN_CHAT_BROWSER_GRANULAR` | — | solo commento `main.rs:18886` | **morto** | Nome citato in un commento, nessun `env::var`. Superato da 0025. |
| `HOMUN_BROWSER_PARALLEL` | — | solo commento `main.rs:46800` | **morto** | Il gate reale è `HOMUN_BROWSER_ISOLATED_CONTEXT`. |

> **Config knobs (numerici/path/DB/provider):** ~70 flag `HOMUN_*` aggiuntivi sono **vivo (config)** — timeout, path dati/DB, binari, identità, provider/model. Non verdetto-interessanti (cambiano comportamento con un default sano). Elenco completo nel raw dell'agente-flag; qui omessi per concisione. I default numerici esatti di alcuni (tick proattivo, cooldown, ecc.) sono **NON VERIFICATO** ma verdetto-irrilevanti.

### 1b. Conferma dei flag "cancellati a regime"

| Flag | Letture `env::var` | Refs residui | Stato |
|---|---|---|---|
| `HOMUN_ENGINE_CRATE` | **0** | 4 doc-comment (engine crate) | ✅ cancellato come flag; **scrub commenti dovuto** |
| `HOMUN_CHAT_BROWSE_SUBAGENT` / `browse_subagent_enabled` | **0** | **0** | ✅ completamente rimosso |
| `HOMUN_TURN_BROKER` / `turn_broker_enabled` / `broker_enabled` | **0** | 1 nota storica in `scripts/test-turn-broker-e2e.py:85` | ✅ rimosso dal codice |

### 1c. Scaffold transitori lasciati indietro (candidati pulizia)

1. `HOMUN_ORCHESTRATED_CHAT` + `HOMUN_DRIVE_CHAT` — macchinario **ADR 0020 (superseded)**, ancora cablato (`23782`/`23898`) su orchestrator dormiente. **Debito "converge, don't duplicate".**
2. `HOMUN_MEMORY_SERVICE` / `HOMUN_MEMORY_POOL` — migrazione ADR 0022 mai flippata (default OFF).
3. `HOMUN_TOOL_SAFETY` — ADR 0023 "shipped" ma default OFF ("behavior-preserving until flipped").
4. `HOMUN_PLAN_STALL_ABORT` — "ships gated… flip on to validate".
5. Ghost solo-commento: `HOMUN_ENGINE_CRATE`, `HOMUN_CHAT_BROWSER_GRANULAR`, `HOMUN_BROWSER_PARALLEL`.

---

## 2. Archi mezzo-atterrati — stato reale vs dichiarato

| Arco | Dichiarato | Reale (codice) | Verdetto |
|---|---|---|---|
| **Estrazione motore (ADR 0024)** | STATO: COMPLETO; **ADR header: "Proposed"** | `engine::agent_loop::run_turn` (`agent_loop.rs:129`) unico loop; `run_agent_rounds` thin (`main.rs:24231`, ~114 righe) chiama incondizionatamente (`24315`); `for round` in main.rs = 0; `HOMUN_ENGINE_CRATE` env-read = 0 | **vivo** (STATO ok; **ADR status doc-stale**) |
| **Browse-as-recursion (ADR 0025)** | STATO: COMPLETO; **ADR header: "Proposed (non iniziato)"** | un solo `browse_tool_schema()` al manager (`23393`); sub-turno ricorsivo `GatewayBrowseExecutor→run_turn` (`22436`); `BrowseOnlyCapabilityExecutor` (`22470`); model-switch cancellato (`18901-18904`); flag env-read = 0 | **vivo** (STATO ok; **ADR status doc-stale**) |
| **Memory service (ADR 0022 Tappe)** | T1/1.5/2/4 "done"; T3 "remain" | Crate reale e non-triviale (`service.rs`539 / `recall.rs`492 / `learn.rs`1095 / `consolidate.rs`717 / `embedding.rs`127); vecchie fn `relevant_memory_for_prompt`/`learn_from_exchange` **cancellate** da main.rs; **entrambi i path (ON/OFF) usano le fn del crate**. Flag T1/T2 default **OFF**. | **mezzo-fatto** (estratto e convergente, ma non attivo di default) |
| **↳ Tappa 3 (recall on-demand)** | STATO: "remain" | Tool **`recall_memory` GIÀ ESPOSTO** al modello: schema `5803`, in `CORE_TOOL_NAMES` `18357`, in `base_tools` `23395`, dispatch `20915`→ ma chiama la fn gateway-inline `recall_memory` (`13073`), **non** `MemoryRecallService` | **mezzo-fatto / doc-stale** — il tool **spedisce**; resta la convergenza sul service + cleanup dead-fn |
| **Sandbox (ADR 0023)** | CLAUDE.md/STATO: "shipped"; **ADR header: "Proposed"** | `mod seatbelt`(macOS)/`landlock_fence`(Linux) cablati; `build_sandbox_command` (`12081`/`12103`); gate `sandboxed = tool_safety_enabled() && (macos||linux)` (`12199`). **Default OFF ⇒ host exec non sandboxato.** | **dietro-flag(OFF)** (codice presente e fail-closed; **non attivo di default**; ADR status stale) |
| **Turn-queue broker** | STATO: flag collassato, broker unico path | route `/api/chat/turns*` + `/api/ws` montate **incondizionatamente** (`1317-1334`); `turn_broker_enabled` = 0 refs; route NDJSON-diretta legacy **rimossa** (NDJSON sopravvive solo come body replay `…/turns/{id}/stream` + mirror WS) | **vivo** (STATO accurato) |
| **Adaptive floor (ADR 0018)** | "floor uniforme oggi; ModelTier non raggiunge lo scaffolding" | `ModelTier` calcolato (`22567`) → `scaffold_for(turn_tier)` (`22568`, `scaffold.rs`). Knob `workflow_bias` (consumato `23273`) e `verify_depth` (`21147`) **branchano davvero, MA solo se `floor_acting` (mode==on)**. Default `off` (`26918`) ⇒ non modula nulla. Knob `slot`/`format` **senza consumatore** (dead surface anche a floor ON). | **dietro-flag(OFF)** + sotto-parti **morte** (slot/format) |
| **`crates/orchestrator` (post-0021)** | dormiente | dep del gateway (`Cargo.toml:32`). **Split** (vedi §3b): drive-as-chat dormiente (KILL); `ExecutionPlan` + `plan_only` vivi senza flag (KEEP) | **mezzo-fatto** (secondo motore dormiente; crate non morto) |
| **Branch `feat/working-island-redesign`** | memoria: DEFERRED, altra sessione (`task_58afe482`) | branch separato (`86981a06 feat(island): header kebab menu…`), non fuso nella linea corrente | **fuori-scope** (non deciso; non verificato in profondità in questo pass) |

---

## 3. Codice morto / superato / duplicato

### 3a. File oltre i limiti (soft ~1500 / hard ~2500)

| File | Righe | × oltre hard |
|---|---|---|
| `crates/desktop-gateway/src/main.rs` | **59.585** | ~24× |
| `apps/desktop/src/components/ChatView.tsx` | **9.530** | ~3,8× |
| `apps/desktop/src/components/SettingsView.tsx` | **6.857** | ~2,7× |
| `apps/desktop/src/lib/coreBridge.ts` | **4.417** | ~1,8× |
| `crates/desktop-gateway/src/chat_store.rs` | **4.294** | ~1,7× |

Soft-breach (1500–2500): `memory/src/store.rs` (2148), `Sidebar.tsx` (1614), `App.tsx` (1596). **Deadline-aware: nessuno split rischioso ora** — sono debito noto, non target di questa fase.

### 3b. `crates/orchestrator` — lo split (la voce sfumata)

| Uso | Evidenza | Verdetto | Azione |
|---|---|---|---|
| **`ExecutionPlan` (plan data-model)** | bridge `runtime_execution_plan` (`6464`), `plan_value_from` (`6460`), `merge_execution_plan` (`6544`); resume `ls.plan = to_value(...)` (`23882`), **prima di ogni flag** | **vivo** (senza flag) | **KEEP** |
| **`OrchestratorBrain::plan_only` (planner deliverable)** | `run_static_workflow_plan_through_brain` (`8035`) → `.plan_only` (`38947`), chiamato da `make_deck` (`20359`,`20704`) in `execute_chat_tool` | **vivo** (senza flag) | **KEEP** |
| **Driver engine (`drive_plan`/`run_agentic_step`/`StepExecutor`)** | `orchestrator_drive_for_chat` (`39219`)→`drive_plan` (`39321`), reached solo da `23930` dietro `HOMUN_DRIVE_CHAT` (default OFF). `.drive()` a `52248`/`52391` sono `#[test]` | **morto** (dormiente, ADR 0020 superseded) | **KILL** (path + 2 flag) |

**Net:** kill mirato del wiring drive-as-chat + i 2 flag; il crate resta per plan-type + planner. (O, a regime, estrarre quei due pezzi e poi rimuovere il crate — ma è refactor, **non** per questa fase.)

### 3c. Altri candidati dead-code

| Item | Evidenza | Verdetto | Azione |
|---|---|---|---|
| `#[allow(dead_code)]` stantii su executor **vivi** | `GatewayCapabilityExecutor` (`22093`, costruito `24270`), `GatewayBrowserExecutor` (`22192`, costruito `22406`/`24293`) — commento "until the crate move wires it in" | **mezzo-fatto** (annotazione stale su codice vivo) | **KILL** annotazione + commento |
| Doc-comment `HOMUN_ENGINE_CRATE` | `engine/agent_loop.rs:10;126`, `loop_state.rs:6`, `lib.rs:11` | **morto** (doc drift) | **KILL/riscrivi** |
| Loop browser `generate_json` ritirato | `browser-automation/src/browser_loop.rs` (494 righe) + `BrowserLoopRunner`; non cablato (solo commento `main.rs:26060`); ADR 0006 lo dà RITIRATO | **morto** (dal path chat) | **KILL candidate** (verifica assenza altri consumer; c'è un test 545-righe) |
| Piccoli helper inutilizzati | `memory/learn.rs:590` `_cosine_link`; `process-manager/supervisor.rs:71`/`66`; `subagents/capability_bridge.rs:113`; `main.rs:9439` `schedule_proactive_task`; `task-runtime/store.rs:1098` `table_exists` | **morto** | **KILL** (basso valore singolo) |

**Sweep "converge, don't duplicate":** loop agentico = nessun duplicato ✅ · model call = singola giuntura `ModelClient` ✅ · memory store = singolo `MemoryFacade`, nessuno store parallelo ✅ · **unico secondo-motore residuo = `crates/orchestrator` drive** (§3b).

---

## 4. Drift doc ↔ codice

### 4a. `architecture/*` (congelate al 2026-07-06, pre-0024/0025)

Un errore ripetuto — **"`crates/engine` non esiste"** — è copiaincollato in **6 doc**, tutti ora falsi: `system-map.md:3;22;229`, `capability-registry.md:11`, `plugins.md:17`, `connectors-composio.md:13`, `agent-loop.md:14;19`.

- **`agent-loop.md` (PRIME):** "estrazione loop… `crates/engine` NON esiste ancora / Proposta" (`:13-14`,`:204-205`,`:219`); "il loop è `stream_chat_via_openai` in main.rs" (`:16-19`); "`turn_broker_enabled()`" vivo (`:33`,`:301`); `MAX_PLAN_NUDGES` in main.rs (`:126`, ora in `engine/agent_loop.rs:35`). **Tutto pre-0024.**
- **`browser.md` (PRIME):** presenta i **6 tool granulari come superficie del manager** (`:32-34`,`:148-159`) — ora è **un solo `browse(goal)`** (`main.rs:23393`); "loop browser guidato dal loop unico in main.rs" (`:11-14`) — ora sotto-turno ricorsivo isolato (`22355`+); model-switch implicito come corrente. Metà sidecar (`runtimes/browser-automation`) è **ancora accurata**.
- **`model-io.md:302`** punta a `crates/desktop-gateway/src/model_normalize.rs` — **file inesistente** (spostato in `crates/engine/src/model_normalize.rs`). "cablaggio IN CORSO (F0)" (`:191`) stale.
- **`system-map.md`**: motore "in main.rs (`run_agent_turn_into_message`)" → nodo Engine va a `crates/engine`.
- **`contacts-channels.md:117;369`**: `turn_broker_enabled()` (default ON) — fn eliminata (broker incondizionato).
- **`overview.md:29`**: nodo "ADR 0016 · output IMPOSTO" — superato da 0021 (native tool-calling). Basso impatto (ha già un disclaimer parziale).
- **NON VERIFICATO body-level:** `memory.md`, `mcp.md`, `skills.md`, `vault.md`, `desktop-shell.md` (solo header controllati; sottosistemi ortogonali a 0024/0025).

### 4b. `STATO.md`

- `Ultimo aggiornamento: 2026-07-08` (`:6`) contraddice il corpo con contenuto 2026-07-09 → bump a 2026-07-09.
- HEAD `65291162` non riflesso (atteso per doc vivo).
- Corpo `:90-220` narra ancora `HOMUN_ENGINE_CRATE` come flag default-OFF vivo, contraddicendo la cima (`:8-17`). Narrativa-changelog residua → trim in `archive/`.

### 4c. Status ADR (verità: molti "Proposed" mentre il codice ha spedito)

| ADR | Header | Realtà | Azione |
|---|---|---|---|
| **0008** orchestrator-brain | **Accepted** | direzione chat **REVERSED da 0021** (drive dietro flag default-OFF) | **marcare EMENDATA/SUPERSEDED-parziale da 0021** (come 0016/0020) |
| **0019** model-output-normalizer | **Proposed** | **IMPLEMENTATO & LIVE** (`engine/model_normalize.rs`, `markers.rs`; usato in `agent_loop.rs`) | **status → Accepted/Implemented** |
| **0023** sandbox + unified approval | **Proposed** | **IMPLEMENTATO dietro `HOMUN_TOOL_SAFETY` (default OFF)** | **status → Accepted (dietro flag)** |
| **0024** engine-extraction | **Proposed** | **COMPLETO** (loop unico, no flag) | **status → Accepted/Implemented** |
| **0025** browser-as-subagent | **Proposed (non iniziato)** | **COMPLETO** (`a183a736`) | **status → Accepted/Complete** |
| 0016 | EMENDATA da 0021 ✅ | ok | — |
| 0018 adaptive-harness | Proposed | parzialmente realizzato, floor default-off | minor / decidere (vedi §2) |
| 0020 | SUPERSEDED da 0021 ✅ | ok | — |
| 0006 openclaw | Accepted + nota "parz. stale" | loop `generate_json` ritirato | adeguatamente marcato |
| 0001–0005,0007,0009–0015,0017,0021,0022,0026 | vari | coerenti | — |

> Regola: aggiornare lo **Status** di un ADR implementato (Proposed→Accepted) è lecito. Marcare `SUPERSEDED` un ADR superato è lecito. **Il corpo/decisione di un ADR non si riscrive.**

### 4d. CAPISALDI — affermazioni che il codice ha superato/emendato (proposte, 1 per 1)

| # | Caposaldo | Tensione col codice | Proposta |
|---|---|---|---|
| **#6** | "il modello riempie **slot vincolati**… **Output strutturato imposto** dove il backend lo supporta" | La chat usa **native tool-calling**; il knob `format: ForcedGrammar` **non ha consumatori** (`scaffold.rs`, nessun uso); ADR 0021 ha emendato la tesi slot-filling di 0016/0019 (forzare JSON danneggia i modelli deboli) | **Emendare**: distinguere *parsing tollerante + native tool-calling* (reale) da *output forzato* (ritirato per la chat). Le 3 invarianti del piano (monotonìa/limitatezza/identità) **restano valide**. |
| **#5** | "Un solo motore / un solo grafo / un solo store… convergere, non duplicare" | Vero per engine/memory; **eccezione viva** = `crates/orchestrator` drive dormiente (secondo motore reachable-by-flag) | Nessuna modifica al caposaldo; **è il target della decisione KILL** in §3b (il caposaldo *chiede* quella pulizia). |
| **#2** | "…(ADR 0016)" come autorità | 0016 emendato da 0021 | Aggiornare il riferimento a "ADR 0016 **come emendato da 0021**". |
| #7 | routing da registry unico, non keyword | **ONORATO** (BM25 su corpus unico); watch-item `atomic_pdf_operation_reason` | Nessuna modifica; annotare il watch-item. |
| #1,#3,#4,#8–#13 | — | coerenti col codice per quanto verificato | — |

---

## 5. Raccomandazioni per FASE 2 (decide Fabio, item per item)

> Legenda: **LAND** = finire + accendere + togliere il flag · **KILL** = rimuovere codice + flag (+ marcare ADR) · **KEEP** = documentare onestamente come WIP con stato esplicito.

**A. Pulizia a rischio ~zero (raccomando LAND/KILL, quick win, deadline-friendly)**
- A1. Scrub 4 doc-comment `HOMUN_ENGINE_CRATE` + `#[allow(dead_code)]` stantii sugli executor vivi → **KILL**.
- A2. Rimuovere ghost solo-commento `HOMUN_CHAT_BROWSER_GRANULAR`, `HOMUN_BROWSER_PARALLEL` → **KILL**.
- A3. Status ADR 0019/0023/0024/0025 Proposed→Accepted; 0008 marcata emendata-da-0021 → **doc reconciliation**.
- A4. Riconciliare `architecture/agent-loop.md` + `browser.md` + i 6 "crates/engine non esiste" + `model-io.md:302` + `contacts-channels.md` → **doc reconciliation** (alto valore per la presentazione).
- A5. STATO.md: bump data, trim narrativa-changelog residua → **doc reconciliation**.

**B. Convergenza secondo-motore (raccomando KILL mirato)**
- B1. `HOMUN_ORCHESTRATED_CHAT` + `HOMUN_DRIVE_CHAT` + wiring `orchestrator_*_for_chat`/`drive_plan`-da-chat → **KILL**; **KEEP** `ExecutionPlan` + `plan_only` (make_deck). Marca ADR 0008 di conseguenza. *(Nota: comporta rimozione codice — approvare esplicitamente.)*

**C. Flag "shipped ma OFF" (decisione di prodotto — raccomando per ognuno)**
- C1. **`HOMUN_TOOL_SAFETY` (sandbox, ADR 0023)** — la più importante per una demo onesta. Opzioni: **LAND** (flip ON + validazione, così l'exec è sandboxato di default) *oppure* **KEEP** (documentare che il sandbox è opt-in). Raccomando **LAND con validazione** se il tempo lo consente, altrimenti KEEP dichiarato.
- C2. `HOMUN_MEMORY_SERVICE` — path OFF già usa le fn del crate ⇒ rischio basso. Raccomando **LAND** (flip ON) o **KEEP** documentato.
- C3. `HOMUN_MEMORY_POOL` — WAL, più delicato. Raccomando **KEEP** (soak) o LAND con test di concorrenza.
- C4. `HOMUN_ADAPTIVE_FLOOR` (ADR 0018) — **LAND parziale**: default `on` del solo `workflow_bias` per tier Reasoning (smette di forzare i modelli capaci nel box one-shot `make_deck`); **KILL** i knob morti `slot`/`format`. Oppure **KEEP** documentato. *(Serve un ADR nuovo breve: policy adaptive-floor per tier.)*
- C5. `HOMUN_PLAN_STALL_ABORT` — **KEEP** (WIP dichiarato) o LAND dopo validazione.
- C6. Tappa 3 memory: il tool `recall_memory` è vivo → **KEEP** dichiarando "tool live, convergenza sul service pendente", oppure LAND la convergenza (routing via `MemoryRecallService`).

**D. Fuori scope per questa fase**
- D1. Split file oltre-limite (main.rs, ChatView.tsx, …) → **KEEP** come debito noto (niente refactor pre-presentazione).
- D2. `browser_loop.rs` ritirato → **KILL candidate** dopo sweep consumer (basso rischio, ma verificare).
- D3. Branch `feat/working-island-redesign` → decisione separata (DEFERRED).

---

## 6. NON VERIFICATO (onestà sull'incertezza)

- **Comportamento a runtime**: pass statico read-only; nessun `cargo build`/turno eseguito. I verdetti riflettono il *sorgente*, non l'esecuzione (es. che i branch `HOMUN_DRIVE_CHAT`/`adaptive-floor=on` producano l'effetto atteso).
- **"~609 righe rimosse"** (memory) non diffabili da uno snapshot; confermato solo che le fn vecchie sono *assenti*.
- **Default numerici esatti** di ~15 config-knob timeout (verdetto-irrilevante).
- **`architecture/{memory,mcp,skills,vault,desktop-shell}.md`**: solo header controllati (pre-0024/0025 ma ortogonali); body non cross-checkato.
- **`STATO.md` righe ~220–1525**: narrativa storica non verificata riga-per-riga.
- **Mapping preciso Tappa 1 vs 1.5 vs 2 vs 4** oltre a flag/file.
- **ADR 0003** (assistant-ui ancora la libreria chat?) non tracciato al codice.
- **`browser_loop.rs`**: confermato non cablato al gateway; non sweeppati *tutti* i crate/sidecar/test per un consumer vivo.
- **Se qualche config CI/launch** setta i flag default-OFF (`HOMUN_DRIVE_CHAT`, ecc.): verificati solo i default nel codice, non `.github/`/launch/env pacchettizzato.
- **Branch topology** (quali `feat/memory-*-tappa-*` sono fusi in `main` vs nella linea corrente): il tree corrente **contiene** i file crate; non ho ricostruito la merge-history.

---

*Fine FASE 1. Prossimo passo: Fabio decide LAND/KILL/KEEP item per item (§5); poi FASE 3 (commit piccoli e gated) e FASE 4 (`docs/system-overview.md`).*
