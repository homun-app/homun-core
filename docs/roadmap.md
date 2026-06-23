# Homun roadmap operativa

## Obiettivo attivo

Consolidamento memoria + artefatti completato abbastanza da riprendere
l'espansione deliverable con un vincolo nuovo: Homun deve arrivare a documenti e
presentazioni di qualità alta tramite un **design system dichiarativo condiviso**
per temi, layout, componenti, template e QA visuale. Non si aggiungono gallery o
`make_*` isolati: `make_document`, `make_deck`/presentation e i futuri plugin
consumano la stessa grammatica dal registry unico.

## Fase corrente

WS6 è chiusa localmente; WS2-3.1 è passata in runtime e WS2-3.2c/3.3 ha un
primo percorso locale verde:

1. WS6.1 — approval resume, Path B workspace-scoped Filesystem, Telegram UX.
2. WS6.2 — Resource Governor: recovery, visibility, stress gate.
3. WS6.3 — scheduler/ricorrenza + proactive review: recurrence parity,
   scheduled/proactive prompt thread, card surface/dedup.
4. WS6.4 — write-back delle azioni proattive in memoria (`open_loop`/`decision`).
   Post-smoke scheduled automation: la gestione condivisa del piano considera
   completo solo `done == total`, quindi una risposta con solo piano intermedio
   non viene più marcata come completata.
5. WS2-3.1 — artifact come `memory_type="artifact"` + entity grafo + embedding,
   inclusi file in-place scritti via Filesystem MCP dentro root progetto.
6. WS2-3.2a — il Workbench Artifacts legge anche gli artifact memoria e mostra
   i file di progetto con preview jailata via `fsFile`.
7. WS2-3.2b/3.3 — Settings riceve anche gli artifact memoria da
   `/api/artifacts/usage`; delete chat non cancella deliverable; delete esplicito
   memoria rimuove file in root autorizzate e tombstona memoria/entity. Gate
   in-app Settings passato con artifact usa-e-getta; chat delete preserva file.
   La surface è dedicata “Artifacts”, non più dentro Local computer.
8. WS2-3.2c — Settings → Artifacts ha filtri gruppo/progetto, sorgente, tipo e
   stato `memory-linked`/`orphan`, selezione multipla ed export ZIP via
   `POST /api/artifacts/export`. Il backend rilegge i `MemoryRef` canonici per
   gli artifact memoria e valida le root autorizzate prima di includerli nel
   bundle. Smoke API e click-download in-app passati con ZIP valido che include
   sia artifact managed sia artifact memoria.
9. WS5.5a — gli artifact memoria ora materializzano provenance graph canonica:
   producer tool `produced` artifact, artifact `belongs_to_project` progetto e,
   per file in root progetto, artifact `relates_to` file. Il vocabolario memory
   include anche `rationale_for`, `produced`, `derived_from`.
10. WS5.5b — prima slice evidence-only: decisioni con `affects_labels` espliciti
    o metadata artifact con ref canoniche (`decision_refs`, `plan_refs`,
    `task_refs`, `source_memory_refs`, `derived_from_refs`) creano archi
    `affects` / `derived_from` nel grafo canonico. Nessun matching semantico o
    store parallelo.
11. WS5.6 — prima slice eval/reader: recall esplicito e RAG automatico leggono la
    provenance artifact dal grafo canonico e possono rispondere quali artifact
    esistono e da quale decisione/lavoro derivano, includendo il perché.
12. WS5.6 — seconda slice eval/reader: recall esplicito e RAG automatico leggono
    `goal`, `open_loop`, outcome/fact verificati, decisioni con rationale e
    artifact provenance per rispondere “a che punto siamo?” e “perché?”.
13. WS5.6 — gate release memoria: un test unico pre-release verifica in una
    nuova chat simulata artifact/provenance/decisione e workflow status/perché,
    inclusi producer/workflow, path gestito, rationale, alternative scartate,
    goal/open-loop e outcome verificato.
14. WS1-Fase 2 — prima slice piano→memoria: ogni `update_plan` / `step_advance`
    aggiorna un solo `open_loop` canonico `source="runtime_plan"` per thread,
    con prossimo step e conteggi; a completamento il record viene marcato stale e
    `stato-lavori.md` è rigenerato come vista derivata.
15. WS1-Fase 2 — grafo piano/step: lo stesso write-back materializza entity piano
    e step nel grafo canonico, con relazioni `describes`, `relates_to`/`has_step`
    e `depends_on` quando esplicito.
