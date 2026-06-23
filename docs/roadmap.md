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

Prima di pubblicare/taggare resta prudente un smoke manuale in-app su una
automazione schedulata reale che compaia nel thread `scheduled`. Non è bloccante
per iniziare il consolidamento memoria in locale.

## Milestone

1. WS5.6 — completare eval memoria sullo stato workflow: nuova chat deve
   recuperare “a che punto siamo?” e “perché?” da open loop/goal/outcome/piano.
2. WS1-Fase 2/3 — piano runtime-owned e workflow runner dichiarativo, così i
   deliverable futuri non riaprono fragilità cross-modello.
3. WS7 — deliverable Manus-style (`make_document`, `make_research`,
   `make_meeting`) solo dopo memoria/artefatti/engine baseline.

## Blocco noto

Nessun blocco tecnico attivo. Il rischio principale è costruire altri
deliverable prima che il sistema sappia ricordarli, ritrovarli, cancellarli e
collegarli al perché. Per questo WS7 non è più il prossimo step.

## Prossima azione

Proseguire con WS5.6 sulla domanda “a che punto è il workflow e perché?”. La
domanda artifact/provenance ha ora un primo reader/eval headless verde: il RAG e
`recall_memory` attraversano il grafo canonico per producer, path, decisione/lavoro
sorgente e rationale. Il contratto corrente della memoria è in [MEMORIA.md](MEMORIA.md).
