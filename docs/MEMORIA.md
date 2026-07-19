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

## Fonti memoria collegate autorizzate

Dal 2026-07-17 (schema v7) un progetto può richiamare memoria personale o di un altro
progetto solo dopo un grant esplicito e diretto dello stesso utente. Il grant dichiara
collection consentite e può avere eccezioni puntuali `Allow`/`Deny`; non si propaga da
una fonte a un'altra. L'isolamento personale/progetto resta quindi il default del
modello di autorizzazione, non una convenzione del prompt.

La funzione è attiva di default. Per un rollback locale si può impostare soltanto
`HOMUN_MEMORY_SOURCES=0` o `HOMUN_MEMORY_SOURCES=off`. Revocare un grant interrompe
subito il richiamo; una fonte progetto non presente nel registry persistito, o con
registry assente/illeggibile/corrotto/vuoto, è esclusa prima di recall, audit e
aggiornamenti last-used. Il richiamo non pubblica né duplica memoria. Se una fonte è
stata collegata in quella direzione, la pubblicazione nel consumer è vietata in modo
permanente anche dopo revoca/scadenza (`linked_memory_read_only`): chi vuole conservarne
l'accesso mantiene il grant, senza creare copie. Il controllo usa il ledger storico
server-side e non dipende dai campi inviati dal client. I candidati filtrati servono a
recall e indice; non coincidono con l'Advanced picker, che gestisce le fonti non-segrete
selezionabili.

Smoke verificato in Europe/Rome il 2026-07-17: isolamento, grant/collection/override,
revoca, filtro delle fonti mancanti e perimetro contatti. Nessun deploy è implicato da
questa verifica locale.

Ogni hit collegato conserva provenance strutturata: ref originale, workspace sorgente,
grant che ha autorizzato l'accesso e versione della policy. L'origine non viene dedotta
dal testo e il record non viene copiato nello scope consumatore. Revoca o modifica del
grant invalida la cache vettoriale autorizzata: il comportamento successivo è
fail-closed. La memoria personale non diventa implicitamente visibile solo perché un
progetto ha ricevuto accesso a un altro progetto, e viceversa.

Dal 2026-07-19 il richiamo non usa più parole chiave per scegliere quali collection
consultare. Ogni collection concessa dal grant partecipa alla ricerca dei nodi iniziali;
le corrispondenze lessicali/semantiche servono soltanto a trovare pochi seed nello scope
esatto della fonte. Da ciascun seed il recall percorre poi il grafo canonico per un
massimo di due archi, 64 nodi autorizzati, 32 vicini autorizzati per nodo e 512
relazioni ispezionate complessivamente; aggiunge al massimo quattro memorie collegate
per fonte.

Ogni arco, entity e memoria attraversata viene rivalidata contro utente, workspace,
privacy domain, sensibilità e policy della stessa fonte. Una memoria negata non viene
restituita e non può fare da ponte; il percorso non passa mai da un grant a quello di
un'altra fonte. Gli hit espansi conservano il percorso in `graph_path`, oltre a ref,
workspace, grant e policy version. Le pagine Markdown restano una proiezione leggibile:
non esiste un catalogo o un “cassetto” persistente parallelo a SQL e grafo.

### Read set, contesto e write firewall

Ogni hit collegato aggiunge al turno una tupla strutturata con workspace source, grant,
versione policy, ref e revisione canonica del record. Recall automatico e tool esplicito
confluiscono nello stesso read set; alla finalizzazione il gateway lo persiste
atomicamente con la risposta in un envelope `memory_reuse`:

- `normal`: nessun hit collegato;
- `user_input_only`: l'apprendimento riceve solo il testo scritto dall'utente, mai
  risposta, azioni o risposta precedente;
- `blocked_unknown`: provenance ambigua/corrotta o finalizzazione incompleta, nessun
  materiale raggiunge writer ed extractor.

Il transcript non viene cancellato e resta leggibile. Il contesto inviato a un modello è
invece ricostruito server-side dai messaggi persistiti: ogni tupla viene rivalidata contro
grant corrente, versione, deny, ref e revisione. Una sola lettura non più valida rende la
risposta non riusabile nel contesto. Revoca, source indisponibile e riavvio non cambiano
questa regola.

La policy del turno governa tutti i writer: memoria SQL, episodio `__threads__`, grafo,
Wiki, briefing e checkpoint di compattazione. Un turno collegato può apprendere un nuovo
fatto direttamente dichiarato dall'utente, ma non può salvare o riassumere la risposta
derivata. L'attivazione non usa parole chiave: deriva esclusivamente dagli hit realmente
autorizzati e usati nel turno.

## Integrità operativa di Memory, Vault e grafi progetto

L'identità Graphify è deterministica: nodi e archi vengono normalizzati su chiavi
canoniche dello scope, indipendenti dall'ordine dell'output. Duplicati e relazioni
dangling vengono contati e scartati; l'import sostituisce in transazione l'intera
proiezione Graphify del progetto. La sequenza runtime ammessa è **import → publish
atomico → fingerprint → ready**. Se un passaggio fallisce, il database e l'artifact
precedenti restano disponibili, il fingerprint non avanza e viene emesso `failed`, mai
un falso `ready`.

L'audit locale (`GET /api/integrity/audit`) è read-only e metadata-only. Riporta
integrità SQLite, cardinalità, orfani, duplicati, coerenza grant, copertura FTS, stato
Vault e stato `missing|fresh|stale|invalid` dei grafi registrati. Non serializza
contenuti di memoria, valori Vault, materiale cifrato, nonce o path assoluti.