16. WS1-Fase 2 Slice 3a — il write-back canonico del piano include anche
    `metadata.execution_plan` nel contratto `ExecutionPlan` del crate
    `orchestrator`; `update_plan` conserva `depends_on` espliciti dal flusso
    reale. Resta da promuovere `ExecutionPlan` a stato runtime primario.
17. WS1-Fase 2 Slice 3b — il loop agente usa `ExecutionPlan` come stato runtime
    canonico; lo snapshot `Vec<Value>` resta solo vista derivata per marker UI,
    memoria/grafo e verifica step.
18. WS1-Fase 3a — `make_deck` ha una `WorkflowDefinition` harness-owned
    proiettata in `ExecutionPlan` con DAG e contratto `DeckWorkflow`; il modello
    continua a vedere un solo tool.
19. WS1-Fase 3c — `ExecutionPlan` include `plan_propose` come contratto
    strutturato per piani da approvare prima dell'esecuzione.
20. WS1-Fase 3b/F5 — `OrchestratorBrain::run_plan` esegue workflow
    dichiarativi già costruiti dall'harness usando gli stessi provider,
    task-runtime, dipendenze e subagent path dei piani planner-generated.
21. WS1-Fase 6a — il loop principale scrive outcome per-step come `fact`
    confermate `source="runtime_plan_step"` nel `MemoryFacade` canonico, con
    criterio ed evidenze della verifica; il piano resta l'unico `open_loop`.
22. WS1-Fase 6b — gli outcome completati dei task `subagent.*` riusano lo
    stesso write-back per-step, con evidence redatta `source="subagent_task"`.
23. WS1-Fase 3d — `make_deck` passa la propria `WorkflowDefinition` /
    `ExecutionPlan` attraverso `OrchestratorBrain::run_plan` prima della
    pipeline deterministica, senza planner LLM e senza store parallelo.
24. WS1-Fase 4 — router workflow|agent harness-owned: deck/presentation/slide/pptx
    vanno a `make_deck` con scaffolding `maximum`; richieste generiche restano
    nel loop agente.
25. Post-smoke v0.1.1045 — fix locale su due regressioni osservate nello smoke
    deck reale: il composer non è più ridimensionabile manualmente fino a
    espandere la chat, e il recall artifact/provenance ora espone `managed_path`,
    workflow `make_deck`/`DeckWorkflow` e outcome `runtime_plan_step`.
26. WS1 generalizzazione deliverable — `make_document` ha ora una
    `WorkflowDefinition` harness-owned (`DocumentWorkflow`) proiettata in
    `ExecutionPlan`, passa da `OrchestratorBrain::run_plan`, viene instradato dal
    router workflow|agent per richieste esplicite di scrittura documenti/report e
    registra l'artifact Markdown in memoria con provenance canonica. Post-smoke:
    il percorso è async-safe nel runtime Tokio, il toolset viene ristretto al
    workflow anche dopo MCP/Composio injection e il nome artifact esplicito viene
    preservato (`homun-smoke-document.md`).
27. WS1/WS7 document focus — `make_document` viene arricchito prima di creare
    altri strumenti: supporta formati `md`/`pdf` dallo stesso Markdown canonico e
    registra ogni artifact prodotto in memoria/provenance con producer
    `make_document`. `make_research` e `make_meeting` sono spostati alla fine.
28. WS1-Fase 4b — nuova visione capability registry: i workflow `make_*` non
    devono più vivere come keyword sparse o tool sempre esposti. Workflow nativi,
    MCP, skills/addon, connector tools e strumenti atomici entrano in un registry
    unico interrogabile; il router recupera candidati semanticamente, sceglie con
    decisione strutturata e carica nel toolset live solo le capability minime.
29. WS1-Fase 4b prima slice — `make_deck` e `make_document` sono ora entry di un
    registry nativo condiviso da router e `find_capability`: “pitch per Homun”
    recupera `make_deck` senza keyword `slide`/`pptx`, i `make_*` non vengono
    duplicati nel corpus deferred, e il workflow scelto resta nel live toolset
    anche dopo lo split core/deferred.
30. WS1-Fase 4b seconda slice — il router produce una decisione strutturata
    interna (`Workflow`/`AtomicTool`/`AgentLoop`) con ragione e alternative. Prima
    conflict policy: creazione report PDF usa `make_document`; estrazione,
    unione o conversione PDF restano operazioni atomiche e non attivano
    `make_document`.
31. WS1-Fase 4b terza slice — il loop agente usa la stessa decisione strutturata
    per system prompt, route workflow e trace runtime: la scelta viene emessa come
    `ACT` e aggiunta a `tool_trace`, quindi resta auditabile e disponibile al
    learning post-turn senza store paralleli.
