# Hermes e Homun: confronto delle fondamenta

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

Data: 19 settembre 2026. Stato: analisi e proposta da discutere con Fabio; nessuna modifica al runtime o alle decisioni architetturali adottate.

## Perimetro e risultato

Hermes è un riferimento utile soprattutto per rendere efficace un agente durante una conversazione: preparazione del contesto, uso degli strumenti, continuità, skill, recupero di conoscenze e gestione degli errori. Homun deve integrare queste capacità nel proprio modello di lavoro aziendale, con persone, agenti, responsabilità, accessi, revisioni e autonomia concessa per ambito.

La priorità alle fondamenta è corretta. Propongo di completare prima il nucleo agentico e i suoi contratti, mantenendo Pydantic AI + DBOS. Gli scenari di prodotto servono a verificare quei contratti durante la costruzione; il catalogo non deve condizionare tutta l'architettura.

Ho consultato sito e documentazione ufficiale, clonato il repository e seguito i percorsi principali nel codice. Snapshot Hermes: [`ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998`](https://github.com/NousResearch/hermes-agent/tree/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998), commit con data 2026-09-19. Clone locale: `/Users/fabio/Projects/Homun/agent-system-research/hermes-agent-2026-09-19`.

Il confronto Homun riguarda il working tree attuale, che contiene modifiche non committate: il solo HEAD non identifica questa versione. I documenti di specifica distinguono requisiti confermati, proposte e decisioni aperte; non considero tutte le loro prescrizioni già approvate o implementate.

## 1. Goal di prodotto usato come riferimento

Homun deve permettere a un'azienda di lavorare con collaboratori umani e artificiali attraverso una conversazione naturale. Una domanda può restare una domanda; una richiesta operativa può diventare un lavoro dopo l'interpretazione e le proposte necessarie.

Il lavoro conserva obiettivo, materiali, responsabilità, piano, contributi mancanti e risultati. Chat, progetto e viste operative sono rappresentazioni coerenti degli stessi oggetti. Gli agenti hanno identità, istruzioni e capacità persistenti, indipendenti dal modello selezionato.

L'utente può correggere metodo e risultati. L'apprendimento deve conservare provenienza e ambito; l'autonomia viene concessa da chi ne ha autorità, per attività e contesto. Accettare un risultato e autorizzare un effetto esterno sono decisioni distinte.

Il motore Python resta indipendente dalla UI. Dati locali, cifratura e collaborazione autorizzata tra installazioni fanno parte della direzione di prodotto; trasporto, gestione chiavi e alcuni dettagli offline restano decisioni aperte. I modelli remoti sono utilizzabili quando compatibili con le policy, senza trasformare locale e remoto in un fallback implicito.

Riferimenti Homun: [prodotto e dati](../specifications/01-prodotto-e-dati.md), [agenti e memoria](../specifications/02-agenti-esecuzioni-memoria.md), [API e rete](../specifications/04-api-client-rete.md), [legenda delle decisioni](../specifications/README.md).

## 2. Che cosa è Hermes oggi

Hermes oggi copre ricerca, file, browser, documenti, messaggistica, automazioni e delega oltre al coding. Diversi client e protocolli guidano lo stesso nucleo `AIAgent`. È quindi una buona fonte di esperienza sui problemi pratici di un agente generalista. La documentazione e il catalogo descrivono capacità disponibili; questa analisi non dimostra la qualità di ciascuna integrazione in uso reale. [Architettura ufficiale](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture).

Il coding emerge in parti specifiche: worktree, evidenze di test/build, criteri di completamento legati alle pull request. Nello snapshot esistono anche task persistenti con assegnatario, run, dipendenze, review e dispatcher. Sarebbe scorretto ridurlo a una chat con tool o sostenere che non abbia workflow. Le prove per PR sono però specifiche a quel dominio: Homun richiede anche evidenze su listini, documenti, ricerche e azioni aziendali. [Task Hermes][h-kanban], [accettazione PR][h-pr].

La policy ufficiale definisce Hermes un agente personale single-tenant e considera l'isolamento del sistema operativo il confine di contenimento. Profili, sessioni e approvazioni interne non equivalgono automaticamente ai permessi per dati aziendali condivisi richiesti da Homun. Questo è un diverso contratto di fiducia, non un giudizio generale di insicurezza. Anche Homun deve ancora completare autenticazione, cifratura e applicazione uniforme delle policy. [Security policy][h-security].

## 3. Confronto sintetico

| Fondamenta | Evidenza Hermes | Stato osservato Homun | Direzione proposta |
|---|---|---|---|
| Conversazione e contesto | Trascrizione persistita, contesto composto, selezione e compressione sostituibili | Interpretazione del messaggio corrente con roster; manca composizione completa di storico, lavoro e materiali | Primo intervento |
| Esecuzione agentica | Ciclo modello → tool → osservazione → nuova decisione | Adattatori modello e output tipizzati; workflow DBOS ancora dimostrativo | Usare il loop Pydantic AI con capacità Homun |
| Memoria | Note brevi, ricerca sessioni, provider esterno opzionale | Ledger approvato SQLite, ricerca semplice e Mem0 opzionale | Collegare recall autorizzato al contesto e misurarlo |
| Skill | Indice sintetico, caricamento su richiesta, modifica e revisione opzionale | Contratto di prodotto previsto; catalogo eseguibile ancora da completare | Procedure versionate e portabili |
| Strumenti | Registro con schema, handler, disponibilità; MCP e backend separati | Grants su progetti, ToolGrant previsto nelle specifiche | Registro unico e controllo backend per invocazione |
| Delega | Figli con contesto esplicito, capacità filtrate e limiti | Profili/roster e piano di lavoro; esecuzione coordinata incompleta | Brief strutturato, input minimo, revisione e budget |
| Ripresa | Sessioni, lease, registri cron, claim e recovery dei task | DBOS e ricevute; da integrare con effetti reali | Conservare un solo proprietario del recovery |
| Apprendimento | Scritture memoria/skill e review in background; gate configurabile | Note approvate; formazione per ambito nelle specifiche | Proposta → revisione → nuova prova |
| Costi | Contabilità e limiti operativi; contatori iterazioni per agente | UsageAttempt e usage sconosciuto esplicito; riserve da realizzare | Budget complessivo per lavoro, inclusi costi ausiliari |

Le sezioni seguenti precisano evidenze e limiti delle righe.

## 4. Parti da studiare e adattare

### 4.1 Contesto: la priorità più alta

Hermes prepara separatamente istruzioni relativamente stabili, contesto e componenti variabili. La richiesta al provider è distinta dalla trascrizione. `ContextEngine.select_context` può selezionare il materiale per una chiamata senza riscrivere lo storico; compressione e potatura degli output dei tool rispondono ad altri scopi. Questa separazione evita che note operative, riepiloghi e adattamenti al provider diventino messaggi dell'utente. [Assemblaggio][h-assembly], [ContextEngine][h-context], [prompt][h-prompt].

In Homun `_prepare_interpretation` passa testo e roster al modello; `AttemptContext` identifica il tentativo, ma non contiene la conversazione o il materiale necessario a comprenderlo. Il semplice adattatore Pydantic AI concatena i messaggi in un prompt. Aver persistito le informazioni non significa averle rese disponibili alla decisione corrente. [Route Homun](../../engine/src/homun/routes/domain.py), [adattatore](../../engine/src/homun/models/adapters/pydantic_ai.py).

Propongo un componente di composizione del contesto, con input espliciti: attore, agente/revisione, conversazione, lavoro/revisione, materiali autorizzati e budget. Deve preservare esattamente contratto e approvazioni, selezionare informazioni con riferimenti alle fonti e registrare quali versioni ha usato. Riassunti e indici restano derivati. Il comportamento va provato su correzioni, cambi di argomento e revoche, prima di ottimizzare aggressivamente caching e compressione.

### 4.2 Il ciclo agentico e gli strumenti

Hermes separa preparazione del turno, chiamata al provider, normalizzazione, dispatch dei tool e finalizzazione. Il registro centralizza schema, handler e disponibilità; MCP adatta strumenti esterni allo stesso sistema. Sono utili soprattutto i confini e i casi di errore già considerati, non la copia del grande loop con tutte le compatibilità storiche. [Loop][h-loop], [registro][h-registry], [MCP][h-mcp].

Homun ha già scelto Pydantic AI come proprietario del loop e DBOS per esecuzioni durevoli. Serve rendere effettiva questa divisione: il runner dell'agente usa tool con contratti Homun; ogni mutazione passa dal dominio e dalla policy; DBOS orchestra attese e ripresa. Non aggiungerei un secondo loop artigianale attorno a quello della libreria. Il `ModelPort` attuale resta il confine dei modelli; la capacità di eseguire un agente non va confusa con `complete()` che restituisce testo. [ADR adottata](../architecture/decisions/2026-09-17-f0-2-runtime-spike.md), [ModelPort](../../engine/src/homun/models/port.py).

Primo insieme sufficiente: lettura di un materiale autorizzato, ricerca nel contesto consentito, richiesta di contributo e produzione di un risultato locale. Per ogni tool: input validato, effetto dichiarato, timeout, cancellazione, output limitato, errore tipizzato e ricevuta quando necessaria. Installazione, disponibilità e autorizzazione devono restare distinte.

### 4.3 Memoria e skill

La memoria incorporata di Hermes è piccola e leggibile: note e profilo, con limiti espliciti e snapshot nel prompt. `session_search` recupera dettagli dalle sessioni, limitando quantità e dimensioni dei risultati. Un provider esterno può aggiungere altri modi di recupero. Ne ricavo un principio: prima rendere utili poche informazioni affidabili, poi dimostrare il valore aggiunto della ricerca semantica. [Store][h-memory-store], [ricerca sessioni][h-search], [provider][h-memory-provider].

Homun ha già un ledger SQLite autorevole e un indice Mem0 opzionale. Lo manterrei, evitando che l'indice diventi fonte di verità. Il filtro `project_id` esistente non è, da solo, autorizzazione: nelle route memoria esaminate manca l'applicazione equivalente dei grant di progetto. Prima del recall automatico occorre una policy comune anche per memorie, materiali e transcript. [Memoria Homun](../../engine/src/homun/memory/sqlite_port.py), [route memoria](../../engine/src/homun/routes/memory.py), [Mem0](../../engine/src/homun/memory/mem0_port.py).

Le skill Hermes usano un indice breve e caricano istruzioni e risorse su richiesta. La tecnica permette un catalogo ricco senza introdurre tutto nel prompt. Homun può adottare quel formato e sperimentare alcune skill documentali, mantenendo versione, origine, requisiti e ambito. Uno script allegato richiede il proprio contratto di esecuzione: il caricamento della skill non gli concede accesso a dati o account. [Skill tool][h-skills].

### 4.4 Apprendimento e supervisione

Hermes dispone di scritture automatiche di memoria e skill e di review in background; `write_approval` permette di chiedere o accantonare la modifica per revisione. Il default del gate è disattivato. È un meccanismo concreto da studiare, non semplice marketing dell'“auto-miglioramento”. Scrivere una regola o una skill resta però distinto dal provare che migliori le esecuzioni successive. [Gate di scrittura][h-write], [documentazione memoria](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

Per Homun propongo: correzione → proposta di lezione con fonte e ambito → approvazione → versione → prova su un caso successivo. La concessione di maggiore autonomia resta una decisione separata, revocabile, dell'umano autorizzato. Occorre valutare anche lezioni sbagliate, regole obsolete e contaminazione tra clienti, non soltanto il numero di ricordi salvati.

### 4.5 Delega, budget ed evidenze

Hermes costruisce figli con goal e contesto espliciti; nel percorso esaminato disabilita l'eredità automatica di memoria e file di contesto e risolve separatamente capacità e provider. Questo è utile per contenere distrazioni e trasferimenti superflui. Gli agenti persistenti di Homun hanno però responsabilità di prodotto più ampie di un processo figlio: identità e revisioni devono restare nel dominio. [Costruzione del figlio][h-delegate].

Un dettaglio importante: il codice corrente assegna un `IterationBudget` a ciascun agente; il figlio nasce con un budget nuovo. La somma può superare il limite del padre. Non userei quindi il conteggio delle iterazioni come garanzia di costo complessivo. Homun richiede riserve e consumo per lavoro, includendo deleghe, sintesi, retry e retrieval che invoca modelli. [Budget][h-budget].

Le evidenze di completamento di Hermes includono controlli software e contratti PR. Il principio trasferibile è legare il successo a prove aggiornate; Homun deve definire verificatori anche per risultati non software: copertura righe, confronto prezzi, fonti, vincoli del brief e revisione umana della versione consegnata. [Evidenze][h-evidence].

### 4.6 Ripresa e confini di fiducia

Hermes possiede lease tra processi per le sessioni e registri durevoli per i tentativi cron. Il ledger cron marca `unknown` un tentativo abbandonato quando dimostra che il processo proprietario non è più vivo; non lo trasforma automaticamente in una nuova esecuzione. È un trattamento utile dell'incertezza sugli effetti. Questo non dimostra replay generale di ogni tool né equivalenza con il contratto DBOS di Homun. [Turn facade][h-turn], [ledger cron][h-cron].

Terrei DBOS e completerei ricevute/riconciliazione per ogni connettore con effetti. Il workflow Homun attuale attende un contributo e registra un effetto dimostrativo: la sua esistenza non prova ancora l'intero ciclo di esecuzione. Le garanzie vanno provate con arresto del processo prima e dopo l'effetto, contributi duplicati, revoca durante l'attesa e ripristino su archivio pulito. [Workflow Homun](../../engine/src/homun/runtime/workflows/work_run.py).

Per gli strumenti potenti, i permessi del dominio devono incontrare un confine operativo reale: risorse, rete, credenziali e filesystem esposti all'esecutore. La policy Hermes distingue chiaramente isolamento del terminale e isolamento dell'intero processo. Un adattatore autorizzato nel codice non rende innocua una shell che può raggiungere tutto il computer. La scelta deve precedere l'introduzione di tool arbitrari, in modo proporzionato alle capacità della prima versione. [Security policy][h-security].

## 5. Tre alternative

| Opzione | Vantaggio | Costo e limite | Valutazione |
|---|---|---|---|
| A. Pattern e componenti selezionati, stack Homun invariato | Migliora le parti mancanti preservando dominio e decisioni adottate | Richiede adattare e verificare i componenti scelti | Raccomandata |
| B. Hermes come esecutore esterno di alcuni passi | Accesso rapido a capacità agentiche già integrate | Due sistemi di sessione/memoria/approval; traduzione di eventi, risultati e cancellazione; isolamento da dimostrare | Eventuale esperimento successivo, circoscritto |
| C. Fork di Hermes come base di Homun | Grande superficie di funzionalità iniziale | Ridefinizione di autorità, identità, policy, durabilità, aggiornamenti e prodotto | Non giustificata dalle evidenze attuali |

Hermes espone protocolli per integrazione programmatica, quindi B è tecnicamente esplorabile; non è stata provata qui. Un prototipo dovrebbe ricevere solo un brief e input autorizzati, produrre un risultato ispezionabile e non possedere lo stato aziendale. [Protocolli di integrazione](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration).

Il repository riporta [licenza MIT][h-license]. Un eventuale riuso di codice deve registrare origine, commit, notice e dipendenze del componente; questa analisi non ha copiato codice Hermes nel motore Homun.

## 6. Ordine proposto per continuare sulle fondamenta

| Passo | Lavoro | Criterio verificabile di uscita |
|---|---|---|
| 0. Consolidare la base corrente | Stato documentato, checkpoint Git reviewabile, distinzione capability presente/integrata/provata; inventario dei dati recuperabili | Backup/ripristino includono materiali e stato necessario ai run, oppure dichiarano esattamente ciò che non recuperano |
| 1. Contesto e sessioni | Composizione unica, cronologia nativa, riferimenti/versioni, budget, autorizzazione comune prima del recupero | Comprende una correzione dopo riavvio; non include informazioni del cliente non autorizzato; mantiene obiettivo e approvazioni dopo sintesi |
| 2. Runner e capacità | Loop Pydantic AI con strumenti Homun; registry, errori, cancellazione, policy e budget | Una richiesta porta a lettura → tool → osservazione → risposta; tool revocato negato anche in una run esistente |
| 3. Skill e apprendimento | Catalogo su richiesta, procedure versionate, proposte di lezione e revisione | Skill caricata solo se pertinente; correzione applicata nello stesso ambito e assente in un altro |
| 4. Durabilità integrata | Collegamento runner/DBOS, contributi tipizzati, ricevute e riconciliazione | Crash prima/dopo effetto senza falsa conferma o retry cieco; input duplicato non duplica il lavoro |
| 5. Consegna e calibrazione | Artifact versionati, revisione e misure su compiti diversi | Catalogo, ricerca e documento completano il ciclo; qualità/latenza/costo misurati con modelli reali |

Questo ordine può essere adattato alle dipendenze: i contratti di autorizzazione e contabilità iniziano nel passo 1 e vengono applicati nel passo 2, non aggiunti alla fine. Packaging e cifratura restano prove precoci di fattibilità già previste nell'ADR; non propongo di rimandarle fino alla beta.

Per il primo confronto fra modelli preparerei un insieme piccolo e ripetibile di casi italiani: domanda ordinaria, chiarimento, scelta agente, modifica del piano, lettura CSV, richiesta di file mancante, errore tool recuperabile, risultato da correggere, memoria di due clienti e ripresa. Stessi input, contesto, capacità e limiti per ciascun modello. Misure: esito corretto, errori non rilevati, numero di interventi umani, latenza e consumo. Le soglie quantitative vanno concordate sul campione; non emergono dal confronto del codice.

## 7. Verifiche eseguite e limiti

Sono stati eseguiti sei file di test upstream Hermes sullo snapshot indicato:

| Test | Risultato |
|---|---|
| `tests/agent/test_iteration_budget_race.py` + `tests/hermes_state/test_session_turn_lease.py` | 24 passati |
| `tests/agent/test_context_engine.py` + `tests/tools/test_memory_tool.py` | 70 passati |
| `tests/tools/test_write_approval.py` + `tests/cron/test_execution_ledger.py` | 41 passati al secondo avvio |

Totale finale: **135 test passati**, nei sei file selezionati; non è la suite completa Hermes. I primi due comandi hanno chiuso con exit code 0. Nel terzo, il primo avvio aveva 39 passati e due casi bloccati da `ModuleNotFoundError: psutil`, anche nel teardown. Dopo l'aggiunta di `psutil==7.2.2` in una directory temporanea, il medesimo comando ha riportato 41 passati. Il codice upstream non è stato modificato.

Interprete usato: `/Users/fabio/Projects/Homun/homun2/engine/.venv/bin/python`, Python 3.13. La dipendenza aggiunta è sotto `/tmp/hermes-review-deps-20260919` e resa visibile soltanto al comando tramite `PYTHONPATH`; nessuna installazione nel venv Homun. I fixture upstream isolano i dati Hermes in directory temporanee. I comandi sono `python -m pytest -q` con i file elencati; per l'ultimo gruppo, prefisso `PYTHONPATH=/tmp/hermes-review-deps-20260919`.

Queste prove supportano soltanto i contratti esercitati. Non è stata avviata una conversazione Hermes con un provider reale, né confrontata la qualità su un compito aziendale. Non sono stati provati desktop, sandbox, MCP live, distribuzione o collegamento Hermes→Homun. L'affermazione “funziona bene” dell'utente resta esperienza utile; non viene trasformata qui in un benchmark indipendente.

## 8. Decisione proposta

Confermare la priorità alle basi e l'opzione A. Primo blocco da progettare insieme: **contesto/sessioni e confine delle capacità dell'agente**, sopra il dominio esistente e dentro la divisione Pydantic AI/DBOS/Homun già adottata. Memoria semantica, cataloghi estesi e altri backend diventano incrementi misurabili su questo nucleo. L'eventuale Hermes esterno resta un esperimento esplicito, successivo, senza trasformarsi in un secondo proprietario del lavoro.

[h-loop]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/conversation_loop.py
[h-assembly]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/turn_request_assembly.py
[h-context]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/context_engine.py
[h-prompt]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/system_prompt.py
[h-registry]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/registry.py
[h-mcp]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/mcp_tool.py
[h-memory-store]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/memory_tool_store.py
[h-search]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/session_search_tool.py
[h-memory-provider]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/memory_provider.py
[h-skills]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/skills_tool.py
[h-write]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/write_approval.py
[h-delegate]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/tools/delegate_tool.py
[h-budget]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/iteration_budget.py
[h-evidence]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/verification_evidence.py
[h-turn]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/agent/turn_facade.py
[h-cron]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/cron/executions.py
[h-kanban]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/hermes_cli/kanban_db.py
[h-pr]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/hermes_cli/kanban_pr_acceptance.py
[h-security]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/SECURITY.md
[h-license]: https://github.com/NousResearch/hermes-agent/blob/ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998/LICENSE
