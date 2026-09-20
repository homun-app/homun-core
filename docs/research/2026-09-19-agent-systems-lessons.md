# Lezioni operative da cinque sistemi agentici open source

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

Data di consultazione: 19 settembre 2026. Ricerca documentale e lettura di codice; nessuna esecuzione upstream, installazione di dipendenze, modifica al runtime o benchmark. Le proposte qui sotto sono distinte dalle funzionalità consegnate. Il primo passo sul contesto è stato poi implementato nella [slice circoscritta](2026-09-19-conversation-context-slice.md), con limiti ed evidenze espliciti; gli altri passi restano proposte.

## Risultato per Homun

La direzione più utile è rafforzare tre contratti: **contesto autorizzato e tracciabile, approvazione riferita a un'azione precisa, contabilità complessiva del lavoro**. I progetti studiati offrono meccanismi riutilizzabili come idee; nessuno dei meccanismi esaminati sostituisce automaticamente le policy aziendali Homun.

Resta valida l'[ADR adottata](../architecture/decisions/2026-09-17-f0-2-runtime-spike.md): Pydantic AI possiede il loop, DBOS le attese e il recovery, Homun dominio, permessi, budget, artifact e ricevute. Questa ricerca non propone LangGraph o un altro orchestratore nel motore. I confini locali sono documentati anche in [AccessGrant B2](../superpowers/specs/2026-09-18-access-grant-b2-design.md) e [runtime F4.1](../superpowers/specs/2026-09-18-f41-durable-runtime-design.md). Una specifica accettata non dimostra da sola implementazione o comportamento in produzione.

## Metodo e snapshot

- **Hermes:** aggiorna il [confronto precedente](2026-09-19-hermes-homun-comparison.md). Quel documento usava `ded0789f9ac5e3a3b2daeb8bb8e51b738fea9998`; il nuovo clone shallow ha HEAD `236689b9b4ce70099da10a3fabf54bb96898cf45`, verificato con `git rev-parse HEAD` e corrispondente al remote HEAD osservato. Clone: `/tmp/homun-hermes-research-20260919`. Letti soltanto file; il clone precedente è rimasto invariato.
- **LangGraph, Letta, OpenHands Software Agent SDK, Microsoft Agent Framework:** documentazione ufficiale corrente consultata online. Non sono snapshot immutabili di release né verifiche del loro runtime; gli URL riportano i contratti descritti alla data di consultazione. Microsoft Agent Framework è stato scelto come quarto confronto oltre a LangGraph, Letta e OpenHands, senza introdurre dipendenze AutoGen.
- **Evidenza** significa testo ufficiale o codice direttamente letto. **Proposta/inferenza Homun** significa conseguenza progettuale da verificare localmente. Non si deduce l'assenza di una capacità perché non compare nelle pagine selezionate.

## 1. Hermes: composizione del contesto e limiti della contabilità