Il repair è sempre esplicito e preview-first:

1. scegliere azioni nominate;
2. ottenere stime, checksum e approval token dal preview;
3. confermare le stesse azioni con `confirm=true`;
4. superare il controllo anti-drift e creare un backup nuovo;
5. applicare in transazione e rieseguire l'audit.

Non esiste repair automatico allo startup. Un token non è riutilizzabile se audit,
azioni o stato del grafo cambiano. Un refresh grafo viene eseguito separatamente dai
repair Memory. La cancellazione progetto rimuove prima, in transazione, dati,
cross-link e cache dello scope `local-user`; il registry viene aggiornato per ultimo,
così un fallimento resta ritentabile.

Le duplicate relation prodotte da Graphify sono una proiezione meccanica e possono
essere riparate automaticamente, ma solo nello scope di un progetto registrato. I
duplicati semantici tra memorie attive sono invece soltanto segnalati per revisione:
non vengono mai fusi o cancellati dal repair di integrità. Anche il purge di scope non
registrati richiede una scelta separata e non fa parte della manutenzione ordinaria.

Per i dati legacy eventualmente creati prima del write firewall esiste una bonifica
dedicata e separata:

1. `POST /api/integrity/linked-memory/repair/preview` produce un report metadata-only
   (conteggi, checksum e token, nessun testo);
2. `POST /api/integrity/linked-memory/repair/apply` richiede la stessa preview e
   `confirm=true`;
3. vengono creati backup nuovi di `homun.sqlite` e `memory.sqlite` e l'apply aggiorna i
   due database in una transazione con `quick_check` finale;
4. vengono backfillati gli envelope e rimossi solo record automatici strutturalmente
   riconducibili ai thread contaminati, con FTS e viste derivate ricostruite;
5. memorie manuali, Graphify, grant, audit, source e transcript restano invariati. In
   caso d'errore entrambi i database tornano allo stato iniziale; il secondo preview è
   idempotente e non propone ulteriori righe.

## Tre facce della stessa memoria

| Faccia | Ruolo | Stato |
|---|---|---|
| SQL | atomi richiamabili: `fact`, `preference`, `decision`, `goal`, `open_loop`, embedding, FTS | attivo |
| Grafo | relazioni e causalità: decisione → artifact → codice → esito; Graphify/graphification è il pattern di estrazione/import | parziale, oggi molto sbilanciato sul codice perché quello è il primo adapter maturo |
| Markdown/wiki | faccia leggibile/editabile: `brief.md`, `decisioni.md`, `profilo.md`, futuro `stato-lavori.md` | attiva ma incompleta |

## Stato reale

Fatto:

- recall ibrido lessicale + semantico;
- recall graph-guided sulle fonti autorizzate: seed mirati, attraversamento canonico
  limitato a due archi, provenienza `graph_path` e nessun gate per parole chiave sulle
  collection concesse;
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
  `tool:make_document --produced--> artifact`. Slice PDF: più artifact
  documentali (`.md`/`.pdf`) derivano dalla stessa sorgente Markdown e vengono
  registrati singolarmente nella memoria/provenance canonica con producer
  `make_document`. Gli artifact sono esclusi dal dedup semantico distruttivo:
  possono avere descrizioni simili, ma la loro identità canonica è path/thread/name.
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
- primo audit read-model graph-like WS5.1a: `contact_relationships` resta una
  tabella operativa per la rubrica, ma le relazioni con `entity_ref` espliciti
  sono mirrorate nel grafo canonico come `MemoryRelation` deterministiche con
  metadata `source="contact_relationships"`; la rimozione tombstona il ref
  canonico. Non c'e' matching per nome.
- guardrail WS5.1b: `ChatStore` dichiara un audit memoria per ogni tabella locale.
  Il test `local_store_tables_have_explicit_memory_boundary_audit` legge lo
  schema reale e fallisce se nasce un nuovo read-model senza policy esplicita
  UX/ops oppure convergenza nel `MemoryFacade`.

Mancante:

- nessun blocco WS5 locale: artifact, piano, decisioni, outcome, open loop,
  identity hygiene e read-model graph-like corrente convergono nel
  `MemoryFacade` canonico con gate deterministici. Restano validazioni in-app
  mirate prima delle release e l'estensione futura del grafo a nuovi
  domini/adapter quando appariranno.

### Identity hygiene — locale/verde 2026-06-25

- merge entita' canonico in `MemoryFacade::merge_entities`: il survivor conserva
  alias/metadata, le relazioni dell'assorbito vengono ripuntate e l'assorbito
  viene tombstonato con `merged_into`;
- gli handle owner dei canali non creano persone parallele: convergono su
  `person:self` e l'apprendimento inbound resta attribuito all'utente;
- ogni workspace ha una root progetto stabile `workspace:<workspace_id>`, con
  nomi/cartelle come alias o metadata, cosi' l'estrattore non crea project root
  concorrenti;
- dopo merge, correzioni, delete, rename/folder e mutazioni wiki passa un
  percorso unico di reconciliation che rigenera graph/wiki derivati;
- la UI grafo espone merge esplicito e suggerimenti hygiene; same-name-only non
  viene mai fuso automaticamente.

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
   gate deterministico incluso nel pre-release locale.
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
