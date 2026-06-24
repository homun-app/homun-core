# Backlog completo Homun — tutto ciò che resta da fare

Data: 2026-06-22. Quadro UNICO di tutto l'arretrato. Decisione architetturale di
fondo: [ADR 0016](../decisions/0016-harness-owned-task-engine-cross-model.md).

> Regola di rilascio: il batch 1042 si costruisce **in locale** (build verde a ogni
> passo) e si **pubblica solo su comando dell'utente**.

Legenda: ✅ fatto · 🟡 in corso · ☐ da fare.

---

## WS1 — Motore & GESTIONE DEL PIANO (ADR 0016)

Il cuore: rendere l'orchestrazione una proprietà dell'**harness**, robusta anche su
modelli deboli/locali. Invarianti: monotonìa, limitatezza, identità non inferita.

- ✅ **Fase 1** — enforcement output (floor) + `make_deck` (un-call, max scaffolding).
  Pubblicato **v1041**, deck verificato su `gemma4:latest` locale.
- 🟡 **Fase 2 — GESTIONE PIANO (il pezzo grosso).** Obiettivo: piano runtime-owned a
  **`step_id` stabili** (l'`ExecutionPlan` del crate `orchestrator` ce l'ha già).
  - ✅ **Slice 1 (fatto)**: `merge_plan` ora abbina **per `id`** quando il modello lo
    rimanda (lo schema `update_plan` ha il campo `id`; il marker ‹‹PLAN›› lo mostra),
    fallback al titolo → riduce il gonfiore da titoli parafrasati, retro-compatibile,
    sicuro sui modelli deboli. Test `merge_plan_matches_by_id_despite_rephrased_title`.
  - ✅ **Slice 2 (fatto)**: tool **`step_advance(id, status)`** — riporta il progresso su
    UN solo step per id, **senza re-inviare il piano** (weak-model-proof: niente da
    parafrasare, niente gonfiore). Riusa lo stesso percorso merge+F2-verify di
    `update_plan` (zero duplicazione); `merge_plan` ora aggiorna anche per **id solo** (no
    titolo). Tool registrato + guida nel prompt + test. `update_plan` resta per creare/rivedere.
  - ⚠️ **Trovato in-app (2026-06-22, `kimi-k2.6:cloud`)**: per un task multi-step *generico*
    (≠ `make_deck`) l'harness **non crea il piano** (‹‹PLAN››=0 nel chat store) **né guida
    il loop a termine** (demo-piano fermo a 2/5). Le slice 1/2 sono corrette ma **non
    raggiunte** — stanno a valle di un piano che non nasce. **Prima di slice 3** serve il
    pezzo a monte: **trigger-piano + continuazione-loop a completamento** (vedi "Floor
    ovunque" sotto, caposaldo #2). **Slice 3 (DAG) deprioritizzata.**
  - 🟡 **Slice 2.5 (commit `4706d7a`, unit-verde 8/8) — RICLASSIFICATA, NON è il fix di
    demo-piano**: guard simmetrico @ `main.rs:13534` (se il modello agisce ma stoppa **senza
    piano** né confirm-gate, giudice cheap `task_appears_incomplete` → nudge a creare il piano).
    **Caso più stretto:** il test `demo-piano` NON ci passa (la 1ª scrittura attiva
    `pending_confirm` che rompe a :13518, *prima* del guard di 2.5 a :13524) → vedi 6.1b.
    La tengo (corretta + low-risk), ma **in-app non verificata** (il suo caso non è stato
    esercitato). `turn_used_tools` la tiene fuori dalla chat pura; `make_deck` esente.
  - ✅ **Slice 2.6 (2026-06-23, locale/verde)**: il piano runtime-owned ora fa write-back
    nella memoria canonica. Ogni `update_plan` / `step_advance` crea o aggiorna **in-place**
    un solo `open_loop` `source="runtime_plan"` per thread, con `done_count`, `total_count`,
    `next_step` e snapshot steps nei metadata; quando il piano è completo il record viene
    marcato stale. `stato-lavori.md` resta una proiezione derivata rigenerata dal
    `MemoryFacade`, non uno store parallelo. Test:
    `cargo test -p local-first-desktop-gateway runtime_plan_memory -- --nocapture`.
  - ✅ **Slice 2.7 (2026-06-23, locale/verde)**: lo stesso write-back materializza
    anche il grafo canonico del piano: entity piano (`metadata.kind="runtime_plan"`),
    entity step (`metadata.kind="runtime_plan_step"`), relazione memoria→piano
    `describes`, piano→step `relates_to` con `metadata.kind="has_step"` e
    step→step `depends_on` quando il piano porta `depends_on` espliciti. Resta
    dentro `MemoryFacade`, nessun workflow store parallelo. Test mirato:
    `runtime_plan_memory_materializes_plan_step_graph`.
  - 🟡 **Slice 3a (2026-06-23, locale/verde)**: prima convergenza verso
    l'`ExecutionPlan` del crate `orchestrator` senza store paralleli: il piano
    runtime-owned resta compatibile con marker/UI `Vec<Value>`, ma il write-back
    canonico salva anche `metadata.execution_plan` serializzato come
    `ExecutionPlan` (`route=mixed_workflow`, step con `step_id`, `depends_on`,
    `goal`, `contract=runtime_plan_step`). `update_plan` accetta `depends_on`
    espliciti e `merge_plan` li conserva, quindi la DAG arriva dal flusso reale.
    Test mirati: `runtime_plan_memory_projects_execution_plan_contract`,
    `merge_plan_preserves_explicit_dependencies`,
    `runtime_plan_memory_materializes_plan_step_graph`.
  - ✅ **Slice 3b (2026-06-23, locale/verde)**: `ExecutionPlan` è ora lo stato
    runtime canonico del piano nel loop agente. Il `Vec<Value>` resta vista
    derivata per marker UI, memoria/grafo e verifica step; `merge_execution_plan`
    applica le regole monotone/sticky di `merge_plan` e rigenera il contratto.
    La resume da marker resta retrocompatibile. Test mirato:
    `merge_execution_plan_is_runtime_canonical_state`.
  - ✅ **Slice 3c (2026-06-23, locale/verde)**: `ExecutionPlan` include
    `plan_propose: Option<PlanProposal>` (`summary`, `steps`) come campo
    top-level opzionale; schema e prompt planner lo accettano quando serve
    approvazione del piano prima dell'esecuzione. Test:
    `cargo test -p local-first-orchestrator -- --nocapture`.
- ☐ **Floor ovunque** — constrained decoding su **tutte** le emissioni di
  orchestrazione (tool call del loop principale, piano, verifica), locale+cloud. Oggi
  è imposto solo sul contenuto di `make_deck`; il planner OpenAI-compat declassa ancora.
- 🟡 **Fase 3** — skill **dichiarative** + workflow runner (un solo grafo; `make_deck`
  è l'embrione di `create-presentations` come workflow).
  - ✅ **Slice 3a (2026-06-23, locale/verde)**: `make_deck` ha una
    `WorkflowDefinition` harness-owned (`brand → content → images/deck_json →
    render → register_artifacts`) proiettata in `ExecutionPlan` con DAG e
    contratto `DeckWorkflow`. Il modello vede ancora un solo tool, ma il runtime
    ha una definizione dichiarativa verificabile. Test mirato:
    `make_deck_workflow_definition_projects_execution_plan`.
  - ✅ **Slice 3b/F5 (2026-06-23, locale/verde)**: `OrchestratorBrain` espone
    `run_plan(request, execution_plan)`, entrypoint per workflow dichiarativi già
    costruiti dall'harness. Esegue/accoda gli step usando gli stessi provider,
    policy, task-runtime, dipendenze e subagent path dei piani prodotti dal
    planner, con `planner_rounds=0` e senza roundtrip LLM. Test mirato:
    `brain_runs_static_execution_plan_without_planner_roundtrip`.
  - ✅ **Slice 3d (2026-06-23, locale/verde)**: `make_deck` passa la propria
    `WorkflowDefinition`/`ExecutionPlan` attraverso `OrchestratorBrain::run_plan`
    prima della pipeline deterministica, senza planner LLM e senza store
    workflow parallelo. Test mirato:
    `make_deck_workflow_plan_runs_through_brain_without_planner`.
  - ✅ **Slice make_document (2026-06-23, locale/verde)**: primo workflow
    documenti dichiarativo. `make_document` ha `WorkflowDefinition`
    harness-owned (`brief → draft_markdown → write_artifact → register_artifact`)
    proiettata in `ExecutionPlan` con contratto `DocumentWorkflow`, passa da
    `OrchestratorBrain::run_plan`, viene instradato dal router workflow|agent per
    richieste esplicite di scrittura/creazione documenti/report e registra
    l'artifact Markdown in memoria/provenance con producer `make_document`.
    Post-smoke runtime: validazione statica async-safe, pruning del toolset
    workflow anche dopo MCP/Composio injection e nome artifact richiesto/preservato
    (`homun-smoke-document.md` non degrada più a `document.md`). Gate API passato
    su `thread_1782222457104_348911810416083`: artifact gestito, memoria
    `artifact|confirmed`, entity artifact e relazione `make_document produced`.
    **Slice PDF (2026-06-23, locale/verde):** `make_document` accetta
    `formats=["md","pdf"]`, mantiene una sola sorgente Markdown e materializza
    artifact `.md`/`.pdf` gestiti, ciascuno registrato nella memoria/provenance
    canonica con producer `make_document`. Gli artifact sono esclusi dal dedup
    semantico distruttivo: due deliverable simili restano entità distinte per
    `thread_slug + name/path`. Test mirati: `make_document_workflow`,
    `workflow_router_sends_document_requests_to_document_workflow`,
    `workflow_router_prunes_alternative_tools_for_document_workflow`,
    `make_document_tool_requires_artifact_name`,
    `make_document_generation_options_are_explicit_and_bounded`,
    `make_document_formats_preserve_explicit_pdf_outputs`,
    `make_document_formats_support_editable_docx_outputs`,
    `markdown_to_docx_writes_valid_word_package`,
    `markdown_to_docx_renders_pipe_tables`,
    `markdown_to_docx_promotes_plain_first_line_to_title`,
    `artifact_memories_do_not_participate_in_semantic_dedup`,
    `static_workflow_plan_validation_is_async_runtime_safe`,
    `artifact_provenance_context_surfaces_make_document_workflow`.
    **Slice DOCX (2026-06-23, locale/verde):** `make_document` accetta anche
    `formats=["docx"]` e richieste Word/editabili; materializza un pacchetto
    OOXML `.docx` minimale dalla stessa sorgente Markdown, senza nuova dipendenza
    e con artifact gestito registrato come gli altri formati.
    **Slice struttura/stile (2026-06-23, locale/verde):** lo stesso tool espone
    `document_type`, `audience`, `tone`, `layout_profile` e `sections`; il
    workflow li traduce in direttive di generazione solo se esplicitamente
    passati, senza euristiche fragili e senza registry paralleli.
    **Slice DOCX tables (2026-06-23, locale/verde):** il renderer OOXML converte
    tabelle pipe Markdown in tabelle Word reali (`w:tbl`) con escaping XML,
    mantenendo la stessa registrazione artifact/memoria.
    **Smoke fix DOCX formatting (2026-06-23, locale/verde):** dopo lo smoke
    reale, il renderer scrive `styles.xml`, converte bold/italic Markdown in run
    Word, promuove il primo titolo e tratta liste numerate come paragrafi lista.
    **Smoke fix DOCX table sizing (2026-06-23, locale/verde):** dopo il secondo
    smoke reale, le tabelle Word sono full-width con `tblGrid`, layout fixed,
    celle percentuali e proporzione 35/65 per tabelle a due colonne.
  - 🟡 **Prossime slice deliverable design system:** smoke reale del nuovo
    `layout_profile` quando serve una prossima release; poi template, componenti,
    temi e controlli QA più ricchi come grammatica condivisa da `make_document` e
    `make_deck`/presentation. Una gallery può essere UI/catalogo, non un secondo
    sistema. Restano vietati routing keyword-based e nuovi `make_*` per ogni
    template.
    **Prima slice design_profile (2026-06-23, locale/verde):** `make_document` e
    `make_deck` espongono lo stesso `design_profile` (`executive`,
    `sales_pitch`, `technical`, `editorial`, `minimal`), lo portano negli args
    del workflow e lo traducono in direttive specifiche per documento/deck.
    Test mirati: `deliverable_design_profile_schema_is_shared_by_deck_and_document`,
    `make_document_generation_options_are_explicit_and_bounded`,
    `make_deck_workflow_definition_projects_execution_plan`.
    **Seconda slice design_components (2026-06-23, locale/verde):** stessi
    componenti dichiarativi per documenti e presentazioni: `kpi_grid`,
    `timeline`, `comparison_table`, `quote_callout`, `process_steps`,
    `risks_table`. Il parser deduplica/limita i valori e il composer riceve
    direttive specifiche per medium; i renderer fisici e la gallery restano step
    successivi. Test mirati:
    `deliverable_design_components_schema_is_shared_by_deck_and_document`,
    `make_document_generation_options_are_explicit_and_bounded`,
    `make_deck_workflow_definition_projects_execution_plan`.
    **Terza slice deck layout materialization (2026-06-23, locale/verde):**
    `make_deck` applica i componenti dopo il JSON del modello e prima del render:
    `kpi_grid` → `kpi`, `quote_callout` → `quote`, timeline/comparison/processi/rischi
    → `two_column`, tutti layout già supportati da `deck_render.py`. È una
    trasformazione deterministica harness-owned; non cambia il renderer DOCX e
    non introduce una gallery. Test mirato:
    `deck_design_components_materialize_renderer_supported_layouts`.
    **Quarta slice document block materialization (2026-06-23, locale/verde):**
    `make_document` applica i componenti dopo il Markdown del modello e prima di
    materializzare `.md`/`.pdf`/`.docx`: genera sezioni/tabelle Markdown da
    contenuto già presente nel documento e il renderer DOCX le trasforma in
    tabelle Word reali. Test mirati:
    `document_design_components_append_renderable_markdown_blocks`,
    `document_design_components_render_as_docx_tables`.
    **Quinta slice design_template (2026-06-23, locale/verde):** `make_document`
    e `make_deck` espongono lo stesso `design_template` (`startup_pitch`,
    `executive_update`, `project_plan`, `technical_brief`, `sales_proposal`).
    Il template è grammatica dichiarativa del registry: espande in default
    `design_profile` + `design_components`, ma profilo e componenti espliciti
    prevalgono/estendono senza euristiche keyword. Il template viene registrato
    negli args workflow e tradotto in direttive specifiche per documento/deck.
    Test mirati:
    `deliverable_design_template_schema_is_shared_by_deck_and_document`,
    `deliverable_design_template_expands_to_defaults_without_overriding_explicit_args`,
    `make_document_generation_options_are_explicit_and_bounded`,
    `make_deck_workflow_definition_projects_execution_plan`.
    **Sesta slice design_theme + QA floor (2026-06-23, locale/verde):**
    `make_document` e `make_deck` espongono lo stesso `design_theme`
    (`clean_corporate`, `high_contrast`, `warm_editorial`, `minimal_mono`,
    `soft_gradient`). Il tema è token dichiarativo del registry: entra negli
    args workflow e nei prompt; lato deck viene materializzato in `theme`
    renderer-compatible (`primary`, `secondary`, `accent`, font) prima di
    `deck_render.py`. Aggiunto anche un primo guardrail QA harness-owned che
    rileva/accorcia titoli e bullet fuori soglia prima del render, evitando
    overflow banali senza affidarsi al modello. Test mirati:
    `deliverable_design_theme_schema_is_shared_by_deck_and_document`,
    `deck_design_theme_materializes_renderer_theme_tokens`,
    `deck_quality_guardrails_bound_text_before_render`,
    `make_document_generation_options_are_explicit_and_bounded`,
    `make_deck_workflow_definition_projects_execution_plan`.
    **Settima slice rendered deck QA (2026-06-23, locale/verde):** aggiunto
    `deck-qa` nel contained computer. Il comando apre `deck.html` renderizzato
    con Chromium headless e DevTools Protocol, misura layout reale e produce JSON
    `ok/issues` per overflow slide, elementi fuori bounds e immagini non
    caricate. `render_deck` e `make_deck` eseguono `deck-qa` dopo
    `deck-render`/PDF e prima di emettere marker artifact o registrare memoria:
    se la QA fallisce, i file non vengono dichiarati deliverable completati.
    L'hash del contained computer include `deck_qa.py`, quindi il container viene
    ricostruito quando cambia la QA. Gate locali: `py_compile`, test Rust
    `rendered_deck_qa_failure_is_extracted_from_renderer_output`, smoke positivo
    e negativo con Google Chrome locale.
  - ☐ **Backlog deliberato:** `make_research` / `make_meeting` restano in fondo
    finché non è chiarito il contratto degli strumenti creati dall'harness.
- ✅ **Fase 4 (2026-06-23, locale/verde)** — router workflow|agent + primo
  scaffolding adattivo: richieste deck/presentation/slide/pptx vengono
  instradate dal runtime al workflow `make_deck` con scaffolding `maximum` e
  instruction di sistema vincolante; richieste generiche restano nel loop agente.
  Test mirati: `workflow_router_sends_deck_requests_to_max_scaffolding_workflow`,
  `workflow_router_keeps_generic_requests_on_agent_loop`.
- 🟡 **Fase 4b — Capability Registry unico (nuovo caposaldo, 2026-06-23).**
  Obiettivo: sostituire il routing keyword-based dei `make_*` con un registry
  unico interrogabile che contenga workflow nativi, MCP, skills/addon, connector
  tools e strumenti atomici interni. Il turno fa retrieval delle capability
  candidate, decisione strutturata (`workflow end-to-end` vs `tool atomico` vs
  `skill/addon` vs chiarimento/piano), log della scelta e toolset live minimo.
  Le keyword restano solo prefilter/fallback/guardrail, non verità di routing.
  Esempio target: “voglio creare un pitch per Homun” deve recuperare `make_deck`
  dal registry anche senza `slide`/`pptx`.
  - ✅ **Prima slice registry nativo (2026-06-23, locale/verde):** `make_deck` e
    `make_document` hanno entry `NativeWorkflowCapability` con schema tool,
    descrizione semantica e route text condivisi da router e corpus. Il routing
    non usa più l'array keyword deck/document: recupera via BM25 sul registry
    nativo. Gate: “Voglio creare un pitch per Homun” seleziona `make_deck` senza
    `slide`/`pptx`; una richiesta generica resta `AgentLoop`.
  - ✅ Far confluire nel corpus `find_capability` anche i workflow nativi, senza
    esporli tutti nel prompt: i `make_*` vengono saltati dal corpus deferred
    generico e reinseriti tramite registry nativo; quando il router sceglie un
    workflow, il tool selezionato viene caricato esplicitamente nel live toolset
    e `find_capability` non viene esposto.
  - ✅ **Seconda slice decisione strutturata (2026-06-23, locale/verde):**
    aggiunta `CapabilityRouteDecision` (`Workflow`, `AtomicTool`, `AgentLoop`)
    con `reason` e alternative. La prima conflict policy esplicita copre PDF:
    `crea un report PDF` resta workflow end-to-end `make_document`; `estrai
    testo da questo PDF`, `unisci questi PDF`, `converti questo PDF...` sono
    `AtomicTool(pdf_atomic)` e non attivano `make_document`.
  - ✅ **Terza slice runtime trace (2026-06-23, locale/verde):** il loop agente
    calcola una sola `CapabilityRouteDecision`, la usa per system prompt e route
    workflow, ed emette una trace line come `ACT` + `tool_trace` con ragione e
    alternative. Questo rende auditabile perché il turno ha scelto workflow o
    atomico e alimenta il learning post-turn senza store paralleli.
  - ✅ **Quarta slice registry atomici (2026-06-23, locale/verde):** aggiunta
    `NativeAtomicCapability`; `pdf_atomic` entra nel corpus `find_capability` ed
    è mappato a schema tool reale `run_in_sandbox` per operazioni PDF su file
    esistenti. Una route atomica carica `run_in_sandbox` nel live toolset e
    mantiene `find_capability`, senza attivare workflow deliverable.
  - ✅ **Quinta slice registry MCP (2026-06-23, locale/verde):** i tool MCP
    connessi entrano nel corpus unico `find_capability` come entry tipizzate
    `McpTool`, con schema attivabile nello stesso live toolset. Questo copre il
    fallback oltre `MCP_ALWAYS_LOAD_MAX` e rimuove un altro ramo parallelo tra
    registry nativo e catalogo MCP. Test mirato:
    `mcp_tools_contribute_typed_entries_to_capability_corpus`.
  - ✅ **Sesta slice registry connector typed (2026-06-23, locale/verde):** i
    risultati Composio/connector dentro `find_capability` restano toolkit-aware
    (per non perdere CRUD completo e perimeter read/write), ma vengono convertiti
    in `CapabilityEntry` con source `ConnectorTool` prima di essere caricati nel
    live toolset e mostrati al modello. Test mirato:
    `connector_hits_are_typed_capability_entries`.
  - ✅ **Settima slice registry connector search typed (2026-06-23,
    locale/verde):** la ricerca connector passa da
    `search_connector_capability_entries`, che restituisce direttamente entry
    `ConnectorTool` typed mantenendo il set toolkit-aware. `find_capability`
    consuma così lo stesso shape per native/MCP/connector. Test mirato:
    `connector_search_returns_typed_toolkit_entries`.
    Gate in-app passato: discovery Gmail unread seleziona il connector Gmail;
    esecuzione successiva legge realmente le ultime 3 email non lette via Gmail.
  - ✅ **Ottava slice registry trace/audit (2026-06-23, locale/verde):**
    `find_capability` scrive nel `tool_trace` una riga
    `capability discovery ... -> source:key` derivata dalle `CapabilityEntry`
    tipizzate. La scelta della capability entra così nel learning/audit del turno
    senza creare uno store parallelo. Test mirato:
    `capability_discovery_trace_records_typed_sources`.
  - ✅ **Nona slice registry execution trace (2026-06-23, locale/verde):** le
    capability connesse eseguite vengono tracciate come
    `capability execution connector:TOOL` o `capability execution mcp:TOOL`,
    includendo anche read connector come Gmail che prima non entravano nel trace
    se non erano write. Test mirato:
    `connected_capability_execution_trace_records_source`.
  - ✅ **Bugfix stream resume duplicate commit (2026-06-23, in-app passato):**
    lo smoke Gmail ha evidenziato doppio user/assistant persistito. Causa:
    resume marker letto dalla stessa sessione JS, che committava un secondo ramo
    con `local_assistant_*` prima del commit normale `browser_assistant_*`.
    Fix: marker con `ownerId`; il resume della stessa sessione viene riattaccato
    solo come preview live senza commit, mentre il vero reload continua a fare
    resume con commit. Gate: `npm run build` desktop verde + retest utente senza
    duplicazione; follow-up 2026-06-23 copre il cambio-chat durante stream.
  - 🟡 Possibile step futuro: atomico PDF dedicato con schema più guidato
    (input/output files, operazione), se `run_in_sandbox` risulta troppo generico
    nello smoke.
- 🟡 **Fase 5** — convergenza con `OrchestratorBrain` (completa [ADR 0008](../decisions/0008-orchestrator-brain-single-planner.md)).
  - ✅ `run_plan` porta i workflow dichiarativi dentro lo stesso Brain senza planner
    LLM; resta applicarlo a tutte le pipeline deliverable e al router.
- ✅ **Fase 6** — memoria nel loop **per-step** sull'unico `MemoryFacade`.
  - ✅ **Slice 6a (2026-06-23, locale/verde)**: il loop principale scrive una
    `fact` confermata `source="runtime_plan_step"` quando uno step viene
    verificato `done`, con `thread_id`, `step_id`, criterio ed evidenze. Upsert
    in-place per lo stesso step; nessun workflow store parallelo. Test mirato:
    `runtime_plan_step_outcome_writes_confirmed_fact_memory`.
  - ✅ **Slice 6b (2026-06-23, locale/verde)**: gli outcome completati dei task
    `subagent.*` riusano lo stesso formato `runtime_plan_step`, con `step_id`
    dal task id, `done_criterion` dal contratto sub-agent ed evidence redatta
    `source="subagent_task"`. Test mirato:
    `subagent_task_outcome_writes_runtime_plan_step_fact`.
- ☐ **Sub-agent** — sub-agent a contesto isolato come tipo di nodo del grafo, recall/
  write-back attraverso il motore di memoria condiviso.

## WS2 — Artefatti & Memoria (sequenza obbligata)

Gli artefatti sono i **deliverable** (valore del prodotto); ciclo di vita ≠ chat;
tutto passa dal motore di memoria.

- ✅ **3.1 — chiudere il BUCO (prerequisito):** artefatti come **entità di memoria**
  (`title/type/project/path/thread/created_at` + embedding) via il `MemoryFacade`
  condiviso → recall del deliverable ("rifammi il deck del consiglio").
  **Slice locale/headless:** i produttori artifact principali (`run_in_sandbox`,
  `create_artifact`, `generate_image`, `render_deck`, `make_deck`) registrano
  ogni artifact surfaced come `memory_type="artifact"` + entity grafo `artifact`,
  metadata canonici (`thread_slug`, `name`, `artifact_type`, `path_ref`,
  `managed_path`, `project_path`, `size_bytes`) e backfill embedding immediato.
  Dopo il primo gate in-app fallito, anche `write_file` registra i file di
  progetto come artifact memoria/entity: se il modello interpreta "artifact" come
  file in-place, il deliverable entra comunque nella memoria. Il secondo gate ha
  mostrato che il ramo reale era `mcp__filesystem__create` workspace-scoped:
  anche quelle scritture dentro root progetto ora registrano artifact memoria/entity.
  Il terzo gate ha esposto la forma provider reale `mcp:filesystem`; il filtro è
  stato normalizzato e coperto da test. Gate runtime passato il 2026-06-23 dopo
  restart reale del gateway: `artifact-memory-gate-5.md` è stato creato via
  `mcp__filesystem__create`, registrato come `memory_type="artifact"` nello
  scope progetto, entity grafo `artifact`, embedding presente e recall esplicito
  riuscito. Nota: il pannello Artifacts non mostra ancora questi file perché oggi
  legge solo gli artifact surfaced/chat-managed; la surface passa a 3.2. Test:
  `artifact_memory_upsert_creates_single_record_and_graph_entity` e
  `mcp_filesystem_artifact_detection_accepts_namespaced_provider` verdi.
- 🟡 **3.2 — schermata Artefatti centralizzata** (Settings): selettore progetto
  (workspace) + filtri (progetto/tipo/orfani) + multi-selezione + **Esporta ZIP**
  (cross-OS, salva in cartella) + **Elimina**. Dati: `artifacts_usage` arricchito con
  titolo/progetto/flag orfano.
  **Slice 3.2a locale/verde:** `/api/artifacts/memory?thread=...` espone gli
  artifact registrati in memoria nello scope del thread/progetto; il Workbench
  Artifacts fonde artifact chat-managed e artifact memoria, con preview/download
  dei file di progetto via `fsFile` jailato. Gate endpoint: restituisce
  `artifact-memory-gate-5.md` con `project_relative_path`, `project_path`,
  `size=24`, `source=mcp_filesystem`. Gate visuale DOM/in-app: badge Workbench
  `1`, tab Artifacts mostra `artifact-memory-gate-5.md` e preview
  `test memoria artifact 5`.
  **Slice 3.2b locale/verde:** `/api/artifacts/usage` include anche gli artifact
  memoria dello workspace corrente, con `source=memory`, `reference`,
  `project_path`, `project_relative_path` e `title`; Settings distingue file
  managed vs memoria e chiama il delete memoria quando disponibile. **Resta:**
  export ZIP, filtri/progetto/tipo/orfani. Smoke runtime non distruttivo:
  `GET /api/artifacts/usage` su nuova build include `artifact-memory-gate-5.md`
  nel gruppo `memory:workspace_...`. Gate UI Settings passato: il gruppo memoria
  è visibile nella surface dedicata Artifacts. La surface è stata spostata fuori
  da Local computer perché i deliverable sono output di prodotto, non runtime
  tecnico.
  **Slice 3.2c locale/verde:** aggiunto `POST /api/artifacts/export`, che produce
  uno ZIP dai file visibili/selezionati nella UI. I file `managed` vengono letti
  solo dalla cartella artifacts jailata; i file `memory` vengono risolti dal
  `MemoryRef` canonico e validati contro root progetto/artifacts prima della
  lettura. Settings → Artifacts ora offre filtri gruppo/progetto, sorgente,
  tipo file e `memory-linked`/`orphan`, più selezione multipla. Test:
  `cargo test -p local-first-desktop-gateway artifact_ -- --nocapture` e
  `cargo test -p local-first-desktop-gateway -- --nocapture` (`176 passati, 1
  ignorato`) e `npm run build` desktop verdi. Smoke runtime API passato:
  `/api/artifacts/export` ha prodotto `/tmp/homun-artifacts-gate.zip` con entry
  `thread_1782105474_1782105474688595000/brand.json`. Gate in-app/DOM passato:
  la surface mostra `Export ZIP` e filtri Group/Source/Type/Link; click su
  `Export ZIP (12 visible)` ha scaricato uno ZIP valido con artifact managed e
  `memory-workspace_0d46c4470d97422298ece7ee7f0b74c6/artifact-memory-gate-5.md`.
- 🟡 **3.3 — lifecycle + cancellazione con memoria:** `delete_chat_thread` **non**
  cancella più gli artefatti: la chat è storia conversazionale, il deliverable ha
  lifecycle proprio. `DELETE /api/artifacts/memory?reference=...` rimuove il file
  solo se resta dentro root progetto o artifacts jail, poi tombstona memoria +
  entity artifact. Test verdi: `delete_chat_thread_preserves_artifact_lifecycle`,
  `artifact_memory_delete_path_is_jail_scoped`, gateway completo `174 passati, 1
  ignorato`, frontend `npm run build`.
  Gate runtime/in-app passato: `settings-delete-gate-fe0f6585.md` eliminato dalla
  UI → file rimosso, memoria `status=deleted`, tombstone memoria + entity
  presenti; cancellare un thread usa-e-getta ha preservato il file artifact
  managed finché non è stato rimosso esplicitamente via API artifact.

## WS3 — Batch 1042 (in locale, da pubblicare su comando)

- ✅ Deck nella **lingua della richiesta** (no default inglese).
- ✅ Badge **💻 locale / ☁️ cloud** nel picker (composer + ruoli Settings).
- ✅ Gestione file **per-file** nel pannello esistente (interim, solo filesystem; da
  rivedere dopo WS2/3.1).
- ✅ **#3 — memoria "appiccicosa"** (propone sempre 3 slide): risolto a livello **skill**
  (chiama `make_deck` SUBITO col numero richiesto, non proporre/chiedere) — scelto NON
  cancellare la memoria utente (sarebbe band-aid sui dati). Opzione (a) scartata.
- ✅ **Strip `<tool_call>` trapelato** come testo in chat (`RichMessage.tsx`
  `LEAKED_TOOLCALL_RE`), come già per le immagini rotte.

> **WS3 chiuso** — pronto a pubblicare la **v0.1.1042** su comando.

## WS5 — Completare la MEMORIA (cervello che sa il perché e sopravvive)

Visione & ragionamento: [memory-vision.md](../memory-vision.md). Baseline reale
(2026-06-22): grafo 49k entità/236k relazioni ma oggi **soprattutto codice**; **391** embedding;
**9** pagine wiki markdown → la macchina c'è ma è **sbilanciata/dormiente** sui pezzi
che fanno "ricordare il perché e sopravvivere". Caposaldo #8.

- ☐ **5.1 Estendere il grafo** dal primo adapter maturo (code graph/Graphify) a
  **decisioni / artefatti / step di piano / esiti** + **archi causali**
  (`rationale_for`, `produced`, `derived_from`, `supersedes`, `blocks`). Include
  audit dei read-model graph-like (`contact_relationships`): se portano conoscenza
  semantica devono essere mirrorati/convergenti nel grafo canonico memoria.
- ✅ **5.2 Embeddare tutto** — `spawn_embedding_catchup` allo startup vettorizza ogni
  memoria mancante su **tutti** gli scope, loop fino a esaurimento (off critical path).
  Risolve il gap 391/555 (l'auto-consolidamento che faceva il backfill era OFF di
  default; il backfill altrove era cappato a 4-12).
- ✅ **5.3 Loop aperti** — tipo `open_loop` di prima classe: meccanismo validato
  in-app (cattura + recall cross-chat su gemma4:latest, v1042). Iniezione nelle
  chat nuove, proiezione wiki, dedup e chiusura automatica sono coperti da WS5.4.
- ✅ **5.7 Completezza & coerenza della cattura** *(gap trovato nel test Rossi, 2026-06-22;
  prompt estrattore sistemato — **VERIFICATO in-app 2026-06-22**: chat B ha ricordato il
  finding negativo "il file del preventivo non è stato ancora trovato")*:
  l'estrattore scarta i **finding** ("do NOT extract … what the assistant said") → la
  memoria salva il piano ma NON lo **stato reale** (es. "nessun file ancora / X non
  trovato"), e una chat nuova ricostruisce un quadro "troppo pulito", **incoerente** con
  la chat originale. Fix: catturare i **finding salienti, inclusi i negativi**, e rendere
  gli `open_loop` **più ricchi** (cosa esiste / cosa NON esiste / cosa blocca) — senza
  però immortalare gli errori di processo del modello. Verificabile via eval (un check di
  coerenza A→B).
- 🟡 **5.4 Open loops nelle chat nuove**:
  - ✅ **5.4a briefing always-on** — `gather_open_loops` + sezione "OPEN LOOPS" in cima a
    `format_memory_block` (priorità di budget): una chat nuova li riceve **senza** nominare
    il topic (chiude il gap del test Rossi-B). Build+test verdi. **VERIFICATO in-app
    2026-06-22**: chat nuova ha mostrato **2** loop (preventivo Rossi + bug gateway browser).
  - ✅ **5.4b** proiezione markdown `stato-lavori.md` (faccia leggibile/editabile,
    bidirezionale): `/api/memory/wiki` rigenera una pagina "Stato lavori" dagli
    `open_loop`, linka i memory ref sorgenti, collassa parafrasi sulla pagina e
    rispetta `wiki-edited.json` come le altre proiezioni. Il save wiki ora re-ingesta
    genericamente la pagina memoria, non solo "decisioni". Test:
    `cargo test -p local-first-desktop-gateway status_wiki -- --nocapture` verde.
  - ✅ **5.4c** **chiusura automatica** dell'open_loop a lavoro fatto + **dedup**:
    gli `open_loop` parafrasati vengono superseduti via
    `MemoryFacade::merge_memories`; briefing e `stato-lavori.md` filtrano
    `superseded_by`; il salvataggio memoria e il consolidamento periodico
    deduplicano; l'estrattore può chiudere un loop attivo con
    `metadata.closes_open_loop`, marcandolo `Stale` solo se c'è overlap con un
    loop reale. Test: `open_loop_dedup_supersedes_duplicate_records` e
    `open_loop_closure_marks_matching_loop_stale_only_with_overlap` verdi.
- 🟡 **5.5 Catena di provenienza** decisione → artefatto → codice → esito (unisce
  WS2-3.1 artefatti→memoria + WS1-F6 piano→memoria + codice già nel grafo).
  **Slice 5.5a locale/verde:** ogni upsert di artifact memoria ora materializza
  nel grafo canonico anche entity `project`, entity `tool` producer, entity `file`
  quando `project_relative_path` è noto, e relazioni `produced`,
  `belongs_to_project`, `relates_to`; resta una sola verità nel `MemoryFacade`,
  niente store parallelo. Il vocabolario typed del crate memory include
  `rationale_for`, `produced`, `derived_from`. Test:
  `cargo test -p local-first-desktop-gateway artifact_memory_upsert_creates_single_record_and_graph_entity -- --nocapture`
  e `cargo test -p local-first-memory kind_tags_round_trip -- --nocapture` verdi;
  suite complete gateway (`176 passati, 1 ignorato`), suite completa memory e
  `npm run build` desktop verdi.
  **Slice 5.5b locale/verde:** gli artifact memoria collegano decisioni/piano/lavoro
  solo da evidenza strutturata già presente: `decision.affects_labels` che coincide
  con un identificatore canonico dell'artifact (`name`, `title`, `path_ref`,
  `project_relative_path`, path assoluto o basename), oppure ref esplicite nei
  metadata artifact (`decision_refs`, `plan_refs`, `task_refs`,
  `source_memory_refs`, `derived_from_refs`). Il grafo canonico materializza
  `decision --affects--> artifact` e `artifact --derived_from--> decision/source_ref`,
  con evidence refs alla memoria sorgente e alla memoria artifact. Non fa matching
  semantico né inferisce relazioni probabili. Test:
  `cargo test -p local-first-desktop-gateway artifact_memory_links_ -- --nocapture`.
  **Resta:** alimentare refs piano/task dagli artifact verso le entity/ref piano
  ora disponibili, senza inferire relazioni non evidenziate.
- 🟡 **5.6 Eval memoria** (guardrail): chat nuova → *"a che punto è il workflow e perché
  make_deck?"* / *"quali artefatti per il progetto X e da quale decisione?"* → deve
  rispondere. Anti-regressione, come l'eval del deck.
  **Prima slice locale/verde:** il reader di recall/RAG attraversa la provenance
  artifact nel grafo canonico (`describes`, `produced`, `affects`,
  `derived_from`) e restituisce un blocco `ARTIFACT PROVENANCE FROM CANONICAL
  MEMORY GRAPH` con artifact, producer, path, decisione/lavoro sorgente, rationale
  e alternative scartate. Test red/green:
  `cargo test -p local-first-desktop-gateway memory_eval_surfaces_artifact_provenance_and_decision_why -- --nocapture`.
  **Seconda slice locale/verde:** il reader di recall/RAG copre anche “a che punto
  è il workflow e perché?” con un blocco `WORKFLOW STATUS FROM CANONICAL MEMORY`,
  composto da `goal`, `open_loop`, outcome/fact verificati, decisioni con rationale
  e artifact provenance come evidenza. Test red/green:
  `cargo test -p local-first-desktop-gateway memory_eval_surfaces_workflow_status_and_why -- --nocapture`.
  **Gate release locale/verde:** aggiunto un test unico da checklist pre-release
  che copre entrambe le domande target su una nuova chat simulata:
  `cargo test -p local-first-desktop-gateway memory_guardrail_release_gate -- --nocapture`.
  Verifica artifact/provenance/decisione, `make_document`/`DocumentWorkflow`,
  path gestito, decision rationale/alternative, goal/open-loop e outcome
  verificato.
  **Resta:** smoke in-app mirato del reader memoria quando si vuole validare il
  comportamento con dati reali; piano/task refs complete ora possono appoggiarsi
  al grafo piano materializzato da WS1.

> Nota: WS2-3.1 (artefatti→memoria) e WS1-F6 (piano→memoria) **alimentano** WS5 — sono
> i nodi che rendono la memoria il cervello connesso. Stesso north-star.

## WS6 — Proattività & esecuzione durevole

North-star: "osserva, propone, esegue task lunghi che **sopravvivono**". Il crate
`task-runtime` ha già `ResourceGovernor`, lease/heartbeat, scheduler, checkpoint,
recovery, `ApprovalGate`, `RetryController` — ma (gap audit nell'SVG) **non tutto è
cablato** nel flusso agente. ADR 0015.

- ☐ **6.1 Cablare la durabilità**: task agente lunghi nella coda con
  checkpoint/heartbeat/recovery → sopravvivono a chiusura app/crash (lega ADR 0016 F4
  background+resume).
- ✅ **6.1b Approval-resume — cut #2 persist+publish (commit `6b0b9c7`), gate in-app passato**
  (causa REALE di demo-piano, confermata in-app 2026-06-22 su kimi+gemma): un task che scrive file → la 1ª scrittura
  (`mcp__filesystem__create` ∈ `composio_writes`) attiva la card `‹‹MCP_CONFIRM››`
  (:13340-13367) + Telegram + `pending_confirm` → turno muore a :13518; dopo l'**approvazione**
  `execute_pending_approval` (:21029) esegue **solo quell'azione** + riscrive in "✓ MCP tool
  executed" (:22315) → **nessuna continuazione**. Fix: dopo l'approvazione (in-app o Telegram)
  l'harness **rientra nel loop del thread d'origine** col risultato e continua. **Passo 0
  fatto** — meccanismo inchiodato: il ri-avvio è **`run_agent_turn(state, thread_id, prompt,
  policy)`** (:17078), già usato da canale inbound (:16528) e autorun (:19360). Due rami: (a)
  **in-app** `mcp_execute` (:22259) ha già `thread_id`+`message_id` → dopo exec+riscrittura,
  `spawn(run_agent_turn(...))`; (b) **Telegram** → aggiungere `thread_id` a `PendingApproval`
  (:21063) propagato da `create_pending_approval` (:21078) ← `deliver_remote_approval` (:21082)
  ← call-site loop (:13362), poi `run_agent_turn`. Frizione "approva ogni scrittura" già
  mitigata da **Policy B `allow_server`** (:22273). Blocca **ogni** deliverable che scrive file
  → **prima di slice 3 / WS2**. Lega ADR 0015 + caposaldo #2.
  **IMPLEMENTATO (commit `7f98d57`):** `thread_id` aggiunto a `PendingApproval` +
  `create/take_pending_approval` + `deliver_remote_approval`; helper `resume_thread_after_approval`
  → `spawn(run_agent_turn(thread, prompt, "full"))`; agganciato a `mcp_execute` (in-app) e
  `execute_pending_approval` (Telegram); call-site MCP (:13362)/Composio (:13452) passano il
  thread, bozza-canale (:16572) `None`.
  **cut #1 GATE FALLITO (2026-06-22):** `run_agent_turn` drena lo stream e il resume **scartava**
  il risultato → invisibile ("approva su Telegram ma non cambia nulla"). **cut #2 FATTO (commit
  `6b0b9c7`):** il resume **persiste** (`append_assistant_message`) + **pubblica `thread.updated`**
  (pattern canale inbound :16544) → chat aggiornata via refresh, approvazioni **in-app E Telegram**
  (server-side, no frontend). Catena: continuazione si ferma alla 2ª confirm → card nel testo
  persistito → riappare in-app + msg Telegram → approvi → riprende. **Gate in-app pendente.**
  Limite: refresh, non token-live; nessun indicatore "sta lavorando".
  **Blocco Telegram trovato nel re-test (2026-06-22):** bridge orfano della build installata su
  `:18767` → card outbound funziona, ma `TG_GATEWAY_TOKEN` stale. Prova read-only contro il
  gateway locale: token del bridge **401**, token corrente **200**. Il bridge ignora la response
  della callback, perciò il tap non mostra errore. Prima del gate Telegram: rendere il lifecycle
  del sidecar resiliente a restart/update (rebind/handshake con token corrente, senza credenziali
  in log) e registrare esito HTTP redatto della callback. Non attribuire questo al resume 6.1b.
  **Lifecycle fix FATTO (commit `1ab8a53` + `793ca9c` + `417ee95`):** `/configure-gateway`
  autenticato reimposta URL+token callback in memoria; il gateway tenta rebind dopo il bind HTTP,
  sostituisce solo bridge legacy/stale e attende al massimo 3 s il proprio child prima del primo
  rebind. Bridge test **6/6**, gateway **151 passati / 1 ignorato**, build locali verdi. Prova
  Electron: stale installato → replacement; avvio seguente → `reconfigured existing sidecar`;
  connect API → `reconfigured:true`. **Gate Telegram END-TO-END PASSATO (Gemma, 2026-06-22):**
  thread `thread_1782134906_1782134906142839000` ha emesso confirm MCP per `note.md` e
  `riepilogo.md`, quindi ha persistito il completamento; filesystem verificato con entrambi i file
  in `~/demo-piano`. La chat ha prima chiesto il path base, poi ha eseguito il flusso corretto.
  **Bivio risolto:** Path B e WS6.1c sono stati entrambi implementati e verificati sotto.
- ✅ **Path B — root automatica per Filesystem MCP (2026-06-22):** scelta utente:
  **STATO ATTUALE / resume rapido:** implementazione locale completata fino al
  binding persistente delle approval remote. **Gate fuori-root/in-app passato
  (2026-06-22):** prompt canonico
  `Usa il tool MCP filesystem per creare /Users/fabio/Desktop/path-b-approval-bound.md con una riga: test.`
  ha creato il file esatto con `test`; thread
  `thread_1782142399_1782142399448892000`; `chat_messages` mostra user prompt →
  `✓ MCP tool executed` → finale sul file corretto; zero occorrenze di
  `path-b-gate/note.md`; `remote_approvals` ha
  `source_message_id=browser_assistant_1782142417646` e stato `superseded`
  (approvazione in-app ha invalidato il codice remoto). **Retry Telegram
  successivo:** callback Telegram ha eseguito correttamente l'azione (`status=
  'executed'`, file `/Users/fabio/Desktop/path-b-telegram-bound.md` con
  `telegram-test`, source `browser_assistant_1782142921059`), ma il resume ha
  sintetizzato il vecchio `path-b-gate/note.md`. **Fix locale:** prompt di
  resume ancorato a richiesta originale + args approvati + guardrail anti
  memoria/open-loop; test gateway **160 passati, 1 ignorato**. **Gate finale
  passato:** micro-gate Telegram-only con `path-b-telegram-bound-2.md` termina
  con `status='executed'`, finale chat sul path corretto e zero vecchio
  `path-b-gate`. Vietato ripetere probe di scrittura via endpoint HTTP grezzo.
  il connettore MCP resta collegato una volta sola a livello utente; ogni chiamata
  eredita la root del progetto del thread. Implementati manifest statico
  `mcp:filesystem` (`create`/`insert`/`str_replace`), jail assoluta
  symlink-safe, bypass card solo in-root e prova della confirm-card per il direct
  endpoint. Correzione UX/runtime: il system context ora comunica al modello la
  root assoluta del thread e che Filesystem è già disponibile — non deve chiedere
  né cartella né reconnect. **Prova runtime Electron (Kimi, `test-homun`):**
  `thread_1782138001_1782138001354628000` → attività `create`, nessun
  `MCP_CONFIRM`, file
  `/Users/fabio/Desktop/test-homun/path-b-gate/note.md` con `una/due/tre`,
  messaggi persistiti in `chat_messages`. Test gateway: **156 passati, 1
  ignorato**. Corretto anche il prompt operativo per il path fuori-root: deve
  chiamare il tool con path assoluto e far decidere al runtime, non dichiarare
  l'MCP assente né deviare nel progetto. Runtime Kimi,
  `thread_1782139063_1782139063946466000`: card prodotta per
  `/Users/fabio/Desktop/path-b-outside-gate-1782139063.md`; il `tool_runs`
  registra `create` solo dopo callback Telegram autorizzato alle 16:38:34.
  **Root cause ulteriore (verificata end-to-end):** Auto in un thread progetto
  sceglieva `coding`/`glm-5.2`, mentre il composer mostrava l'orchestratore
  `kimi-k2.6:cloud`; GLM risponde `400/1210` al round con tool e il loop
  proseguiva poi con una sintesi senza tool. Kimi esplicito ha provato che il
  Filesystem MCP è connesso e callable. **Fix locale, gate pendente:** endpoint
  modelli thread-aware (Auto mostra il routing reale), payload senza `tools: []`,
  fallback una sola volta al ruolo orchestratore dopo `400` con tool, e
  `run_agent_turn` thread-aware. Gateway **157 passati, 1 ignorato** + build
  desktop verde. **Prova runtime Electron da HEAD:** thread
  `thread_1782140733_1782140733708101000` ha risolto Auto=`glm-5.2`, emesso una
  sola attività fallback e poi la card per
  `/Users/fabio/Desktop/path-b-provider-fallback-1782140733.md`; il file era
  assente. **Gate invalidato subito dopo:** il probe HTTP ha realmente spedito
  un'approval Telegram, ma non ha persistito la sorgente nel thread. Quando
  approvata, ha eseguito il probe e ha fatto ripartire un thread senza il prompt
  originario; il resume ha contaminato il nuovo task con
  `path-b-gate/note.md` (catena verificata in `chat_messages`, file probe
  esistente). Gli stream sono ora vuoti; la vecchia mappa in-memory non era
  auditabile. **Fix locale implementato:** nuova tabella `remote_approvals`
  (`approval_id`, codice, tool/args, thread, `source_message_id`, stato);
  marker chat con `approval_id`; notifica Telegram/WA differita fino a card
  persistita; callback remoto valida card+tool+args+approval_id prima di
  `pending→executing`; origini non persistite vengono rifiutate; in-app
  supersede il codice remoto. `composio_execute` verifica ora la card come MCP.
  Gateway **159 passati, 1 ignorato**. **Gate parziale:** in-app passa;
  Telegram esegue (`executed`) ma resume contaminava il finale. **Fix locale
  successivo:** `approval_resume_prompt` con richiesta originale + args approvati
  e test gateway **160 passati, 1 ignorato**. **Gate finale PASSATO:** retry con
  `path-b-telegram-bound-2.md` ha prodotto `status='executed'`, file corretto,
  finale chat sul path approvato e zero `path-b-gate/note.md` nel thread.
  **Path B approval/provenienza chiusa**; non usare più il direct endpoint per
  test di scrittura reali.
  **Aggiornamento 2026-06-23:** gate provider Z.ai/GLM risolto da test manuale
  utente dopo riconfigurazione: Settings mantiene distinti il preset standard
  (`https://api.z.ai/api/paas/v4`) e il preset coding
  (`https://api.z.ai/api/coding/paas/v4`); l'errore `400` precedente non è più
  un blocco attivo.
- ✅ **6.1c UX Telegram approval (2026-06-22):** slice locale implementata dopo
  Path B: il callback Telegram su codice valido invia subito “Ricevuto…
  verifico/avvio”; il thread app riceve status persistiti “Approvazione Telegram
  ricevuta / eseguo …” e “Azione approvata da Telegram eseguita … riprendo il
  task” o “fallita …”, con target da args (`path`/`to`) e `thread.updated`.
  **Gate UX ha trovato una causa ulteriore:** notifica Telegram iniziale non
  inviata anche se card e `remote_approvals` erano corrette; prova:
  `approval_fc2026c6804a45029123b354672cd130`/`FC2026` resta `pending` con
  `dispatched_at=NULL`. Fix locale: outbound Telegram per approval/progresso
  ritenta con rebind automatico del sidecar usando il token persistito; se fallisce
  ancora, appende nel thread status `delivery_failed` con fallback esplicito a
  card in-app/reconnect invece del silenzio. Test
  `telegram_approval_progress_messages_are_actionable`; gateway **161 passati,
  1 ignorato**; `cargo build -p local-first-desktop-gateway` verde; `npm run
  build` desktop verde; `git diff --check` pulito. **Gate pendente:** riavvio
  Electron da HEAD e micro-test Telegram con nuovo path: verificare notifica
  Telegram iniziale, messaggio Telegram immediato, due status nel thread, finale
  resume corretto, `remote_approvals.dispatched_at IS NOT NULL` e
  `remote_approvals.status='executed'`. Non riusare `FC2026`.
  **Gate 18:17 ancora fallito:** `approval_e14399953a6c4dd6a5f9a7c7d1214114`
  / `E14399` per `path-b-telegram-ux-2.md` resta `pending` con
  `dispatched_at=NULL`; thread senza `delivery_failed`; prefs Telegram corrette.
  Questa evidenza punta a processo Electron/gateway vecchio/non riavviato da
  HEAD. Prossimo check: hard-stop dei processi, restart `npm run electron:dev`
  da `apps/desktop`, path nuovo.
  **Gate finale PASSATO dopo riavvio (18:20):**
  `approval_1a16fb7978fe4a91b163560fafbecff0` / `1A16FB` per
  `/Users/fabio/Desktop/path-b-telegram-ux-2.md` ha
  `status='executed'`, `dispatched_at` valorizzato e `resolved_at` valorizzato;
  thread con status running+executed e finale ancorato al path/contenuto
  `ux-ok-2`; file presente sul Desktop. **WS6.1c chiusa.**
- ✅ **6.2 Resource Governor** attivo sui task (limiti, backpressure).
  **Slice 1 FATTA (2026-06-22):** fix backpressure recuperabile. Gap trovato:
  `WaitingResource` non rientrava in `ready_tasks` dopo rilascio risorsa, perché
  lo scheduler considera solo `Queued|Pending`. Implementato
  `ResourceGovernor::requeue_waiting_if_available` + sweep gateway
  `requeue_waiting_resource_tasks` prima di `ready_tasks`, dopo lease recovery.
  Test red/green task-runtime
  `resource_governor_requeues_waiting_task_when_capacity_returns`; test gateway
  `task_executor_requeues_waiting_resource_before_scheduling`. Verifiche:
  `cargo test -p local-first-task-runtime` verde; gateway **162 passati, 1
  ignorato**; `cargo build -p local-first-desktop-gateway` verde; `npm run build`
  desktop verde; `git diff --check` pulito.
  **Slice 2 FATTA (2026-06-22):** stesso recupero cablato anche nel
  `TaskRuntime` standalone: `run_ready_once` reidrata i `WaitingResource` prima
  di `ready_tasks`. Test red/green
  `task_runtime_requeues_waiting_resource_before_scheduling` (prima
  `summary.completed=0`, dopo completa il task appena la risorsa viene rilasciata).
  Verifiche: `cargo test -p local-first-task-runtime` verde; focused gateway
  `task_executor_requeues_waiting_resource_before_scheduling` verde; build gateway
  e desktop verdi; `git diff --check` pulito.
  **Slice 3 FATTA (2026-06-22):** visibilità backpressure nella API task queue:
  `resource_usage[]` ora espone `units`, `limit_units`, `available_units` e
  `saturated` per classe. I limiti sono quelli effettivi del worker
  (`conservative_defaults` + `active_llm_concurrency` per `llm_inference`).
  Test red/green `task_queue_response_serializes_ui_read_model_for_renderer`;
  gateway **162 passati, 1 ignorato**; task-runtime verde; build gateway/desktop
  verdi; `git diff --check` pulito.
  **Slice 4 FATTA (2026-06-22):** stress-gate headless multi-worker su SQLite
  condiviso: due connessioni `TaskStore` separate, limite `llm_inference=1`,
  un worker detiene la reservation e un secondo `TaskRuntime` porta il task
  concorrente a `WaitingResource`; dopo rilascio reservation, il tick successivo
  reidrata e completa il task. Test:
  `task_runtime_recovers_resource_wait_across_worker_connections`. Verifiche:
  `cargo test -p local-first-task-runtime` verde; gateway **162 passati, 1
  ignorato**; build gateway e desktop verdi; `git diff --check` pulito.
  **Decisione:** 6.2 chiusa; la UI configurabile dei limiti resta una futura
  micro-slice opzionale, non blocca 6.3.
- ✅ **6.3 Scheduler / ricorrenza** + **proactive review** (l'assistente propone schede
  in autonomia governata) verificati end-to-end.
  **Slice 1 FATTA (2026-06-22):** allineato `TaskRuntime` standalone al worker
  gateway sulla ricorrenza. Test red/green:
  `task_runtime_materializes_next_recurrence_after_completion` (red: completava
  il task `daily` ma non inseriva `daily@occ@...`; green: occorrenza successiva
  `Queued`, `not_before > now`, stessa recurrence). Verifiche: task-runtime
  verde; gateway **162 passati, 1 ignorato**; build gateway e desktop verdi;
  `git diff --check` pulito.
  **Slice 2 FATTA (2026-06-22):** failure/retry recurrence parity tra runtime e
  gateway. Test red/green
  `task_runtime_materializes_next_recurrence_after_terminal_failure` (red:
  task ricorrente terminale `Failed` senza prossima occorrenza; green:
  `daily@occ@...` `Queued`, recurrence mantenuta, `not_before > now`). Il retry
  intermedio resta invariato (`WaitingTime`, nessuna nuova occorrenza).
  **Slice 3 FATTA (2026-06-22):** gate headless scheduled/proactive prompt:
  `materialize_automation_task` crea un task `proactive_prompt` visibile e le
  occorrenze riusano lo stesso thread `channel_scheduled_<root>`. Test:
  `scheduled_automation_materializes_visible_proactive_task`,
  `scheduled_occurrences_reuse_one_visible_thread`.
  **Slice 4 FATTA (2026-06-22):** surface/dedup proactive review coperta da
  parse/card/choices/dedup fuzzy/read-model tests.
- ✅ **6.4** Le azioni proattive scrivono in memoria (loop aperti / decisioni) — lega WS5.
  `suggestion_act` scrive memoria auto-confermata nello scope della card:
  `accepted|snoozed` → `open_loop`, `dismissed` → `decision`, con metadata
  card/dedup/action. Test:
  `proactive_action_memory_writeback_maps_statuses`,
  `suggestion_lookup_preserves_durable_dedup_key`. Gate finale locale:
  task-runtime verde; gateway **166 passati, 1 ignorato**; build gateway/desktop
  verdi; `git diff --check` pulito. **WS6 chiusa localmente.**
  **Post-smoke fix (2026-06-23):** lo smoke reale su scheduled automation ha
  mostrato un falso positivo: il runtime registrava `completed`/`ok=1` per una
  risposta non vuota che conteneva solo un `PLAN` ancora aperto (2/4) e testo di
  progresso. La gestione condivisa del piano (`plan_is_complete` /
  `plan_incomplete_reason`) ora considera completo solo `done == total`; il
  runner scheduled la usa tramite `agent_output_incomplete_reason`, classificando
  come incompleti il fallback "No reply generated..." e i marker `PLAN` con step
  non completati. Produce `completed=false`, `blocked_reason` ed evento
  `proactive_prompt_incomplete` invece di una falsa chiusura. Test mirati:
  `cargo test -p local-first-desktop-gateway plan_guard -- --nocapture` e
  `cargo test -p local-first-desktop-gateway plan_completion_requires_every_step_done -- --nocapture`.

## WS7 — Ecosistema deliverable (Manus)

`make_deck` è affidabile cross-modello; `make_document` è il secondo workflow
stabilizzato e ora cresce per formati/controlli. Il nuovo obiettivo WS7 è
arrivare a deliverable stile Manus/Z.ai tramite **design system dichiarativo
condiviso**: temi, layout, componenti, template e QA visuale sono una grammatica
comune per documenti e presentazioni/plugin. Il modello compone narrativa e
blocchi scegliendo dal registry; renderer deterministici producono `.pptx`,
`.docx`, `.pdf`/HTML; la QA verifica overflow, tabelle, immagini e leggibilità.
Una gallery può diventare UI/catalogo sopra questa grammatica, non il motore.
`make_research` e `make_meeting` restano deliberatamente in coda: prima va
ragionato il contratto degli strumenti `make_*` creati dall'harness. ADR 0011
(addon + contratto personalizzazione).

- 🟡 **7.1** Portare documenti al livello del deck: `make_document` dichiarativo
  guidato dal runtime, con formati gestiti e contenuto sempre derivato da una
  sorgente canonica.
- 🟡 **7.1a** Portare documenti e presentazioni sullo stesso design system:
  template dichiarativi, layout archetype, componenti riusabili, theme tokens e
  controlli QA visuali condivisi da `make_document` e `make_deck`/presentation,
  senza store paralleli e senza attivazioni euristiche. Prima base locale/verde:
  `design_profile` e `design_components` condivisi negli schemi e nei workflow;
  lato deck i componenti arrivano già a layout fisici `deck_render.py`; lato
  documenti arrivano a blocchi/tabelle Markdown renderizzate in DOCX; i
  `design_template` condivisi espandono ora default profilo/componenti restando
  override-safe; `design_theme` condiviso materializza token renderer-compatible
  lato deck e abilita un primo guardrail QA sui testi; `deck-qa` verifica ora
  l'HTML renderizzato prima della consegna. **Ottava slice template catalog
  provider (2026-06-23, locale/verde):** aggiunto un primo catalogo read-only
  seed `monet/*` dentro il registry unico. Le entry sono capability cercabili
  ma non tool callable; espongono `template_ref` e vengono risolte dal gateway
  nei token condivisi `design_template`, `design_theme`, `design_profile` e
  `design_components` consumati da `make_deck`/`make_document`. Espliciti
  `design_*` restano sovrani; niente store paralleli, niente renderer Monet,
  niente nuovo `make_*` per template. Test mirati:
  `template_catalog_entries_are_searchable_but_not_callable`,
  `template_catalog_ref_resolves_deck_design_defaults`,
  `make_deck_and_document_accept_template_ref`,
  `make_document_generation_options_are_explicit_and_bounded`,
  `make_deck_workflow_definition_projects_execution_plan`. Restano
  contrasto/leggibilità più avanzati, QA documenti e template library più ampia
  anche tramite catalogo esterno/adapter. **Nona slice provider contract
  (2026-06-23, locale/verde):** il seed `monet/*` è stato spostato dietro un
  `TemplateCatalogProvider` interno; `collect_template_catalog_entries` compone
  provider multipli con dedup first-wins e `template_catalog_by_id_from_entries`
  consente lookup stabile anche per provider futuri. Questo prepara MCP Monet,
  marketplace o template pack firmati come adapter di catalogo, senza cambiare
  i workflow e senza introdurre renderer/store paralleli. Test mirati:
  `local_template_catalog_provider_exposes_seed_templates`,
  `template_catalog_collects_multiple_providers_without_duplicate_ids`.
  **Decima slice file catalog (2026-06-23, locale/verde):**
  `FileTemplateCatalogProvider` carica manifest JSON locali da
  `HOMUN_TEMPLATE_CATALOG_PATH` o `~/.homun/template-catalog.json`. Il parser
  valida `provider_id`, `id`, `kind`, `design_template`, `design_theme`,
  `design_profile` e `design_components`, scartando token fuori vocabolario; il
  collector mantiene dedup first-wins, quindi un file catalog può aggiungere
  template ma non rimpiazzare i seed built-in. Test mirati:
  `file_template_catalog_provider_loads_valid_manifest`,
  `file_template_catalog_provider_rejects_invalid_manifest_identity`,
  `file_template_catalog_provider_loads_manifest_from_path`.
  **Undicesima slice deck leggibilità (2026-06-23, locale/verde):**
  `deck_qa.py` misura ora anche font-size e contrast ratio sui nodi testuali
  renderizzati nell'HTML reale. I codici `text_too_small` e `low_contrast`
  entrano nel `DECK_QA_JSON` e quindi bloccano `make_deck`/`render_deck` prima
  della registrazione artifact/memoria. Smoke reale locale: Chrome headless
  passa su HTML leggibile e fallisce su testo 9px/contrasto basso con entrambi
  i codici. Test mirati: `rendered_deck_qa_failure_is_extracted_from_renderer_output`,
  `python3 runtimes/contained-computer/deck_qa.py --self-test`,
  `python3 -m py_compile runtimes/contained-computer/deck_qa.py`.
  **Dodicesima slice document QA (2026-06-23, locale/verde):**
  `make_document` valida il Markdown generato prima di scrivere artifact
  `.md`/`.pdf`/`.docx`: linee troppo lunghe, token non spezzabili oltre soglia
  e righe tabella con numero celle incoerente producono un errore QA invece di
  un deliverable fragile. Il controllo resta deterministico e interno al
  workflow esistente, senza nuovo store o renderer parallelo. Test mirati:
  `document_quality_guardrail_accepts_structured_markdown`,
  `document_quality_guardrail_flags_unrenderable_markdown`,
  `make_document_generation_options_are_explicit_and_bounded`.
  **Tredicesima slice template library (2026-06-23, locale/verde):**
  il seed `monet/*` passa da 5 a 11 template coprendo deliverable PMI comuni:
  company one-pager, customer case study, meeting minutes/verbale con azioni,
  product launch plan, incident review tecnico e product roadmap board-level.
  Sono ancora entry catalogo cercabili e non callable, risolte nei token
  `design_*` esistenti senza introdurre nuovi renderer o tool. Test mirati:
  `local_template_catalog_provider_exposes_seed_templates`,
  `expanded_template_catalog_routes_common_pmi_deliverables`.
  **Quattordicesima slice manifest metadata (2026-06-23, locale/verde):**
  i cataloghi file accettano metadati opzionali `tags`, `preview_ref`,
  `source_ref` e `license`; i riferimenti vengono sanificati (niente path
  assoluti, `file:` o traversal) e indicizzati nella capability entry per
  discovery/UI futura. Non cambiano i workflow e non diventano tool callable.
  Test mirati: `file_template_catalog_provider_loads_valid_manifest`,
  `file_template_catalog_provider_ignores_unsafe_preview_refs`.
  **Quindicesima slice catalog API (2026-06-23, locale/verde):**
  il catalogo template è disponibile read-only via `/api/templates/catalog` e
  `coreBridge.templateCatalog()`. Il payload espone entry e metadati gallery
  senza schema callable, mantenendo il registry come fonte unica. Test mirato:
  `template_catalog_response_exposes_read_only_gallery_metadata`.
  **Sedicesima slice template gallery UI (2026-06-23, locale/verde):**
  il plugin Presentations legge `coreBridge.templateCatalog()` e mostra una
  gallery filtrabile `Tutti/Presentazioni/Documenti` con token `design_*`,
  layout archetype e copia del `template_ref`. La UI non duplica template e non
  introduce routing euristico; usa solo il catalogo esposto dal gateway. La
  card non finge una preview grafica quando manca un `preview_ref` reale. Gate:
  `npm run build`.
  **Diciassettesima slice built-in preview (2026-06-24, locale/verde):**
  i seed locali `monet/*` dichiarano `preview_ref` `builtin:template-preview/*`.
  Il plugin Presentations materializza quelle preview dai token del catalogo
  (`design_theme`, layout archetype, componenti) e mantiene il fallback
  contract-only per cataloghi esterni senza preview. I template restano entry
  read-only del registry unico, non tool callable né secondo renderer. Gate:
  `cargo test -p local-first-desktop-gateway template_catalog -- --nocapture`,
  `npm run test:ui-contract`, `npm run build`.
  **Correzione smoke provider (2026-06-23):** quando un modello `*:cloud` passa
  dal provider locale Ollama, la UI lo etichetta `☁ via local` invece di cloud
  generico; se Ollama locale non risponde il workflow fallisce correttamente
  prima del render. La binding remota va fatta sul provider cloud effettivo.
  **Correzione workflow guardrail (2026-06-23):** durante una route workflow
  one-call il gateway rifiuta tool diversi dal workflow selezionato, anche se
  arrivano da MCP/connector caricati dopo il pruning. Questo impedisce fallback
  manuali tipo `mcp__filesystem__create` dopo un errore `make_deck`.
  Chiarimento importante: i `template_ref` `monet/*` attuali sono seed locali
  del catalogo Homun; MCP Monet resta un adapter futuro, non una dipendenza
  runtime della generazione. **Correzione artifact post-QA (2026-06-23):** se
  `deck-render` produce file ma `deck-qa` segnala problemi, il gateway emette
  comunque le card artifact e registra memoria/provenance, accompagnandole con
  warning QA. Verifica runtime: Ollama locale risponde, ma `kimi-k2.6:cloud`
  via Ollama restituisce reasoning-only (`content` vuoto), quindi va trattato
  come provider incompatibile per il JSON schema deck. **Correzione active
  streams (2026-06-23):** la sidebar non deve restare in stato working dopo un
  evento `done/error`; `active_streams` ora tratta il terminal marker come fonte
  sufficiente nello stesso punto di emissione del gateway, anche se il cleanup
  finale è ancora in post-processing, e marca stale gli stream senza eventi
  recenti per evitare lampeggi infiniti dopo cambio chat. Il resume marker
  frontend è ora scadibile e i marker legacy senza timestamp vengono eliminati,
  evitando riattach a stream vecchi dopo restart/reload; i marker della stessa
  sessione riattaccano solo la preview live, non un secondo commit. Follow-up:
  `/api/local-computer/live` espone il `thread_id` proprietario e la UI filtra il
  dock Computer per chat e solo quando browser/terminal sono running; il pannello
  inline Computer legacy non si apre più solo per timeline/artifact completati.
  La branch streaming usa `AssistantMessageBody`, quindi plan/progress/markdown
  sono renderizzati progressivamente come nel messaggio finale. **Guardrail WS4
  aggiunto (2026-06-24):** `test:ui-contract` blocca la regressione del pannello
  inline e il dock Computer passa a polling adattivo (600ms attivo, 2500ms idle).
- ☐ **7.1b (futuro)** Portare ricerca/meeting al livello del deck solo dopo il
  chiarimento sul contratto strumenti: `make_research` e `make_meeting` non sono
  essenziali per la prossima release.
- ☐ **7.2** Contratto di personalizzazione addon (zona bloccata + overlay-dato),
  3 origini (installati/scritti/generati).
- ☐ **7.3** Deliverable come **entità di memoria** + provenienza (lega WS2/WS5).

## WS8 — Eval suite cross-modello (guardrail)

Il caposaldo #2 ("funziona sul tier locale") oggi è verificato solo sul deck
(`scripts/eval_deck_content.py`). Serve un **guardrail trasversale**.

- 🟡 **8.1** Suite di eval sui **flussi chiave** sul **modello locale di base**.
  *Seed fatto:* `scripts/eval_suite.py` (deck · piano · decisione-con-perché —
  structured-output a livello modello). **Slice 2026-06-24 locale/verde:** aggiunto
  check documento strutturato con `docx` obbligatorio, `HOMUN_EVAL_BASE` per
  cambiare endpoint e flush progressivo durante run lunghi; smoke
  `python3 scripts/eval_suite.py gemma4:latest 1` passato su
  deck/document/plan/decision/open_loop. **Slice gateway contract (2026-06-24,
  locale/verde):** la suite supporta `HOMUN_EVAL_GATEWAY_BASE` +
  `HOMUN_EVAL_GATEWAY_TOKEN` e verifica `/api/templates/catalog` (template
  non-callable con preview built-in) e `/api/capabilities/snapshot` sul gateway
  reale. Verifica runtime passata su `127.0.0.1:18765`. Da estendere: tool-call
  emission + render end-to-end + ricerca/meeting quando esistono (WS7).
- ☐ **8.2** Eval memoria (= WS5.6): chat nuova → "stato + perché" → deve rispondere.
- ☐ **8.3** Gate pre-release: nessuna pubblicazione se la suite non è verde sul tier base.

## WS9 — Distribuzione plugin & marketplace

Da "app con plugin" a **piattaforma**: i plugin/addon (WS7) devono avere ciclo di vita
proprio — versioning, canali, scaricabili dal **sito Homun**, auto-aggiornabili, alcuni
**a pagamento**. ADR 0011 (addon) + nuovo ADR dedicato (distribuzione & licensing).
*"Predisporre la struttura ora, monetizzare dopo."*

- ☐ **9.1 Manifest plugin**: `semver` + `channel` (stable/beta) + `min_homun_version`
  (compat) + `entitlement` (free/paid) + firma + capability dichiarate (contratto ADR 0011).
- ☐ **9.2 Registry/catalogo sul sito Homun**: indice JSON + pacchetti **firmati** (modello
  come l'auto-update dell'app: feed separato per i plugin).
- ☐ **9.3 Plugin manager in-app**: installa da registry · beta opt-in per-plugin ·
  controllo aggiornamenti + **auto-update** (confronto versioni).
- ☐ **9.4 Sicurezza**: firma **Ed25519** verificata all'install/update; `stable`=firmato,
  `beta`=opt-in; esecuzione contenuta (ADR 0009) + `skill_security` scan.
- ☐ **9.5 Licensing/paid (predisporre ora)**: campo `entitlement` nel manifest + **token
  di licenza firmato** verificabile **offline** + ri-check periodico. Il paywall vero
  (account + pagamenti, es. Stripe) è fase successiva e **lega cloud/always-on**.
- ☐ **9.6 ADR** "distribuzione & licensing plugin" (formalizza il contratto).

> Dipendenze: 9.1-9.4 sono local-first-compatibili e fattibili da subito; 9.5 (paid) ha
> bisogno di **account + backend pagamenti** → arriva con cloud/always-on. WS9 poggia su
> WS7 (i plugin) e sul contratto addon ADR 0011.

## WS4 — Qualità, affidabilità, UX

- 🟡 **UI perf su chat pesanti** — il renderer arrivava al **99% CPU** (immagini grandi
  + log lunghi + piano gonfio): memoizzare i render pesanti + rallentare i polling
  quando idle. Prima slice: polling adattivo del dock Computer e contratto UI
  anti-regressione. Seconda slice: `RichMessage` e `RichMessageRenderer` sono
  memoizzati, con contratto UI dedicato, per non ricalcolare markdown pesante sui
  messaggi completati invariati; restano altri polling/render specifici.
- ✅ **Provider Settings robustness (2026-06-24):** le card preset provider
  matchano prima per id stabile e poi per URL. Questo mantiene Z.ai standard e
  Z.ai Coding come preset separati anche se un endpoint legacy/cambiato non
  coincide esattamente con il preset corrente; `test:ui-contract` blocca gli
  endpoint Z.ai standard/coding e il matching id-first.
- ✅ **Artifact location UX (2026-06-24):** i marker `make_deck`/`make_document`
  includono `managed_path` e le card chat mostrano una riga path compatta sotto
  ogni artifact managed; resta invariato il download/preview e la memoria
  canonica resta la fonte per provenance/lifecycle.
- ✅ **Computer owner hardening (2026-06-24):** il dock live richiede `thread_id`
  esplicito quando c'è attività browser/terminal; `thread_id=null` non può più
  rendere un'attività visibile in tutte le chat. Contratto UI aggiornato.
- ✅ **Seeder skill fragile (2026-06-24):** il seed record delle default skills
  hasha ora l'intero skill tree, non solo `SKILL.md`; cambi a script/asset
  bundled aggiornano una skill non editata dall'utente e restano bloccati se il
  tree su disco diverge dal record seeded. Test mirato:
  `skill_tree_hash_tracks_script_changes`.
- ☐ **Immagini deck con testo storpiato** ("no text" ignorato) — limite del modello
  immagine; mitigare prompt o accettare.
- ✅ **Ruolo immagine opzionale (2026-06-24):** Settings → Model per task mostra
  un hint quando `image_generation` non ha modelli immagine disponibili; i deck
  possono comunque essere creati, ma l'utente vede che usciranno senza immagini
  generate finché non abilita/aggiorna un provider image-capable. Contratto UI:
  `imageRoleMissingHint`.
- ☐ **Lentezza locale** — un 31B locale ~55s/chiamata; suggerire in UI un modello
  locale più piccolo (7-12B) per reattività, restando vero-locale.

---

## Ordine d'esecuzione proposto

1. **WS6 locale consolidata/committata** — publish/tag solo su comando. Lo smoke
   manuale in-app su scheduled automation reale ha prodotto un fix post-smoke
   contro le false chiusure; prima del publish resta utile ripetere il gate con
   il binario aggiornato.
2. **WS2-3.2b / 3.3** — completare export ZIP/filtri: central surface e
   lifecycle/delete sono cablati e passati in-app.
3. **WS5.5 / WS5.6** — catena di provenienza decisione → artefatto → codice →
   esito, più eval memoria come guardrail.
4. **WS1-Fase 2** — gestione piano (`ExecutionPlan`+`step_id`); write-back
   piano→memoria e grafo piano/step locali/verdi, resta convergere sul tipo
   `ExecutionPlan`.
6. **WS1-Fase 3** — skill dichiarative + workflow runner.
7. **WS7** — ecosistema deliverable: prima design system condiviso per
   `make_document` e `make_deck`/presentation; ricerca e meeting restano alla
   fine.
8. **WS8 completo + WS4** — eval come gate di release, perf/affidabilità/UX a
   regime.
9. **WS9 + WS1-Fasi 4→6** — marketplace/plugin distribution, router+scaffolding
    adattivo, Brain (ADR 0008), memoria per-step + sub-agent.

> Note: la **memoria (WS5)** è il filo trasversale (artefatti→memoria e piano→memoria la
> alimentano). La **gestione piano (WS1-Fase 2)** è il refactor più profondo: dopo i quick
> win e le fondamenta memoria, prima delle Fasi 3-6 che ci si appoggiano. **Cloud /
> always-on** (canali 24/7, proattività continua, self-hostable — `self-host.md`) resta
> direzione **futura**, non in questo ciclo. **Sub-agent** maturano dentro WS1-F6.
