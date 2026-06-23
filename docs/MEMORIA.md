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
- provenance artifact evidence-only: decisioni e sorgenti esplicite vengono
  collegate agli artifact solo quando la memoria porta prove strutturate
  (`affects_labels` o ref canoniche nei metadata artifact), materializzando archi
  `affects` / `derived_from` nel grafo canonico.
- primo eval/read path WS5.6 per provenance artifact: recall esplicito e RAG
  automatico leggono il grafo canonico e possono rispondere quali artifact
  esistono e da quale decisione/lavoro derivano, includendo il perché.
- secondo eval/read path WS5.6 per stato workflow: recall esplicito e RAG
  automatico leggono `goal`, `open_loop`, outcome/fact verificati, decisioni con
  rationale e artifact provenance per rispondere “a che punto siamo e perché?”.
- post-smoke v0.1.1045: il reader di provenance artifact espone anche il
  `managed_path` locale degli artifact gestiti e collega producer `make_deck` al
  workflow `DeckWorkflow`; il reader di stato workflow considera gli outcome
  canonici `fact` con `source="runtime_plan_step"` come evidenze verificate.
- prima generalizzazione documenti WS1: `make_document` riusa
  `WorkflowDefinition`/`ExecutionPlan`/`OrchestratorBrain::run_plan`, produce un
  artifact Markdown gestito e registra la memoria artifact con producer
  `make_document`; il reader provenance lo collega a `DocumentWorkflow` nello
  stesso grafo canonico. Post-smoke runtime: il router workflow restringe il
  toolset a `make_document` anche dopo injection MCP/Composio, il nome artifact
  esplicito viene preservato, e il gate API ha confermato memoria
  `artifact|confirmed`, entity artifact e relazione canonica
  `tool:make_document --produced--> artifact`.
- prima slice WS1 piano→memoria: il piano runtime-owned materializza un solo
  `open_loop` canonico `source="runtime_plan"` per thread, aggiornato in-place da
  `update_plan` / `step_advance` con conteggi, prossimo step e snapshot degli step;
  quando non restano step aperti il record viene marcato stale. `stato-lavori.md`
  viene rigenerato dal `MemoryFacade` come vista derivata.
- grafo piano runtime-owned: lo stesso write-back materializza entity piano e step
  nel grafo canonico (`metadata.kind="runtime_plan"` /
  `metadata.kind="runtime_plan_step"`), con relazioni `describes`, `relates_to`
  (`kind="has_step"`) e `depends_on` per dipendenze esplicite tra step.
- prima convergenza WS1 verso `ExecutionPlan`: lo stesso `open_loop`
  `source="runtime_plan"` salva anche `metadata.execution_plan` nel contratto
  del crate `orchestrator`; `update_plan` accetta e conserva `depends_on`
  espliciti. Il loop agente usa ora `ExecutionPlan` come stato runtime canonico;
  il marker/UI resta compatibile come vista derivata dallo snapshot step corrente.
- primo workflow dichiarativo WS1: `make_deck` ha una `WorkflowDefinition`
  harness-owned proiettata in `ExecutionPlan` (`DeckWorkflow`), senza creare un
  secondo store workflow.
- `ExecutionPlan` include `plan_propose` come contratto strutturato per piani da
  approvare prima dell'esecuzione; resta dentro il contratto orchestrator, non in
  uno store separato.
- `OrchestratorBrain::run_plan` esegue workflow dichiarativi già costruiti
  dall'harness attraverso lo stesso Brain/task-runtime/subagent path dei piani
  generati dal planner; non introduce un runner/store parallelo.
- `make_deck` passa la propria `WorkflowDefinition`/`ExecutionPlan` attraverso
  `OrchestratorBrain::run_plan` prima della pipeline deterministica; il Brain è
  il punto di ingresso contrattuale, non una seconda memoria o un secondo store.
- router workflow|agent WS1-F4: il runtime instrada richieste
  deck/presentation/slide/pptx al workflow `make_deck` con scaffolding
  `maximum`; le altre richieste restano nel normale loop agente. Il router è
  harness-owned e non crea un secondo grafo.
- outcome per-step WS1-F6a: quando il loop principale verifica uno step `done`,
  scrive una `fact` confermata `source="runtime_plan_step"` nel `MemoryFacade`,
  con `thread_id`, `step_id`, criterio ed evidenze della verifica. Il piano
  resta il solo `open_loop` canonico runtime-owned; la `fact` è storico
  recuperabile e viene aggiornata in-place per lo stesso step.
- outcome per-step sub-agent WS1-F6b: i task `subagent.*` completati riusano lo
  stesso formato `runtime_plan_step`, usando il task id come `step_id`, il
  contratto sub-agent come criterio e un'evidence redatta
  `source="subagent_task"`.

Mancante:

- convergenza/mirroring dei read-model graph-like, in particolare relazioni
  contatti, nel grafo canonico memoria;
- graphification estesa oltre il codice: artifact, piano, decisioni, outcome e loop
  aperti devono diventare nodi/archi causali; il piano ora ha write-back SQL e
  grafo step-level iniziale più stato/proiezione `ExecutionPlan`, ma non ancora
  il runner dichiarativo completo;
- provenance completa decisione/piano → artifact → codice → esito: la slice
  decisione/source-ref → artifact e i reader/eval sono locali/verdi; il piano ora
  scrive stato e step nel grafo, resta collegare artifact/esiti a step/piano con
  evidenza esplicita;
- eval memoria come gate completo in-app/release; i reader headless per artifact
  provenance e stato workflow sono locali/verdi.

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
4. WS5.5b — provenance decisione/source-ref → artifact evidence-only: ✅ slice
   locale/verde.
5. WS5.6 — eval memoria: ✅ artifact/provenance e stato workflow/perché locali;
   resta eventuale smoke in-app mirato.
6. WS7 — generalizzare `make_document` / `make_research` / `make_meeting` sullo
   stesso `ExecutionPlan` + write-back memoria/grafo.
7. Smoke in-app su deck workflow dopo build release.

## File codice principali

- `crates/memory/src/facade.rs` — `MemoryFacade`, lifecycle, wiki projection.
- `crates/memory/src/store.rs` — SQLite store.
- `crates/memory/src/types.rs` — tipi memoria.
- `crates/memory/src/graphify.rs` e `graphify_query.rs` — import/query Graphify
  oggi usati per il code graph; il pattern va esteso agli altri domini strutturati.
- `crates/desktop-gateway/src/main.rs` — recall, extraction, wiki API,
  `gather_open_loops`, `format_memory_block`, proactive write-back,
  `project_graph_ensure`, `memory_graphify_import`, `query_code_graph`.