32. WS1-Fase 4b quarta slice — `pdf_atomic` è una capability atomica nativa nel
    registry/corpus e mappa a un tool reale (`run_in_sandbox`) per operazioni su
    PDF esistenti; la route atomica carica quel tool nel live toolset e non
    attiva `make_document`.
33. WS1-Fase 4b quinta slice — i tool MCP connessi entrano nel corpus unico
    `find_capability` come `McpTool` tipizzati, con schema attivabile nello
    stesso live toolset; quando non sono always-loaded non vivono più in un ramo
    parallelo fuori registry.
34. WS1-Fase 4b sesta slice — i tool Composio/connector recuperati da
    `find_capability` restano toolkit-aware ma vengono convertiti in
    `CapabilityEntry` source `ConnectorTool`; anche questa sorgente ora parla il
    contratto typed del registry invece di emettere righe speciali fuori tipo.
35. WS1-Fase 4b settima slice — la ricerca connector usa
    `search_connector_capability_entries` e restituisce direttamente entry
    `ConnectorTool` typed, mantenendo il set toolkit-aware; `find_capability`
    consuma lo stesso shape per native/MCP/connector. Smoke in-app passato:
    discovery Gmail unread + lettura reale ultime 3 email non lette.
36. WS1-Fase 4b ottava slice — `find_capability` aggiunge al `tool_trace` una
    riga `capability discovery ... -> source:key` derivata dalle `CapabilityEntry`
    tipizzate; la scelta registry entra nell'audit/learning del turno senza store
    paralleli.
37. WS1-Fase 4b nona slice — l'esecuzione di capability connesse entra nel
    `tool_trace` come `capability execution connector:TOOL` o
    `capability execution mcp:TOOL`, inclusi read connector come Gmail.
38. Runtime chat bugfix — lo stream resume marker ora porta un `ownerId`: la
    stessa sessione JS non può auto-resumare e duplicare user/assistant, mentre il
    resume dopo vero reload resta disponibile. Gate in-app Gmail passato.
39. WS1/WS7 document focus — `make_document` ora materializza anche `.docx`
    editabile dalla stessa sorgente Markdown canonica, oltre a `md`/`pdf`, con
    package OOXML generato in-process e registrazione artifact/memoria invariata.
40. WS1/WS7 document focus — `make_document` ora accetta struttura/stile
    espliciti (`document_type`, `audience`, `tone`, `sections`) nello stesso
    schema tool; il workflow li usa come contratto di generazione solo se
    dichiarati, senza attivazioni euristiche o nuovi registry paralleli.
41. WS1/WS7 document focus — il renderer DOCX di `make_document` traduce le
    tabelle pipe Markdown in tabelle Word reali (`w:tbl`) con escaping XML,
    mantenendo sorgente Markdown canonica e registrazione artifact invariata.
42. WS1/WS7 document focus — feedback smoke reale DOCX: il file era valido ma
    troppo grezzo. Il renderer ora include `styles.xml`, converte bold/italic
    Markdown in run Word, promuove il primo titolo e gestisce liste numerate.
43. WS1/WS7 document focus — secondo feedback smoke DOCX: tabelle leggibili ma
    non adattate alla pagina. Il renderer ora emette tabelle full-width con
    `tblGrid`, layout fixed, celle percentuali, padding e proporzione 35/65 per
    tabelle a due colonne.
44. WS1/WS7 document focus — `make_document` ha un `layout_profile` dichiarativo
    nello stesso schema tool (`standard`, `one_page`, `executive_brief`,
    `detailed_report`, `proposal`); il profilo diventa direttiva di generazione
    esplicita, non un nuovo workflow e non una euristica di routing.
45. WS7 direction — deliverable design system condiviso: documenti e
    presentazioni/plugin convergono su temi, layout, componenti, template e QA
    visuale comuni. Il modello sceglie struttura e blocchi dal registry; renderer
    deterministici producono `.docx`, `.pptx`, `.pdf`/HTML. Una gallery può
    esistere come UI/catalogo sopra questa grammatica, non come secondo sistema.
46. WS7 first shared design contract — `make_document` e `make_deck` espongono lo
    stesso `design_profile` dichiarativo (`executive`, `sales_pitch`,
    `technical`, `editorial`, `minimal`), lo portano nel workflow e lo traducono
    in direttive specifiche per documento o deck. È il primo pezzo di grammatica
    condivisa; non è ancora template library completa né QA visuale.
