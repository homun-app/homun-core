# Homun: revisione delle fondamenta per la produzione

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

19 settembre 2026 — proposta da discutere, non piano già approvato né dichiarazione di readiness. Integra il [confronto Hermes](2026-09-19-hermes-homun-comparison.md). Nessuna modifica al codice applicativo in questa revisione.

## Obiettivo e regola di consegna

Costruire componenti destinati a restare nel prodotto: responsabilità delimitata, contratto pubblico, dati posseduti, migrazioni, autorizzazione, gestione degli errori e prove operative. Le funzionalità arrivano in incrementi; le garanzie necessarie a quelle funzionalità si completano nello stesso incremento.

“Non doverci ritornare” significa evitare componenti deliberatamente provvisori e debito rinviato sulla correttezza. Manutenzione, aggiornamenti dei provider e migrazioni future rimangono necessari. La progettazione deve renderli locali al modulo interessato.

Il perimetro di prodotto resta quello delle specifiche: motore Python indipendente, client React, agenti e persone, progetti/materiali, apprendimento supervisionato, dati locali e collaborazione autorizzata tra installazioni. Le fasi sotto sono ordine di costruzione; non riducono implicitamente la beta a una demo su localhost.

## Evidenze sul codice attuale

| Osservazione | Evidenza | Revisione necessaria |
|---|---|---|
| Orchestrazione concentrata | `domain/service.py`: 1.712 righe, con regole, autorizzazioni, I/O file e chiamate al runtime | Separare funzionalità e dipendenze, oltre ai file |
| Shell UI ancora estesa | `ConversationWorkspace.tsx`: 1.672 righe | Composizione dei pannelli; logica e stato separati per funzionalità |
| Snapshot globale a ogni save | `SqliteWorkspaceRepository.save` cancella e reinserisce entities, events e commands | Transazioni incrementali su dati indicizzati e letture paginate |
| Stato autorevole duplicato nel processo | Store globale caricato in memoria; il repository persiste successivamente | Database autorevole; cache/read model espliciti e invalidabili |
| Deduplica incompleta | `DomainService.apply` confronta il tipo, non il payload, per un command_id esistente | Identità della richiesta persistita e controllo di contenuto, attore e workspace |
| Identità dichiarata dal client | `_actor_from_headers` costruisce Actor da X-Homun-Actor-Id | Identità derivata da sessione verificata; membership e policy lato motore |
| Permessi non uniformi | Le route memoria non applicano i grant di progetto come quelle dei materiali | Policy comune sulle letture, sul retrieval, sugli export e sulle azioni |
| Durabilità dichiarata troppo presto nello stream | `/commands/stream` emette `persisted` prima di `ctx.persist()` | Eventi dopo il commit; token provvisori distinguibili da fatti durevoli |
| Effetti avviati dentro il servizio | DomainService chiama il bridge DBOS e scrive blob | Commit del dominio e consegna al runtime con contratto di recupero |
| Recovery incompleto | Backup attuale esclude blob; le credenziali sono JSON in chiaro con permessi 0600 | Backup coerente completo, custodia delle chiavi e procedura di ripristino |

Prova eseguita in questo turno, senza file né provider: due `conversation.create` con lo stesso command_id e titoli diversi restituiscono lo stesso risultato e mantengono il primo titolo, invece di segnalare conflitto. È una verifica della deduplica attuale, non una correzione.

Le altre righe sono osservazioni del sorgente. Non sono state eseguite in questo turno prove di concorrenza, penetrazione o interruzione del processo; i rischi corrispondenti devono diventare casi di accettazione.

Riferimenti: [servizio](../../engine/src/homun/domain/service.py), [storage](../../engine/src/homun/storage/sqlite.py), [API](../../engine/src/homun/routes/domain.py), [contesto globale](../../engine/src/homun/context.py), [memoria](../../engine/src/homun/routes/memory.py), [segreti](../../engine/src/homun/models/secrets.py), [backup](../../engine/src/homun/storage/backup.py).

## Che cosa mantenere

