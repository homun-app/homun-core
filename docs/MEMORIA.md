# Memoria Homun — contratto operativo

Data: 2026-06-22. Questo è il documento corrente per governare lo sviluppo della
memoria. La visione estesa resta in [memory-vision.md](memory-vision.md), la
struttura tecnica in [memory-architecture.md](memory-architecture.md), i principi
vincolanti in [CAPISALDI.md](CAPISALDI.md).

## Obiettivo

La memoria deve far sopravvivere Homun alle chat nuove. Non basta ricordare fatti:
deve ricordare il **perché**, i **loop aperti**, i **deliverable prodotti**, le
decisioni, il piano e gli esiti, collegandoli nello stesso grafo.

Il test mentale è semplice: in una chat nuova Homun deve poter rispondere a:

- a che punto siamo?
- perché abbiamo deciso questa strada?
- cosa è ancora aperto?
- quali artifact/deliverable esistono e da quale lavoro derivano?
- cosa va chiuso, cancellato o superseduto?

## Regole non negoziabili

1. Tutto passa dall’unico `MemoryFacade`.
2. Niente store paralleli per artifact, piano, open loop o provenance.
   Read-model operativi come `contact_relationships` possono esistere per UX/
   performance, ma non sono la verità semantica: devono essere mirrorati o
   convergere nel grafo memoria.
3. **Graphification prima del recall piatto**: quando una conoscenza ha struttura
   deve diventare grafo (`entities` / `relations`), non solo testo. **Graphify**
   oggi è il primo adapter maturo, usato soprattutto per codice/AST/simboli, ma il
   principio vale anche per artifact, decisioni, piano, esiti e loop aperti.
   L'output esterno/cache (`graphify-out`) non è mai fonte di verità parallela:
   Homun importa nello stesso `MemoryFacade`.
4. Le pagine markdown sono una proiezione leggibile/editabile, non una seconda
   fonte di verità disconnessa.
5. Cancellazione e dedup devono aggiornare SQL, grafo e wiki.
6. I loop aperti restano visibili finché non sono chiusi con prove.
7. I deliverable hanno ciclo di vita proprio: non sono appendici della chat.

## Tre facce della stessa memoria

| Faccia | Ruolo | Stato |
|---|---|---|
| SQL | atomi richiamabili: `fact`, `preference`, `decision`, `goal`, `open_loop`, embedding, FTS | attivo |
| Grafo | relazioni e causalità: decisione → artifact → codice → esito; Graphify/graphification è il pattern di estrazione/import | parziale, oggi molto sbilanciato sul codice perché quello è il primo adapter maturo |
| Markdown/wiki | faccia leggibile/editabile: `brief.md`, `decisioni.md`, `profilo.md`, futuro `stato-lavori.md` | attiva ma incompleta |

## Stato reale

Fatto:

- recall ibrido lessicale + semantico;
- Graphify/graphification per importare conoscenza strutturata in `entities` /
  `relations`; oggi il path maturo è il code graph, queryabile via `query_code_graph`;
- briefing always-on con preferenze/profilo;
- `open_loop` come tipo di memoria;
- iniezione always-on degli open loop nel prompt;
- pagine wiki `decisioni.md`, `profilo.md`, `brief.md`;
- editing wiki con re-ingest;
- write-back delle azioni proattive in memoria: `accepted|snoozed → open_loop`,
  `dismissed → decision`.
- artifact surfaced dai produttori principali registrati nel `MemoryFacade` come
  `memory_type="artifact"` + entity grafo `artifact`; gate lifecycle/delete/export
  passato in-app;
- provenance graph iniziale sugli artifact: producer tool `produced` artifact,
  artifact `belongs_to_project` progetto, artifact `relates_to` file quando il
  path relativo di progetto è noto.

Mancante:

- convergenza/mirroring dei read-model graph-like, in particolare relazioni
  contatti, nel grafo canonico memoria;
- graphification estesa oltre il codice: artifact, piano, decisioni, outcome e loop
  aperti devono diventare nodi/archi causali, non solo righe testuali;
- provenance completa decisione/piano → artifact → codice → esito;
- eval memoria come gate.

## Prossimo blocco

### WS5.4b — `stato-lavori.md` ✅ locale

Creare una pagina wiki per progetto generata dagli `open_loop`.

Implementato localmente:

- la pagina esiste nella tab Memoria/Wiki;
- mostra i loop aperti correnti;
- linka i memory ref sorgenti;
- è editabile;
- se editata a mano non viene sovrascritta automaticamente;
- le correzioni rientrano nel motore memoria tramite re-ingest.

Verifica focalizzata:

- `cargo test -p local-first-desktop-gateway status_wiki -- --nocapture` → verde.

### WS5.4c — chiusura + dedup open loop ✅ locale

Gli open loop devono chiudersi o supersedersi quando il lavoro viene completato.

Implementato localmente:

- dedup canonico degli `open_loop` nello store: parafrasi sullo stesso lavoro
  vengono supersedute via `MemoryFacade::merge_memories`;
- `gather_open_loops` e `stato-lavori.md` ignorano i record superseduti;
- dedup agganciato al salvataggio memoria e al consolidamento periodico.
- chiusura con prova esplicita: l’estrattore vede gli open loop attivi e, quando
  una nuova evidenza completa un loop, emette `metadata.closes_open_loop`; il
  runtime marca il loop collegato come `Stale`;
- la chiusura non è keyword-based: richiede overlap con un loop attivo e una
  memoria nuova che porti evidenza verificabile.

Verifica focalizzata:

- `cargo test -p local-first-desktop-gateway open_loop_ -- --nocapture` → verde.

Acceptance:

- ✅ un task completato può marcare come chiuso il loop collegato;
- ✅ loop parafrasati non proliferano;
- ✅ i loop chiusi spariscono dal briefing e da `stato-lavori.md`;
- ✅ la chiusura è verificabile nel DB e nella wiki.

## Dopo WS5.4

1. WS2-3.1 — artifact come entità di memoria: locale/headless fatto, gate in-app
   + recall deliverable pendenti.
2. WS2-3.2/3.3 — schermata Artifacts e lifecycle/delete.
3. WS5.5a — provenance artifact→producer/progetto/file: locale/verde.
4. WS5.5b — provenance decisione/piano → artifact → codice → esito.
5. WS5.6 — eval memoria.
6. WS1-Fase 2/3 — piano runtime-owned e workflow runner con write-back memoria.
7. WS7 — deliverable Manus-style, solo dopo queste fondamenta.

## File codice principali

- `crates/memory/src/facade.rs` — `MemoryFacade`, lifecycle, wiki projection.
- `crates/memory/src/store.rs` — SQLite store.
- `crates/memory/src/types.rs` — tipi memoria.
- `crates/memory/src/graphify.rs` e `graphify_query.rs` — import/query Graphify
  oggi usati per il code graph; il pattern va esteso agli altri domini strutturati.
- `crates/desktop-gateway/src/main.rs` — recall, extraction, wiki API,
  `gather_open_loops`, `format_memory_block`, proactive write-back,
  `project_graph_ensure`, `memory_graphify_import`, `query_code_graph`.
