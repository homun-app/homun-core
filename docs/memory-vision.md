# Memoria Homun — visione & perché (SQL + grafo + markdown)

Data: 2026-06-22. Questo è il **ragionamento di fondo** della memoria — il *perché*,
non solo la struttura (struttura → [memory-architecture.md](memory-architecture.md);
principi → [CAPISALDI.md](CAPISALDI.md); lavori → [backlog](plans/2026-06-22-batch-1042-artifacts-memory.md)).

## L'obiettivo

> Un **cervello quanto più possibile umano** che **sopravvive alle nuove chat** e
> **sa sempre il PERCHÉ** di quello che abbiamo fatto. Un grafo che collega **tutto**
> — artefatti, informazioni, codice, decisioni, piano — e pagine markdown leggibili
> dove vive la conoscenza consolidata.

Caso-guida (il difetto da eliminare): *"ricordavo che il workflow era incompleto, tu
no"*. Una memoria-cervello deve tenere vivi i **loop aperti** (lavoro incompiuto + il
suo perché) finché non si chiudono — e renderli disponibili a una chat nuova.

## Perché TRE livelli (divisione del lavoro)

Non sono ridondanti: sono tre funzioni diverse, come in un cervello.

| Livello | Ruolo (analogia cervello) | Tecnologia |
|---|---|---|
| **Grafo** (entità + relazioni) | **le sinapsi** — COSA è collegato a COSA + il **PERCHÉ** (archi causali) | tabelle `entities`/`relations`, traversata + Graphify/graphification come pattern di estrazione/import |
| **SQL** (memorie + embedding + FTS) | **il richiamo** — atomi (fatti) + recall lessicale **e** semantico | `memories`, `memory_embeddings`, FTS5/bm25, fusione **RRF** + importanza + recency |
| **Markdown** (wiki per progetto) | **le pagine del quaderno** — narrazione consolidata, **leggibile, portabile, editabile** | `wiki_pages` + `WikiFileStore` su disco; **bidirezionale** (`project_to_wiki` ⇄ `import_wiki_correction`) |

**Chi è la verità.** SQL+grafo = verità macchina; **markdown = proiezione leggibile +
superficie editabile + export portabile**. Il markdown è ciò che **sopravvive all'app**
(file su disco) e che una **chat nuova legge** per sapere subito *cos'è il progetto,
cosa abbiamo deciso e perché, cosa è ancora aperto*.

## Il ciclo (come i tre si combinano)

1. **Cattura**: ogni turno → estrazione di atomi (`fact/decision/goal/…`) in SQL come
   `Candidate`.
2. **Connetti + perché**: gli atomi diventano nodi del **grafo** con archi **causali**
   (`rationale_for`, `produced`, `derived_from`, `supersedes`, `blocks`).
3. **Indicizza**: embedding + FTS su tutto ciò che conta → recall ibrido (RRF).
4. **Consolida**: dedup/supersede/correzione (`Candidate→Confirmed`) e **proiezione**
   nelle pagine markdown del progetto (`brief.md`, `decisioni.md`, `stato-lavori.md`).
5. **Richiama**: per un turno, recall ibrido scoped al progetto; per una **chat nuova**,
   inietta la **pagina markdown** del progetto (il "ripasso" che dà continuità).
6. **Correggi**: l'utente edita il markdown → la correzione **rientra** in memoria.

## Modello di memoria umana (cosa copriamo)

- **Semantica** (fatti/conoscenza) ✅ `memories`
- **Episodica** (eventi/timeline) ✅ `memory_events`
- **Procedurale** (come-fare) 🟡 skills/routines
- **Provenienza / causale (il PERCHÉ)** 🟡 esiste (`decision`, `rationale_for`) ma **poco popolata**
- **Working memory / loop aperti** ❌ **mancante** (il caso-guida)
- **Associativa (il grafo)** 🟡 enorme ma oggi **soprattutto codice** perché il code graph è il primo adapter maturo; deve estendersi a decisioni/artefatti/piano

## Baseline reale (2026-06-22, misurata sul DB)

- Grafo: **49.028 entità · 235.859 relazioni** — ma **quasi tutto codice** (import/call).
- Embedding: **391** — il recall semantico copre una **frazione**.
- Wiki markdown: **9 pagine** — il "cervello leggibile" è **quasi dormiente**.

> Diagnosi: **la macchina a 3 livelli c'è ed è cablata, ma è sbilanciata.** Il grafo
> connette soprattutto il codice ma non ancora il *lavoro/il perché*; gli embedding coprono poco; il
> markdown — il pezzo che fa "sopravvivere alle chat e ricordare il perché" — non è
> alimentato. Per questo l'obiettivo non è ancora raggiunto. Non serve nuova
> architettura: serve **riempire quella che c'è con le cose giuste**.

## Cosa manca per arrivare all'obiettivo (→ task in backlog WS5)

1. **Estendere il grafo** da solo-codice a **decisioni, artefatti, step di piano,
   esiti**, con **archi-perché**. Graphify è il primo adapter, non il confine:
   la differenza Homun è graphificare tutto ciò che ha struttura verificabile.
2. **Embeddare tutto** l'importante (non 391) → recall semantico reale.
3. **Loop aperti** come entità di prima classe (lavoro incompiuto + perché, priorità di
   sopravvivenza; si chiudono a task completato).
4. **Proiezione markdown attiva** per progetto (`brief.md` / `decisioni.md` /
   `stato-lavori.md`), iniettata nelle chat nuove, bidirezionale.
5. **Catena di provenienza**: decisione → artefatto → codice → esito (unisce
   artefatti→memoria WS2-3.1, piano→memoria WS1-F6, codice già nel grafo).
6. **Eval memoria** (guardrail): chat nuova → *"a che punto è il workflow e perché
   make_deck?"*, *"quali artefatti per il progetto X e da quale decisione?"* → la
   memoria deve rispondere. Se non risponde, non sta facendo il suo lavoro — misurabile.

## Caposaldo che ne deriva

**#8 — La memoria cattura il PERCHÉ e i LOOP APERTI, non solo i fatti, e collega
TUTTO (codice, decisioni, artefatti, piano) nel grafo.** Obiettivo: un cervello che
sopravvive alle chat e sa sempre il perché — **verificabile via eval**. (in
[CAPISALDI.md](CAPISALDI.md))

## Riferimenti
- Principi: [CAPISALDI.md](CAPISALDI.md)
- Struttura: [memory-architecture.md](memory-architecture.md)
- Lavori & task: [backlog 2026-06-22 → WS5](plans/2026-06-22-batch-1042-artifacts-memory.md)
- Motore: [ADR 0016](decisions/0016-harness-owned-task-engine-cross-model.md)