- Pydantic AI per il ciclo agentico e gli adattatori; DBOS per workflow durevoli e attese. La [decisione adottata](../architecture/decisions/2026-09-17-f0-2-runtime-spike.md) resta valida.
- Motore Python e API indipendenti dall'interfaccia.
- Concetti di Work, Conversation, PlanRevision, ContributionRequest, ArtifactVersion, Review e grant, completandone gli invarianti.
- SQLite come scelta locale, previa verifica di cifratura e packaging; va cambiato il modello di accesso attuale, non sostituito automaticamente il database.
- Errori tipizzati, versioni, identità stabili e separazione esplicita demo/motore.
- Ledger Homun come autorità per la memoria; indice semantico ricostruibile.
- Test esistenti come base di caratterizzazione, distinguendo i test delle scorciatoie dai contratti da conservare.

Hermes resta riferimento per contesto, skill, ciclo degli strumenti e casi operativi. Incorporarne il runtime introdurrebbe adesso un secondo proprietario di sessioni, memoria e recovery.

## Architettura proposta senza moduli onniscienti

Un'installazione locale può contenere più moduli con confini verificabili. Separare processi soltanto dove occorre isolamento o un ciclo di vita diverso; il numero di processi non misura la modularità. Il codice di composizione collega dipendenze esplicite all'avvio e non offre un service locator globale ai moduli.

| Modulo | Responsabilità e dati posseduti | Contratto verso gli altri |
|---|---|---|
| Identity/access | Sessioni, membership, grant, revoche | Principal verificato e decisioni di accesso |
| Conversations | Messaggi, riferimenti, continuità, sequenza degli eventi | Letture autorizzate e append versionato |
| Work/planning | Obiettivo, revisioni del piano, contributi, transizioni | Comandi validati, eventi e snapshot del lavoro |
| Agent profiles | Identità e revisioni del collaboratore | Profilo eseguibile immutabile per tentativo |
| Context | Selezione di storico, contratto, fonti e memorie | Pacchetto di contesto con provenienza e budget |
| Agent execution | Adattamento del loop Pydantic AI e lifecycle del tentativo | Risultato, errore, contributo o azione proposta tipizzati |
| Tool capabilities | Catalogo, connessioni, ToolGrant, invocazione controllata | Capacità utilizzabili e risultati con ricevuta |
| Durable execution | Integrazione DBOS, attese, consegna e riconciliazione | Run/attempt e avanzamenti durevoli |
| Materials/artifacts | Originali, versioni, estrazione, consegne | Riferimenti immutabili, hash e contenuto autorizzato |
| Knowledge/skills | Lezioni, procedure, approvazioni e indice | Recall/procedura con ambito, fonte e versione |
| Usage/budgets | Consumi, riserve, limiti e riconciliazione | Autorizzazione della spesa e registrazione per tentativo |

Storage, cifratura, segreti, API e telemetria forniscono adattatori ai contratti. Non devono diventare nuove directory generiche che possiedono tutte le regole. Moduli che condividono una transazione possono usare la stessa unità di lavoro, senza accedere direttamente alle tabelle altrui.

Dipendenze consentite: trasporto → casi d'uso; casi d'uso → regole e porte; adattatori → porte. Le regole di dominio non importano FastAPI, DBOS, SDK dei provider o implementazioni filesystem. Le dipendenze tra funzionalità passano per API pubbliche e tipi specifici; niente import circolari.

Per la UI: shell di composizione, pannelli per funzionalità, hook dedicati e client tipizzati. Le viste chat, compiti e progetto leggono lo stesso stato del motore. Le regole aziendali e la loro autorità restano nel backend.

### Vincoli verificabili in CI

- Test delle dipendenze tra moduli e divieto di cicli/import interni non autorizzati.
- Divieto di I/O infrastrutturale nelle regole pure e di accesso diretto al database da route/UI.
- Un solo percorso applicativo per comando, condiviso da HTTP, streaming e futuri client.
- Proposta di soglie per nuovo codice: revisione obbligatoria oltre 500 righe; blocco oltre 800 salvo eccezione specifica documentata. Sono segnali aggiuntivi: una classe onnisciente di 300 righe viola comunque il confine.
- File esistenti fuori soglia migrati nelle prime tranche; nessuna nuova funzionalità aggiunta al loro corpo durante la transizione.
- Niente suddivisione cosmetica in mixin che condividono tutto lo stato di un oggetto globale. Ogni estrazione deve avere input, output e dipendenze identificabili.
- API e schemi versionati, compatibilità verificata e migrazioni riproducibili.