**Evidenza dal codice corrente.** `ContextEngine.select_context()` opera per richiesta, anche nei retry. Il contratto distingue la lista inviata al provider dallo storico persistito, che non deve essere mutato. `on_turn_complete()` è invece un hook di osservazione best-effort, saltato in alcuni percorsi di uscita anomala: non è una base sufficiente per ricevute contabili obbligatorie. [Contratto ContextEngine](https://github.com/NousResearch/hermes-agent/blob/236689b9b4ce70099da10a3fabf54bb96898cf45/agent/context_engine.py).

La documentazione distingue il plugin che governa selezione/compattazione dal provider memoria che osserva i turni. Durante una compressione con timeout, l'elaborazione lavora su uno snapshot e può proseguire dopo il timeout: gli effetti durevoli fuori dal commit sono quindi esplicitamente sconsigliati. È una lezione concreta sulla separazione tra calcolo e pubblicazione del risultato. [Context engine plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin).

`IterationBudget` è un contatore thread-safe per singolo agente. Padre e figli hanno cap separati: il totale può superare quello del padre. Inoltre alcuni turni `execute_code` vengono rimborsati nel contatore. Non è un budget monetario del lavoro. [IterationBudget](https://github.com/NousResearch/hermes-agent/blob/236689b9b4ce70099da10a3fabf54bb96898cf45/agent/iteration_budget.py).

Il ledger cron usa uno stato `unknown` quando il processo proprietario è dimostrato terminato senza esito durevole; non presume che l'effetto non sia avvenuto. Il gate di scrittura memoria/skill, invece, è disattivato per valori mancanti o non validi. [Ledger cron](https://github.com/NousResearch/hermes-agent/blob/236689b9b4ce70099da10a3fabf54bb96898cf45/cron/executions.py), [write approval](https://github.com/NousResearch/hermes-agent/blob/236689b9b4ce70099da10a3fabf54bb96898cf45/tools/write_approval.py).

La security policy definisce Hermes personale single-tenant e pone nell'isolamento OS il confine di contenimento. Specifica che isolare il backend terminale non isola automaticamente plugin, hook, MCP o codice nel processo agente. Le scansioni del prompt e le allowlist interne non sono descritte come contenimento contro un LLM avversario. [Security policy](https://github.com/NousResearch/hermes-agent/blob/236689b9b4ce70099da10a3fabf54bb96898cf45/SECURITY.md).

**Proposta Homun:** adottare il confine storico/vista per richiesta; mantenere ricevute e contabilità fuori dagli hook best-effort. Riutilizzare il concetto di effetto incerto, senza creare un secondo recovery cron accanto a DBOS. Evitare di importare il trust model personale come autorizzazione tra progetti aziendali.

## 2. LangGraph: riprendere significa rieseguire un tratto

**Evidenza documentale.** Un interrupt richiede payload serializzabile, checkpointer e `thread_id` stabile. Alla ripresa tramite `Command(resume=...)`, il nodo riparte dall'inizio: il codice prima dell'interrupt viene eseguito nuovamente. Per più richieste concorrenti è possibile associare ogni risposta all'ID del suo interrupt. [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

La persistenza distingue checkpoint del singolo thread e store di conoscenza tra thread. Un saver in memoria perde i checkpoint al riavvio; salvare conversazioni e salvare conoscenza riutilizzabile sono due responsabilità differenti. [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

**Proposta Homun:** usare questa distinzione come criterio di test DBOS: riavvio durante attesa, risposta duplicata, risposta riferita alla richiesta errata e effetto già applicato. L'identificatore di ripresa non concede accesso: il dominio deve autenticare e autorizzare il contributore. Conservare separatamente transcript, richieste di contributo, memoria approvata e ricevute. Non aggiungere il grafo LangGraph sopra il workflow esistente.

## 3. Letta: blocchi di memoria con uno scopo dichiarato

**Evidenza documentale.** I memory block hanno etichetta, descrizione, valore e limite di caratteri; sono inseriti nel contesto senza retrieval. Possono essere condivisi tra agenti. Sono modificabili per default; `read_only=true` impedisce all'agente di aggiornarli. La descrizione specifica a cosa serve il blocco. [Memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks).

L'API consente di configurare il requisito di approvazione di un tool associato a un agente. Il protocollo distingue una risposta di approvazione dal risultato di un tool eseguito dal client, entrambi correlati alla chiamata. Questo rende esplicito chi esegue materialmente l'azione. [Tool approval](https://docs.letta.com/api/typescript/resources/agents/subresources/tools/methods/update_approval), [client tools](https://docs.letta.com/guides/agents/tool-execution-client-side/).

**Proposta Homun:** comporre poche sezioni nominate — identità/revisione agente, vincoli del lavoro, fatti autorizzati, materiale pertinente — con scopo e limite espliciti. I vincoli approvati sono una proiezione del dominio, non una memoria liberamente editabile dall'agente. La condivisione di un blocco non prova né provenienza dei fatti né autorizzazione del destinatario: servono source ID, versione, ambito e controllo AccessGrant. Rinviare l'adozione di Letta come servizio di memoria: aggiungerebbe un altro proprietario di sessione e stato senza necessità dimostrata.

## 4. OpenHands: vista derivata, osservazioni e costo completo

**Evidenza documentale.** Il condenser produce un evento `Condensation` con riepilogo e `forgotten_event_ids`; la vista ricostruita filtra quegli eventi per il modello. La sintesi è quindi rappresentata esplicitamente anziché diventare indistinguibile dai messaggi originali. [Condenser](https://docs.openhands.dev/sdk/arch/condenser).

Le metriche sono accessibili per istanza LLM e aggregate per conversazione, includendo modelli ausiliari come il condenser. `usage_id` identifica separatamente i diversi usi. Questa pagina documenta contabilità, non una garanzia transazionale di riserva della spesa. [Metrics](https://docs.openhands.dev/sdk/guides/metrics).

La conferma è governata da una policy; l'analizzatore del rischio è un componente distinto. Sono documentati `AlwaysConfirm`, `NeverConfirm`, `ConfirmRisky` e lo stato di attesa con azioni pendenti. [Security and action confirmation](https://docs.openhands.dev/sdk/guides/security).

La memoria persistente è opt-in: indice utente e indice progetto, note giornaliere recuperate su richiesta, contenuto esplicitamente trattato come non verificato. L'indice iniettato ha un limite e la troncatura viene segnalata. Il testo risolto viene riletto a inizio sessione ed escluso dallo stato conversazione serializzato: questo dettaglio impedisce di presumere che ripristinare la sessione riproduca esattamente il contesto memoria precedente. [Persistent memory](https://docs.openhands.dev/sdk/guides/persistent-memory).

I confini SDK, tool, workspace ed agent server sono separati; le applicazioni consumano le interfacce. [Architettura](https://docs.openhands.dev/sdk/arch/overview).

**Proposta Homun:** riusare l'idea di derivazione con riferimenti sorgente e consumo aggregato. Una sintesi deve conservare i riferimenti alle versioni consultate e poter essere invalidata dopo revoca o modifica. Un'etichetta “non verificato” aiuta il modello ma non applica una policy: i filtri devono precedere caricamento, indicizzazione e invio al provider. Tenere capacità, esecutore e UI separati senza replicare l'intero SDK.

## 5. Microsoft Agent Framework: richieste pendenti come stato durevole

**Evidenza documentale.** Il workflow usa un canale request/response tipizzato per contributi esterni. Le richieste pendenti vengono salvate nei checkpoint e riemesse come `RequestInfoEvent` dopo il ripristino; la stessa infrastruttura può trasportare richieste di approvazione tool. [Human in the loop](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop).

I checkpoint catturano stato degli executor, messaggi pendenti, richieste/risposte e stato condiviso ai confini previsti dal runtime. La documentazione distingue storage in memoria, file e database; segnala inoltre la necessità di controllare gli accessi ai dati checkpoint. Le garanzie dipendono dal backend effettivamente scelto. [Checkpoints](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints).

**Proposta Homun:** la chat ricostruisce una richiesta pendente dal dominio durevole, senza dipendere da un evento WebSocket ancora in memoria. Alla riconnessione, riemettere una richiesta significa ripresentare la stessa richiesta, non crearne una seconda. Versione dell'azione, autorità del revisore, scadenza e stato restano verifiche Homun. Rinviare ulteriori framework multi-agent: qui interessa il protocollo, già realizzabile sopra DBOS.

## Scelte trasversali: adottare, evitare, rinviare

| Tema | Adottare come pattern | Evitare | Rinviare |
|---|---|---|---|
| Contesto | Vista per richiesta, sezioni nominate, fonti/versioni, limiti espliciti | Riscrivere il transcript con la sintesi; selezionare prima di autorizzare | Sintesi automatica complessa finché i casi base non sono affidabili |
| Approvazione | Request ID, azione/argomenti/versione, risposta tipizzata, recupero dopo riavvio | Un semplice `approved=true` riutilizzabile dopo cambi di piano | Interfacce di approvazione nuove; basta il contratto motore |
| Tool | Schema, effetto, capability, esecutore e ricevuta separati | Scambiare disponibilità o stima del rischio per permesso | Shell arbitraria e nuovi sandbox prima del contratto di isolamento |
| Budget | Limite per lavoro e tentativi identificati, comprese sintesi e retry | Equiparare contatore iterazioni e costo; registrare solo il modello principale | Ottimizzazioni di routing non misurate |
| Memoria | Ledger approvato con ambito e provenienza, indice ricostruibile | Promuovere testo agent-written a istruzione autorevole | Un nuovo servizio memoria come fonte primaria |
| Moduli | Policy comune, compositore, adattatori runtime/tool e API sottili | Ampliare un god-file o aggiungere un secondo orchestratore | Plugin general-purpose prima di contratti stabili |

## Tre prossimi passi concreti e a rischio contenuto

Sono proposte di slice successive, compatibili con il lavoro in corso su sessioni e autorizzazione; vanno riusate le strutture esistenti prima di creare nuovi moduli.

1. **Manifest del contesto autorizzato.** Aggiungere al percorso di composizione un risultato tipizzato con ID/versioni delle fonti incluse, motivi delle esclusioni, limiti applicati e versione delle istruzioni. Iniziare da transcript e dati già locali, senza retrieval remoto o sintesi LLM. Test di uscita: cambio grant tra turni esclude la fonte; correzione dopo riavvio resta comprensibile; errore di caricamento esplicito; nessuna inclusione da altro workspace. Il manifest deve evitare duplicazione del testo sensibile e avere lo stesso controllo di lettura delle fonti.

2. **Contratto di ripresa per una sola azione simulata nel motore di test.** Legare richiesta e risposta a `request_id`, `run_id`, revisione e digest degli argomenti; rivalutare capability al momento dell'esecuzione. Usare un esecutore fake con ricevuta, senza connettori esterni. Test di uscita: risposta duplicata, revisione obsoleta, grant revocato durante l'attesa e crash dopo effetto non provocano doppia applicazione o falsa conferma. DBOS resta unico proprietario dell'attesa/recovery. Il mock del tool è una prova di contratto, non un'esecuzione reale del prodotto.

3. **Budget aggregato con prenotazione locale.** Estendere la contabilità esistente con categoria del tentativo (`model`, `summary`, `retrieval`, `tool`), relazione al lavoro e operazione atomica di riserva/rilascio. Prima prova con adapter fake, due richieste concorrenti e consumo sconosciuto: il secondo tentativo non supera la disponibilità prenotata, la ripresa non addebita due volte lo stesso attempt, l'usage assente non diventa zero. Il prezzo reale e la qualità dei modelli restano una prova successiva separata.

Questi passi rendono ispezionabile ciò che un agente ha visto, ciò che un umano ha autorizzato e ciò che il lavoro ha consumato. Non richiedono migrazione di stack, modifiche grafiche o nuovi account.

## Limiti della verifica

Nessun test upstream o confronto prestazionale è stato eseguito in questa ricerca. Nessun codice esterno è stato importato o avviato. I test Hermes riportati nel confronto precedente appartengono a quella ricerca e al suo snapshot, non al nuovo HEAD. Non sono stati verificati qualità dei riepiloghi, isolamento effettivo dei sandbox, correttezza dei backend cloud o garanzie end-to-end di approvazione dei cinque prodotti. Le proposte richiedono prove Homun mirate; le fonti costituiscono evidenza dei meccanismi descritti, non certificazione di affidabilità.
