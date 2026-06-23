# Homun roadmap operativa

## Obiettivo attivo

Consolidamento memoria + artefatti prima dell'espansione deliverable: chiudere
il buco per cui i deliverable sono file su filesystem ma non ancora entità
ricordabili, ricercabili e governate dal lifecycle. WS7 resta importante, ma
viene spostato dopo le fondamenta memoria/artefatti/engine.

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
13. WS1-Fase 2 — prima slice piano→memoria: ogni `update_plan` / `step_advance`
    aggiorna un solo `open_loop` canonico `source="runtime_plan"` per thread,
    con prossimo step e conteggi; a completamento il record viene marcato stale e
    `stato-lavori.md` è rigenerato come vista derivata.
14. WS1-Fase 2 — grafo piano/step: lo stesso write-back materializza entity piano
    e step nel grafo canonico, con relazioni `describes`, `relates_to`/`has_step`
    e `depends_on` quando esplicito.
15. WS1-Fase 2 Slice 3a — il write-back canonico del piano include anche
    `metadata.execution_plan` nel contratto `ExecutionPlan` del crate
    `orchestrator`; `update_plan` conserva `depends_on` espliciti dal flusso
    reale. Resta da promuovere `ExecutionPlan` a stato runtime primario.
16. WS1-Fase 2 Slice 3b — il loop agente usa `ExecutionPlan` come stato runtime
    canonico; lo snapshot `Vec<Value>` resta solo vista derivata per marker UI,
    memoria/grafo e verifica step.
17. WS1-Fase 3a — `make_deck` ha una `WorkflowDefinition` harness-owned
    proiettata in `ExecutionPlan` con DAG e contratto `DeckWorkflow`; il modello
    continua a vedere un solo tool.
18. WS1-Fase 3c — `ExecutionPlan` include `plan_propose` come contratto
    strutturato per piani da approvare prima dell'esecuzione.
19. WS1-Fase 3b/F5 — `OrchestratorBrain::run_plan` esegue workflow
    dichiarativi già costruiti dall'harness usando gli stessi provider,
    task-runtime, dipendenze e subagent path dei piani planner-generated.
20. WS1-Fase 6a — il loop principale scrive outcome per-step come `fact`
    confermate `source="runtime_plan_step"` nel `MemoryFacade` canonico, con
    criterio ed evidenze della verifica; il piano resta l'unico `open_loop`.
21. WS1-Fase 6b — gli outcome completati dei task `subagent.*` riusano lo
    stesso write-back per-step, con evidence redatta `source="subagent_task"`.
22. WS1-Fase 3d — `make_deck` passa la propria `WorkflowDefinition` /
    `ExecutionPlan` attraverso `OrchestratorBrain::run_plan` prima della
    pipeline deterministica, senza planner LLM e senza store parallelo.
23. WS1-Fase 4 — router workflow|agent harness-owned: deck/presentation/slide/pptx
    vanno a `make_deck` con scaffolding `maximum`; richieste generiche restano
    nel loop agente.
24. Post-smoke v0.1.1045 — fix locale su due regressioni osservate nello smoke
    deck reale: il composer non è più ridimensionabile manualmente fino a
    espandere la chat, e il recall artifact/provenance ora espone `managed_path`,
    workflow `make_deck`/`DeckWorkflow` e outcome `runtime_plan_step`.

Prima di pubblicare/taggare resta prudente ripetere lo smoke manuale in-app su
una automazione schedulata reale con il binario aggiornato. Il primo smoke ha
trovato e corretto una falsa chiusura su piano non completato.

## Milestone

1. Completare verifica allargata della nuova slice `ExecutionPlan` runtime.
2. WS1-Fase 2/3 — piano runtime-owned e workflow runner dichiarativo, così i
   deliverable futuri non riaprono fragilità cross-modello.
3. WS7 — deliverable Manus-style (`make_document`, `make_research`,
   `make_meeting`) solo dopo memoria/artefatti/engine baseline.

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
release ha corretto composer e recall provenance/status. Prossimo: ripetere smoke
in-app sul fix e poi generalizzare documenti/ricerca/meeting. Il contratto
corrente della memoria è in [MEMORIA.md](MEMORIA.md).