## Garanzie da chiudere prima di ampliare le capacità

### Persistenza e avvio del lavoro

Ogni comando accettato registra atomicamente mutazione, evento, risultato/deduplica e intenzione di consegna al runtime. Un `command_id` riutilizzato con input o attore incompatibili produce conflitto, senza rivelare risultati a chi non è autorizzato. Concorrenza gestita nel database con revisioni, vincoli e transazioni, senza affidarsi al solo controllo di dizionari in memoria.

L'intenzione persistita di avviare o risvegliare DBOS viene consegnata con identificatori stabili; se il processo muore tra commit e consegna, viene riconciliata. L'outbox è un meccanismo di consegna del dominio, non un secondo scheduler di workflow. DBOS mantiene il proprio ruolo nel recovery. Nessuna transazione SQL rimane aperta durante una chiamata al modello o a un servizio remoto.

Per i blob serve un protocollo esplicito di staging/finalizzazione e pulizia degli orfani: non esiste una transazione magica comune tra SQLite e filesystem. Il backup deve includere una vista coerente di metadati, originali e stato necessario alla ripresa, con verifica degli hash e prova di restore.

### Identità, autorizzazione e protezione dei dati

Definire ora il contratto di identità di persona/device e sessione del client. La UI locale non può scegliere liberamente l'attore effettivo. Le stesse decisioni di accesso devono valere per lista, dettaglio, ricerca, snippet, memoria, export, strumenti e delega; le revoche si rivalutano prima delle azioni future.

Scegliere e provare custodia OS dei segreti e cifratura di database, blob e checkpoint, insieme al recupero delle chiavi. La libreria definitiva si seleziona con una prova su installazione Mac e ripristino, senza crittografia personalizzata. Non congelare schema e packaging ignorando i vincoli del database DBOS o degli indici.

I tool con codice, browser o accesso arbitrario ai file richiedono risorse esposte e isolamento espliciti. La prima capacità rilasciata deve già avere il proprio limite operativo; l'isolamento non viene rinviato a quando saranno disponibili più plugin.

### Contesto, esecuzione ed eventi

Contratto e approvazioni sono dati esatti; non vengono ricostruiti da riassunti. Il contesto contiene riferimenti/versioni, criteri di selezione e budget. Memorie e materiali entrano dopo l'autorizzazione, con controllo finale prima della chiamata. Gli indici non devono produrre snippet non autorizzati.

Streaming reale delle risposte quando il provider lo supporta; fallback dichiarato quando non lo supporta. Distinguere token provvisori, messaggio concluso ed evento committato. Persistenza delle richieste prima della lavorazione, cursori di riconnessione e cancellazione con semantica esplicita. Un client disconnesso non deve perdere il lavoro né rilanciarlo implicitamente.

Limiti per run e budget del lavoro comprendono figli, retry, sintesi e altri consumi ausiliari. Se il provider non restituisce usage affidabile, si conserva il consumo come sconosciuto e si applica la policy prevista; non si dichiara un tetto economico garantito senza meccanismo conservativo di riserva.

## Ordine di realizzazione rivisto

La revisione del confronto Hermes è questa: il contesto rimane la prima grande capacità agentica da completare, ma deve poggiare su garanzie transazionali, identità e moduli già corretti.

| Tranche | Contenuto | Condizione per chiuderla |
|---|---|---|
| A. Baseline e decisioni di fondazione | Stato attuale reviewabile; mappa dei moduli/dipendenze; contratti e invarianti; prove di cifratura, segreti e packaging; CI | Decisioni tecniche motivate da prove; elenco di ciò che si conserva e migra; nessun comportamento noto perso |
| B. Nucleo transazionale e modulare | Estrarre handler/regole/repository; schema incrementale e migrazioni; deduplica completa; outbox; sessione verificata e policy comune; API sottili | Concorrenza, replay, rollback, revoca e crash tra commit/consegna verificati; niente stato globale autorevole |
| C. Lifecycle e recupero dei dati | Blob/versioni, cifratura scelta, segreti OS, backup completo, restore e upgrade; startup/shutdown verificati | Mac pulito: installazione, import, riavvio, upgrade e restore senza perdita delle fonti e senza esiti inventati |
| D. Fondamenta agentiche | Context, runner Pydantic AI, registry capacità, budget, streaming/cancel e collegamento DBOS | Sessioni lunghe, tool multipli, errori, contributi, interruzioni e revoche corretti con provider reale |
| E. Conoscenza e consegne | Skill, apprendimento supervisionato, artifact e review per versione | Lezione applicata nel proprio ambito; risultato correggibile; approvazione invalida dopo modifica |
| F. Collaborazione e verifica del prodotto | Collegamento autorizzato tra installazioni e workflow di prodotto sulle stesse API | Due installazioni, rete interrotta/revoca/ripresa, scenari aziendali e limiti operativi verificati |

