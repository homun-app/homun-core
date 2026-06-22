# Homun roadmap operativa

## Obiettivo attivo

Consolidamento memoria + artefatti prima dell'espansione deliverable: chiudere
il buco per cui i deliverable sono file su filesystem ma non ancora entità
ricordabili, ricercabili e governate dal lifecycle. WS7 resta importante, ma
viene spostato dopo le fondamenta memoria/artefatti/engine.

## Fase corrente

WS6 è chiusa localmente:

1. WS6.1 — approval resume, Path B workspace-scoped Filesystem, Telegram UX.
2. WS6.2 — Resource Governor: recovery, visibility, stress gate.
3. WS6.3 — scheduler/ricorrenza + proactive review: recurrence parity,
   scheduled/proactive prompt thread, card surface/dedup.
4. WS6.4 — write-back delle azioni proattive in memoria (`open_loop`/`decision`).

Prima di pubblicare/taggare resta prudente un smoke manuale in-app su una
automazione schedulata reale che compaia nel thread `scheduled`. Non è bloccante
per iniziare il consolidamento memoria in locale.

## Milestone

1. WS2-3.1 — artefatti come entità di memoria via `MemoryFacade` condiviso:
   `title/type/project/path/thread/created_at` + embedding. Slice locale/headless
   implementata; manca gate in-app e recall esplicito del deliverable.
2. WS2-3.2/3.3 — schermata Artifacts centralizzata + lifecycle/delete coerente
   con la memoria.
3. WS5.5/5.6 — catena di provenienza decisione → artefatto → codice → esito,
   più eval memoria.
4. WS1-Fase 2/3 — piano runtime-owned e workflow runner dichiarativo, così i
   deliverable futuri non riaprono fragilità cross-modello.
5. WS7 — deliverable Manus-style (`make_document`, `make_research`,
   `make_meeting`) solo dopo memoria/artefatti/engine baseline.

## Blocco noto

Nessun blocco tecnico attivo. Il rischio principale è costruire altri
deliverable prima che il sistema sappia ricordarli, ritrovarli, cancellarli e
collegarli al perché. Per questo WS7 non è più il prossimo step.

## Prossima azione

Chiudere il gate in-app di WS2-3.1: creare un artifact reale, verificare che
compaia come `memory_type="artifact"` + entity `artifact` nel DB memoria e che
sia richiamabile in una chat successiva. Il contratto corrente della memoria è
in [MEMORIA.md](MEMORIA.md).