47. WS7 shared component contract — `make_document` e `make_deck` espongono anche
    `design_components` condiviso (`kpi_grid`, `timeline`, `comparison_table`,
    `quote_callout`, `process_steps`, `risks_table`), deduplicato e bounded. È
    ancora composer contract: i layout fisici del renderer e la gallery template
    arrivano dopo.
48. WS7 deck component materialization — in `make_deck`, i componenti dichiarativi
    ora vengono applicati deterministicamente al deck JSON prima del render:
    `kpi_grid` usa layout `kpi`, `quote_callout` usa `quote`, gli altri componenti
    usano `two_column`, tutti già supportati da `deck_render.py`. Non ancora
    esteso al renderer DOCX e non ancora gallery/template library.

Prima di pubblicare/taggare resta prudente ripetere lo smoke manuale in-app su
una automazione schedulata reale con il binario aggiornato. Il primo smoke ha
trovato e corretto una falsa chiusura su piano non completato.

## Milestone

1. Completare verifica allargata della nuova slice `ExecutionPlan` runtime.
2. WS1-Fase 2/3 — piano runtime-owned e workflow runner dichiarativo, così i
   deliverable futuri non riaprono fragilità cross-modello.
3. WS1/WS7 deliverable design system — smoke reale del nuovo `layout_profile`
   quando serve la prossima release, poi introdurre template/componenti
   dichiarativi condivisi da `make_document` e `make_deck`/presentation.
4. WS7 — deliverable Manus/Z.ai-style: prima qualità di documenti e
   presentazioni tramite design system + composer + renderer + QA; solo dopo
   ragionare su `make_research` e `make_meeting`.

## Blocco noto

Nessun blocco tecnico attivo. Il rischio principale è costruire altri
deliverable prima che il sistema sappia ricordarli, ritrovarli, cancellarli e
collegarli al perché. Per questo WS7 non è più il prossimo step.

## Prossima azione

WS1 ha ora write-back piano→memoria, prima materializzazione grafo piano/step,
proiezione `ExecutionPlan` nei metadata canonici, `ExecutionPlan` come stato
runtime primario del loop agente, una prima `WorkflowDefinition` per `make_deck`
e outcome per-step confermati nel loop principale e nei sub-agent. `make_deck`
entra ora nel Brain con `run_plan` prima della pipeline deterministica.
Il router workflow/agent instrada i deck a scaffolding massimo. Il primo smoke
release ha corretto composer e recall provenance/status. La prima
generalizzazione documenti è locale/verde su `make_document` e ha superato smoke
API reale con artifact gestito + memoria/provenance canonica. Il registry nativo
dei workflow `make_deck`/`make_document` è locale/verde e alimenta router e
corpus `find_capability`; la decisione strutturata ora distingue workflow,
atomici PDF e agent loop con ragione esplicita; il loop agente emette la route
come `ACT` e la aggiunge al `tool_trace` del turno. `pdf_atomic` ora è una
capability atomica nativa mappata a `run_in_sandbox`. MCP e connector Composio
parlano ora il contratto typed del registry (`McpTool`, `ConnectorTool`), e la
ricerca connector restituisce direttamente entry typed mantenendo il set
toolkit-aware per non perdere CRUD/perimeter; smoke Gmail unread passato in app.
`find_capability` ora traccia discovery ed execution delle capability connesse
nel `tool_trace`. Lo smoke Gmail ha anche corretto una duplicazione chat causata
dal resume marker riusato nella stessa sessione JS.
`make_document` supporta anche output `.docx` editabile, parametri espliciti di
struttura/stile e tabelle Word generate da Markdown; lo smoke reale ha corretto
anche stili, grassetto, corsivo, liste numerate e sizing tabelle nel DOCX.
`layout_profile` è ora dichiarativo dentro `make_document`. Scelta corrente:
sviluppare WS7 come design system condiviso per documenti e presentazioni
(`make_deck`/presentation inclusi): template e layout sono grammatica del
registry, non keyword o nuovi tool ad hoc. Prima slice locale/verde:
`design_profile` condiviso fra `make_document` e `make_deck`; seconda slice:
`design_components` condiviso per KPI, timeline, confronti, callout, processi e
rischi; terza slice: materializzazione fisica lato deck nei layout `kpi`,
`quote` e `two_column`. Prossima slice: DOCX component rendering o QA visuale
renderizzata. `make_research` e `make_meeting` restano futuri.
Il contratto corrente della memoria è in [MEMORIA.md](MEMORIA.md).
