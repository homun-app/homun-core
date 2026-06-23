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

Prima di pubblicare/taggare resta prudente un smoke manuale in-app su una
automazione schedulata reale che compaia nel thread `scheduled`. Non è bloccante
per iniziare il consolidamento memoria in locale.

## Milestone

1. WS5.5b/5.6 — collegare decisioni/piano agli artifact con evidenza esplicita,
   poi aggiungere eval memoria sulla catena di provenienza.
2. WS1-Fase 2/3 — piano runtime-owned e workflow runner dichiarativo, così i
   deliverable futuri non riaprono fragilità cross-modello.
3. WS7 — deliverable Manus-style (`make_document`, `make_research`,
   `make_meeting`) solo dopo memoria/artefatti/engine baseline.

## Blocco noto

Nessun blocco tecnico attivo. Il rischio principale è costruire altri
deliverable prima che il sistema sappia ricordarli, ritrovarli, cancellarli e
collegarli al perché. Per questo WS7 non è più il prossimo step.

## Prossima azione

Proseguire con WS5.5b: collegare decisioni/piano agli artifact usando evidenza
esplicita già presente in memoria/metadata, senza inferenze fragili. Subito dopo:
WS5.6 eval memoria sulla domanda “quali artifact per il progetto X e da quale
decisione/lavoro derivano?”. Il gate lifecycle/delete/export degli artifact è
passato in-app e WS5.5a ha iniziato la provenance graph canonica. Il contratto
corrente della memoria è in [MEMORIA.md](MEMORIA.md).
