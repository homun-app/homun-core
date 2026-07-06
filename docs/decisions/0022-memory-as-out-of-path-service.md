# Decision 0022: La memoria come servizio out-of-path (MemoryFacade dietro flag)

Date: 2026-07-06

## Status

**Proposed.** Formalizza una direzione già citata come corrente (in `CLAUDE.md` e nella memoria
di lavoro) ma **non ancora implementata**. Discende dal **caposaldo #1** (la memoria è il
differenziatore e l'**unico layer condiviso**: tutto vi passa, mai store paralleli) e si appoggia
alla [0016](0016-harness-owned-task-engine-cross-model.md)/[0021](0021-single-guarded-loop-planning-as-tool.md)
(l'harness possiede il control flow attorno al loop unico).

> ⚠️ **Stato reale del codice (verificato 2026-07-06):** `crates/memory` esiste (~6k righe,
> `MemoryFacade`, `graph`, `lifecycle`, `operations`), ma i flag `HOMUN_MEMORY_SERVICE` e
> `HOMUN_MEMORY_POOL` **non esistono** (0 occorrenze). L'orchestrazione di memoria
> (`recall`/`learn`/`consolidate`/`brief`) vive ancora **in-path** dentro
> `crates/desktop-gateway/src/main.rs`. Questo ADR è la **decisione di estrarla**, non un fatto compiuto.

## Perché questa decisione esiste

La memoria è invocata da ogni capability (chat, canali, automazioni, subagenti). Oggi la sua
orchestrazione è intessuta nel monolite `main.rs`, il che rischia due antipattern che i capisaldi
vietano:

- **Store paralleli / letture divergenti**: quando la logica di recall/write-back è duplicata nei
  vari call-site invece di passare per un unico facade, nascono viste incoerenti (caposaldo #1, #5).
- **Memoria sul percorso critico**: se `recall`/`learn` girano in-line nel turno, un rallentamento
  o errore della memoria degrada la latenza/robustezza della risposta interattiva.

La direzione SOTA è trattare la memoria come un **servizio out-of-path** dietro un facade unico:
il turno interattivo legge un *brief* già pronto e scrive in modo **asincrono/differito**, mentre
la costruzione del grafo/consolidamento avviene fuori dal path di risposta.

## La decisione

1. **Un solo ingresso: `MemoryFacade`.** Ogni capability chiama `recall`/`learn`/`consolidate`/`brief`
   **solo** attraverso il facade in `crates/memory`. Nessun call-site parla direttamente a
   `memory.sqlite` né tiene un proprio store.
2. **Estrazione dell'orchestrazione** di memoria da `main.rs` a `crates/memory`, dietro
   **`HOMUN_MEMORY_SERVICE`** (comportamento-preserving, flag-off di default finché non validato).
3. **Pool/connessioni** governati dal crate dietro **`HOMUN_MEMORY_POOL`** (nessun accesso SQLite
   sparso).
4. **Out-of-path**: il turno interattivo consuma un `brief` e accoda il write-back; recall pesante
   e consolidamento non stanno sul percorso di risposta.
5. **Verificabile** (caposaldo #10/#11): il grafo cattura PERCHÉ e loop aperti; eval/reader dedicati.

## Conseguenze

- Punto di convergenza unico per la memoria → si possono ritirare eventuali accessi paralleli.
- Il facade diventa il confine testabile (unit test del crate, non del monolite).
- Prerequisito naturale della [0024](0024-engine-extraction-from-monolith.md): estraendo il motore,
  la memoria è già un servizio con cui il motore dialoga, non codice intessuto.

## Cosa NON cambia

- Local-first, privacy-by-design, la memoria ibrida (FTS5/bm25 + dense + RRF, grafo, wiki).
- Il fatto che la memoria sia il differenziatore e l'unico layer condiviso.

## Note di implementazione (aperte)

- Nessun flag/servizio ancora scritto. Primo slice suggerito: spostare `brief`/`recall` dietro
  `HOMUN_MEMORY_SERVICE` con parità di comportamento e un test di contratto, poi il write-back.

Vedi memoria: `homun-memory-engine-shared-layer`.