Le identità e i contratti peer si definiscono in A/B; il trasporto e la collaborazione completi si validano in F. Nessuna promessa di collaborazione produttiva prima di quel gate. Stessa logica per le altre capacità: assenti o dichiaratamente non rilasciate fino alla prova, senza fallback sulla simulazione.

Ogni tranche è composta da cambi piccoli e compatibili. Una migrazione sposta un proprietario alla volta, elimina il vecchio percorso dopo verifica e conserva un modo documentato di ripristinare la versione precedente. Non mantenere indefinitamente due sistemi autorevoli in dual-write.

## Prima tranche implementativa proposta

Dopo le decisioni A, il primo cambiamento B dovrebbe rendere corretto il percorso comune di un comando, usando `conversation.create` come caso iniziale: identità verificata → policy → handler specifico → transazione con risultato ed evento → risposta. Deve rifiutare stesso ID con payload diverso e preservare un retry identico anche dopo riavvio.

Questa è una tranche limitata per estensione ma completa nelle garanzie. Si estende poi lo stesso percorso ai comandi di lavoro/piano, profili, materiali e contributi. L'estrazione non aggiunge un `CommandService` che contiene tutte le regole: il dispatcher registra handler indipendenti e una pipeline comune applica solo le responsabilità trasversali.

La UI viene migrata per funzionalità attraverso lo stesso contratto; nessun refactoring estetico o ridisegno del flusso è necessario per chiudere questa tranche.

## Definizione di pronto per produzione

Una capacità è pronta nel perimetro dichiarato quando supera controlli automatici e prove reali pertinenti:

1. Contratto e proprietario dei dati univoci; architettura verificata automaticamente.
2. Test del dominio e dei contratti, integrazione con storage/runtime reali, errori e concorrenza.
3. Prova di crash/ripresa e riconciliazione degli effetti applicabili.
4. Autenticazione, accessi, revoche e isolamento verificati; niente segreti in log/export.
5. Migrazione, backup e ripristino provati; compatibilità degli aggiornamenti del runtime controllata.
6. Osservabilità con work/run/attempt/command correlati, errori azionabili e readiness basata sul runtime effettivo.
7. Budget e uso risorse limitati: query paginate, dimensioni file/output/contesto, retention e cancellazione.
8. Verifica nella UI reale e nell'app installata, non soltanto build e API locali.
9. Per capacità AI, prove su un campione di compiti italiani con qualità, interventi umani, latenza e consumo registrati.

Le soglie prestazionali e i modelli supportati si fissano in A usando hardware e carico target. Non vengono inventati numeri di latenza o affidabilità senza misure. Dipendenze e build devono essere riproducibili; nuove versioni si adottano attraverso gli stessi gate.

## Decisione da prendere

Adottare questa sequenza come revisione delle priorità, confermando lo stack esistente. Il primo impegno è A+B: confini dei moduli e nucleo affidabile dei comandi, con scelte di dati/identità/cifratura/packaging verificate prima di estendere l'esecuzione agentica. Le milestone precedenti restano evidenze di componenti implementati; non vengono presentate come certificazione di produzione.


## Attuazione autorizzata — 19 settembre 2026

La prima tranche è implementata e verificata: [rapporto di consegna](2026-09-19-production-foundations-delivery.md).
Include ammissione transazionale, delta storage, scomposizione dei comandi, controlli architetturali,
outbox e lifecycle; non chiude l'intera proposta A–F. Le decisioni di distribuzione e protezione
dati hanno una [verifica di fattibilità separata](2026-09-19-production-release-gates.md).
