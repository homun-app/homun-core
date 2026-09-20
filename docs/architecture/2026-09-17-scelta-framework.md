# Scelta delle librerie del motore

17 settembre 2026. **Stato: adottata (D-RUN-01).** Confermata da Fabio dopo F0.2: si costruisce e si migliora su questo stack, senza piano di sostituzione. Motivazioni e licenze sotto; evidenza runtime in [ADR F0.2](decisions/2026-09-17-f0-2-runtime-spike.md).

## Scelta

**Pydantic AI + DBOS Python**, con UI Homun esistente. Pydantic AI possiede il ciclo dell'agente; DBOS possiede checkpoint, attese e ripresa del workflow. Homun possiede regole aziendali, autorizzazioni, piano versionato, artefatti e distribuzione selettiva.

Non implementare un nuovo runtime generico di code/checkpoint/retry. Usare DBOS dietro un adattatore Homun, conservando la separazione tra stato aziendale e stato d'esecuzione. Non aggiungere LangGraph come terzo orchestratore.

## Perché questa scelta per Homun

- Python coerente con l'orientamento già espresso.
- Pydantic AI offre agenti con input/output tipizzati, strumenti e modelli sostituibili: [overview](https://pydantic.dev/docs/ai/overview/).
- DBOS è incorporabile nel processo, con stato su database; non richiede per principio un servizio cloud del fornitore: [guida](https://docs.dbos.dev/python/programming-guide).
- SQLite è supportato; gli autori raccomandano PostgreSQL in produzione. Il nostro caso locale per nodo richiede prova specifica: non usare SQLite condiviso come coordinatore distribuito. [Database](https://docs.dbos.dev/python/tutorials/database-connection).
- Collaborazione tra app e cifratura restano livelli separati: nessuna delle due librerie li rende automaticamente pronti.

## Confronto circoscritto

| Soluzione | Licenza core verificata | Giudizio per Homun |
|---|---|---|
| Pydantic AI + DBOS | MIT + MIT | Scelta: agenti e continuità separati, riuso del runtime senza imporre una piattaforma centrale |
| LangGraph | MIT | Alternativa valida con checkpoint; non esclusa per limiti di licenza. Non serve sommarla a DBOS |
| Agno / AgentOS | Apache-2.0 nel repository corrente | Molte funzioni integrate, compresi team e runtime; candidato più completo se scegliessimo una piattaforma integrata. Preferenza Homun per separazione e controllo locale, non pretesa inferiorità di Agno |
| Pydantic AI + Temporal | MIT per Pydantic; licenza/versioni Temporal da verificare prima dell'adozione | Alternativa di esecuzione per un eventuale deployment aziendale, non prima scelta per ridurre infrastruttura desktop |

Fonti confronto: [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [Agno AgentOS](https://docs.agno.com/agent-os/introduction), [Pydantic Temporal](https://pydantic.dev/docs/ai/capabilities/durable_execution/temporal/).

Nessuna graduatoria universale: è la scelta consigliata per i requisiti di Homun, non il risultato di un test prestazionale fra tutti i framework.

## Agenti Homun

Un collaboratore è una configurazione persistente con ID, curriculum, istruzioni versionate, competenze, strumenti autorizzati, riferimenti alla memoria, policy modello, supervisore e budget. Il factory crea l'esecutore Pydantic a partire da questa configurazione.

Marta, Vera e un nuovo traduttore non richiedono tre implementazioni diverse. Richiedono profili e concessioni diversi. Un team è un insieme di responsabilità e deleghe; il coordinatore propone il piano, mentre le regole del motore stabiliscono che cosa può davvero partire.

I profili creati in chat sono dati, non codice Python generato ed eseguito senza controllo. Le definizioni runtime/tool compatibili vengono registrate secondo il ciclo di vita del framework.

## Limiti concreti da verificare

L'integrazione DBOS richiede che la run sia dentro un workflow; aggiungere soltanto la capability non basta. I tool custom con I/O richiedono integrazione esplicita. Toolset MCP dinamici e registrazione a runtime hanno vincoli: prevedere un registry stabile e versionato, verificando l'inserimento di agenti/plugin senza perdere lavori attivi. Retry di provider e workflow non vanno moltiplicati. [Integrazione ufficiale](https://pydantic.dev/docs/ai/capabilities/durable_execution/dbos/).

Verificare la cifratura anche del database di checkpoint: può conservare input/output sensibili. Non serializzare credenziali o interi file nello stato; riferimenti e manifest riducono la duplicazione. Nessuna promessa di supporto SQLCipher senza prova del driver. La serializzazione non deve accettare oggetti eseguibili provenienti dai peer.

## Cosa riutilizziamo / cosa sviluppiamo

| Riutilizzo | Codice specifico Homun |
|---|---|
| Ciclo LLM, tool calling, validazione output | Contratto del lavoro, piano modificabile e responsabilità |
| Checkpoint, comunicazioni workflow, recupero | Consistenza fra eventi aziendali e workflow |
| Client MCP e provider modelli | Catalogo, concessioni, destinazione dati e ricevute |
| Librerie storage, cifratura e trasporto | Distribuzione selettiva, pairing e gestione chiavi |
| Primitive di contesto e cronologia | Memoria per progetto/agente con provenienza, revisione e accesso |

Non adottare automaticamente un servizio memoria esterno: prima chiarire regole e conservare controllo dei dati. Non occorre reinventare ricerca o embedding; occorre applicare i confini di Homun.

## Licenze e costi

Verificate direttamente: [Pydantic AI MIT](https://github.com/pydantic/pydantic-ai/blob/main/LICENSE), [DBOS MIT](https://github.com/dbos-inc/dbos-transact-py/blob/main/LICENSE), [LangGraph MIT](https://github.com/langchain-ai/langgraph/blob/main/LICENSE), [Agno Apache-2.0](https://github.com/agno-agi/agno/blob/main/LICENSE).

MIT permette uso, modifica e redistribuzione anche commerciale preservando copyright e licenza. La scelta riguarda le librerie open source, non eventuali servizi gestiti. Modelli, API, connettori e dipendenze hanno condizioni/costi separati. Prima di distribuire bloccare versioni/commit e inventariare le licenze transitive; un ramo main può cambiare.

## Hardening sullo stesso stack (non alternative)

Dopo F0.2 restano da hardenizzare: secondo profilo agente a caldo, MCP/tool dinamici, cifratura checkpoint, packaging Electron. Si risolvono migliorando adattatori e prove Homun, non cambiando framework.

LangGraph resta documentato solo come confronto storico nella tabella sopra: **non** è un piano B attivo e non va sommato a DBOS.
