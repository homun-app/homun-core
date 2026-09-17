# Homun — piano di sviluppo del motore e del prodotto

> Specifica consolidata da analizzare: [pacchetto v0.1](../specifications/README.md). Chiarisce decisioni, proposte e scelta ancora aperta del backend memoria; prevale sulle ipotesi non confermate di questo documento.

Data: 17 settembre 2026. Stato: piano proposto, da aggiornare con le decisioni su distribuzione e disponibilità dei dati. Nessuna implementazione del motore avviata con questo documento.

**Obiettivo:** rendere reale il ciclo conversazione → piano → contributi → esecuzione → risultato → revisione, mantenendo la UX del prototipo e collegando installazioni autonome senza backend centrale Homun obbligatorio.

**Architettura proposta:** frontend React esistente, dominio e runtime persistenti Python, archivio locale per nodo, API e adattatore di comunicazione tra nodi. Prima una sola autorità per spazio, poi distribuzione selettiva e delega; replica con failover è un traguardo distinto.

**Scelte confermate:** React/TypeScript per la UI, Electron per le versioni installabili, Python per il motore. FastAPI/Pydantic, storage, framework agente e trasporto peer restano da validare nelle prove F0.

Questo è il piano complessivo di prodotto con pacchetti verificabili, non una sequenza di patch già eseguibili: ogni fase produce la propria specifica esecutiva con versioni, migrazioni e test dopo il relativo gate. Non inventare contratti di SDK o migrazioni definitive prima delle prove. Esecuzione sequenziale con checkpoint; nessuna delega automatica ad altri agenti richiesta.

Riferimenti: [architettura](../architecture/2026-09-17-motore-homun.md), [rete tra app](../architecture/2026-09-17-rete-tra-applicazioni.md), [distribuzione dati](../architecture/2026-09-17-distribuzione-dati.md).

> Aggiornamento di Fabio: dati locali e trasferimento del solo necessario, con cifratura. La blockchain resta un mezzo proposto da valutare, non un requisito. Il dettaglio è nel documento sulla distribuzione dati.

> Scelta tecnica raccomandata dopo confronto: **Pydantic AI + DBOS**. [Motivazioni, licenze e prova di adozione](../architecture/2026-09-17-scelta-framework.md). DBOS sostituisce lo sviluppo da zero di checkpoint, code e recovery; i task seguenti descrivono integrazione e verifiche.

> Memoria: per accelerare il prodotto, raccomandato **Mem0 OSS locale dietro MemoryPort**, sostituibile in seguito con componenti Homun. [Scelta e prove](../architecture/2026-09-17-memoria-riutilizzabile.md). Prima prova di memoria anticipata in F3; F8 estende formazione e condivisione.

## 1. Decisioni e gate

| ID | Decisione | Proposta | Quando serve |
|---|---|---|---|
| D1 | Proprietà dello spazio e distribuzione | Nodo responsabile per spazio, copie autorizzate selettive | Prima dello schema persistente |
| D2 | Operatività offline | Letture già disponibili e bozze; comandi condivisi in attesa | Prima di rete e sync |
| D3 | Accesso Internet | Diretto quando possibile, relay configurabile se necessario | Prima del pilot fuori LAN |
| D4 | Runtime | Python modulare; SDK agente dietro adattatore | Fine F0 |
| D5 | Framework esecuzione | DBOS, da validare con crash/resume, plugin dinamici e cifratura | Fine F0 |
| D6 | Modelli iniziali | Un remoto e uno locale scelti su casi di prova/hardware | Prima di F3 live |
| D7 | Connettori iniziali | Materiali locali, ricerca web, Trello; email in fase seguente | Prima di F6 |
| D8 | Distribuzione desktop | Mac iniziale, pacchetto autosufficiente senza Docker obbligatorio | Fine F0 |
| D9 | Disponibilità continua | Nodo aziendale acceso opzionale; nessuna promessa a nodi spenti | Prima di automazioni |
| D10 | Licenza e confini gratuiti | Core gratuito; licenza e costi servizi dichiarati | Prima di rilascio pubblico |

Le domande su D1–D3 sono in discussione con Fabio. Il piano permette di avanzare sui contratti comuni ma non tratta queste proposte come approvate.

## 2. Milestone di prodotto

| Traguardo | Cosa può fare Fabio | Fasi |
|---|---|---|
| Alpha locale | Un lavoro reale con materiale, piano, pausa/ripresa, consegna e revisione | F0–F4 |
| Pilot collaborativo | Due app condividono contesto autorizzato e una delega verificabile; un connettore reale | F5–F6 |
| Beta aziendale | Routine, memoria, costi, settings completi, backup e installazione affidabile | F7–F10 |
| Estensione successiva | Replica avanzata, failover, nuovi canali, automazione del desktop | F11 |

Il prototipo resta disponibile come riferimento e simulatore in tutte le fasi. Ogni feature reale deve dichiarare disponibilità/errore; non deve ricadere silenziosamente su una risposta finta.

## 3. Struttura proposta dei file

Percorsi nuovi, salvo quelli indicati come esistenti:

```text
engine/
  pyproject.toml
  src/homun/
    domain/                 # entità, comandi, stati e invarianti
    api/                    # HTTP, stream eventi e OpenAPI
    storage/                # repository, unità transazionale, migrazioni
    runtime/                # worker, lease, recovery, cancellazione
    identity/               # utenti, dispositivi, membership
    policy/                 # accesso e autorizzazione delle azioni
    models/                 # provider, routing, usage
    planning/               # proposta strutturata e patch piano
    materials/              # blob, versioni, parser, indici
    context/                # selezione fonti e limite token
    memory/                 # fatti, riassunti e lezioni
    tools/                  # manifest, adapter e ricevute
    automations/            # trigger, occorrenze e deduplica
    peers/                  # pairing, replica selettiva e delega
    notifications/          # inbox persistente
  tests/{unit,integration,recovery,security}/
contracts/                  # schema API ed eventi versionati
src/features/workspace/     # client e proiezioni UI reali
src/components/builder/     # componenti UX esistenti, riusati gradualmente
apps/desktop/               # shell Electron; packaging e processo Python da validare in F0
runtime/network/            # solo se il trasporto richiede processo dedicato
fixtures/engine/            # casi di prova non sensibili
tests/e2e/                 # flussi reali e regressione UX
```

Non introdurre tutti i file vuoti in anticipo. Ogni fase crea soltanto i propri moduli. Non modificare `../app` per estrarre componenti prima di averne verificato confini e test.

## 4. Backlog ordinato

### F0 — Decisioni tecniche e prove ridotte

Dipendenze: nessuna. Output: ADR in `docs/architecture/decisions/`, prove isolate in `experiments/engine/`.

- [ ] F0.1 Inventariare componenti riusabili del vecchio Homun: modelli, segreti, browser, file, memoria e packaging. Per ciascuno: interfaccia, dipendenze, licenza, test eseguibile e costo d'isolamento; scegliere riusa/adatta/non usare.
- [ ] F0.2 Validare Pydantic AI + DBOS sullo scenario: output tipizzato → contributo umano → riavvio processo → ripresa → tool con effetto incerto. Scartare soluzioni che tengono l'attesa soltanto in RAM.
- [ ] F0.3 Prova di packaging: avvio servizio Python su Mac pulito senza terminale, handshake, riavvio controllato e arresto. Annotare dimensioni e dipendenze reali.
- [ ] F0.4 Prova rete LAN e due reti esterne: pairing, 10 MB di file, interruzione/ripresa e relay forzato. Valutare binding e manutenzione del trasporto.
- [ ] F0.5 Provare cifratura database/file/indici, secret store, recupero su nuovo dispositivo e funzionamento con schermo bloccato; scegliere librerie supportate, senza crittografia personalizzata.
- [ ] F0.6 Congelare decisioni D1–D5/D8 e la matrice di supporto; ricalibrare stime. Se le prove falliscono, ridurre portata prima di costruire UI aggiuntiva.

Gate: report riproducibile con comandi/versioni/macchine; una scelta per checkpoint e una per trasporto. Non basta una demo SDK riuscita.

### F1 — Dominio e contratti canonici

Dipendenza: D1, F0. Moduli: `domain/{work,plan,conversation,commands,events}.py`, `policy/`, `contracts/`, test unitari.

- [ ] F1.1 Definire ID, Work distinto da Conversation, Project facoltativo, PlanRevision, StepAttempt, ContributionRequest e ArtifactVersion.
- [ ] F1.2 Implementare transizioni del documento architetturale; vietare completamento senza evidenza e approvazioni su versioni obsolete.
- [ ] F1.3 Comandi con command_id, actor autenticato, expected_version; eventi con event_id, sequence, schema_version e riferimenti.
- [ ] F1.4 Versionare piani e modifiche concorrenti; impedirne la modifica retroattiva dopo esecuzione. Inserire nuovo passo senza duplicare il lavoro.
- [ ] F1.5 Testare chat senza progetto, creazione progetto da chat, più chat per lavoro e progetto, agente rinominato con ID stabile.

Gate: test tabellari di ogni transizione lecita/illecita, replay duplicati senza effetti aggiuntivi, conflitto esplicito tra due modifiche simultanee.

### F2 — Persistenza, API e collegamento UI

Dipendenza: F1. Moduli: `storage/`, `api/`, `src/features/workspace/{client,events,queries}.ts`; modifiche mirate a `ConversationWorkspace.tsx` e viste.

- [ ] F2.1 Cifratura a riposo di database, file e indici con chiavi protette; migrazioni per dominio, accesso e outbox; transazioni e indice per workspace/id/versione.
- [ ] F2.2 API letture/comandi e stream eventi con cursor; snapshot dopo disconnessione e versioni incompatibili gestite esplicitamente.
- [ ] F2.3 Spostare decisioni di stato fuori da React; adattatore demo e adattatore motore dietro lo stesso contratto, scelti esplicitamente.
- [ ] F2.4 Separare conversazione attiva, selezione UI e stato dei lavori. Non salvare identità autenticata nel selettore Vista demo.
- [ ] F2.5 Backup consistente database+manifest file e ripristino su directory pulita. Import demo facoltativo e marcato come storico simulato, mai come esecuzione reale.

Gate: UI e motore riavviati conservano lavoro e storia; evento duplicato non duplica il messaggio; nessun file reale perso. Demo precedente continua a funzionare.

### F3 — Prima chat e piano reali

Dipendenza: F2, D6. Moduli: `models/`, `planning/`, `context/`, `UsageEntry`; componenti chat e piano esistenti.

- [ ] F3.1 Provider fake deterministico per test e adattatore del primo provider reale; onboarding credenziale esplicito, secret store e verifica connessione.
- [ ] F3.2 Interpretare messaggi come risposta, chiarimento o proposta di comando. Risoluzione @ per ID, candidati ambigui nella UI condivisa, mai assegnazioni per nome indovinato.
- [ ] F3.3 Estrarre risultato atteso, criteri, input e passi; validare output del modello prima di creare bozza. Chiedere soltanto dati mancanti rilevanti.
- [ ] F3.4 Modifiche da chat e manuali producono la stessa patch versionata; anteprima leggibile per cambi di obiettivo/responsabile/effetti.
- [ ] F3.5a Integrare MemoryPort e Mem0 OSS locale per un ricordo approvato, persistenza, isolamento di due progetti, rettifica, cancellazione ed export; nessuna ricostruzione del piano tramite memoria semantica.
- [ ] F3.5 Streaming interrompibile, messaggio parziale marcato, timeout e retry limitato; tracciare tentativi e consumo senza dichiarare azioni mai eseguite.

Gate: tre casi diversi (catalogo, ricerca, analisi log) senza ramo hardcoded per settore; piano valido, obiettivo mantenuto in 10 messaggi di correzione. Prove live separate dai test fake.

### F4 — Esecuzione, input e risultati reali

Dipendenza: F3. Moduli: `runtime/`, `materials/`, `notifications/`, review; `ConversationContribution`, `ConversationWork`, piano e risultati.

- [ ] F4.1 Integrare code, checkpoint e recovery DBOS; adattatore Homun per tentativi, policy ed eventi aziendali, senza duplicare il runtime generico. Riavvio in ciascun punto critico: prima/dopo tool e prima/dopo commit.
- [ ] F4.2 Ingest file/cartelle con destinazione d'origine, hash/versione, estrazione di TXT/PDF testuale/CSV; file non supportati apribili ma non dichiarati letti. OCR separato.
- [ ] F4.3 Richiesta contributo tipizzata: materiale, testo, scelta, credenziale mancante o autorizzazione; notifica porta all'azione, risposta valida sblocca lo stesso passo.
- [ ] F4.4 Generazione artifact reali, controlli rispetto ai criteri, versioni e fonti. Anteprima per testo/PDF/immagine/tabella; download per altri tipi.
- [ ] F4.5 Revisione e correzione riferite a versione; risultato accettato non autorizza invio. Autonomia per ambito controllata dal backend.
- [ ] F4.6 Pausa, annullamento, errore e ripresa visibili nella chat e nelle viste compiti senza divergenze.

Gate alpha: catalogo da file reale → richiesta listino mancante → contributo → risultato apribile → modifica → nuova versione approvata; chiusura app durante attesa e durante esecuzione non perde il lavoro. Nessuna azione esterna in questa milestone.

### F5 — Collaborazione tra applicazioni e dati selettivi

Dipendenza: F4, D1–D3. Moduli: `identity/`, `peers/`, archivio file e proiezioni remote; desktop.

- [ ] F5.1 Identità del device e della persona distinte; inviti monouso, pairing confermato, ruoli e revoca.
- [ ] F5.2 Replica autorizzata di metadati/eventi per spazio/progetto, cursor e snapshot; deduplica senza ordinamento basato sull'orologio del client.
- [ ] F5.3 Cifratura end-to-end con identità verificate e chiavi per destinatari autorizzati; file su richiesta o selezionati per offline, manifest/hash e trasferimenti riprendibili. Credenziali non replicate.
- [ ] F5.4 Outbox locale delle bozze/comandi non consegnati con UI onesta; host assente blocca nuove decisioni condivise, non le fa apparire salvate sull'host.
- [ ] F5.5 Delega di un passo a peer con capacità, input minimo, budget riservato e ricevuta. Nessun retry cieco dopo perdita della risposta.
- [ ] F5.6 Gestire peer lento, revocato, versione incompatibile e autorità offline. Cache privata cancellabile, limiti delle copie già scaricate documentati.

Gate pilot rete: due Mac e reti diverse; contributo di Giulia visibile a Fabio, accesso negato a terzo peer, file ripreso dopo disconnessione, risultato di delega unico. Host del lavoro resta esplicito.

### F6 — Strumenti e prima azione aziendale

Dipendenza: F4; F5 per prove remote. Moduli: `tools/{registry,manifest,policy,receipts,adapters}/`; catalogo e settings connessioni.

- [ ] F6.1 Installazione, connessione account e ToolGrant separati; modelli vedono solo capacità utilizzabili.
- [ ] F6.2 Tool file e ricerca web con limiti; fetch protegge rete interna/metadata e rivalida redirect/DNS. Fonti restituiscono riferimenti verificabili.
- [ ] F6.3 Primo connettore Trello: lettura scheda, proposta di spostamento, autorizzazione contestuale, esecuzione e verifica dello stato remoto.
- [ ] F6.4 Adattatore MCP con negoziazione/versione e isolamento; skill versionata con dipendenze; Composio come candidato dietro lo stesso contratto, previa prova di auth/revoca/errori.
- [ ] F6.5 Email: prima lettura e bozza, poi invio con destinatari e contenuto/versione precisi; ricevuta e caso timeout dopo invio.
- [ ] F6.6 Disinstallazione/revoca segnala lavori dipendenti e impedisce nuove invocazioni; storico preservato.

Gate: azione su ambiente di prova reale e ricevuta verificata, input malevolo non amplia i privilegi, disconnessione non produce doppio invio. Nessun connettore dichiarato pronto solo perché appare nel catalogo.

### F7 — Automazioni persistenti

Dipendenza: F4, F6 per eventi esterni. Moduli: `automations/`, ProcedureRevision, inbox; UI automazioni esistente.

- [ ] F7.1 Convertire conversazione in metodo versionato senza copiare risultati o approvazioni nei nuovi run.
- [ ] F7.2 Interpretare frequenza/regola in schema validato e riepilogo prima di attivare; timezone e DST espliciti.
- [ ] F7.3 Scheduler persistente sull'autorità, misfire policy, deduplica e niente sovrapposizioni per default.
- [ ] F7.4 Trigger esterno da connettore, firma/cursor/id evento; polling quando inbound non disponibile. Webhook richiede nodo raggiungibile.
- [ ] F7.5 Modifica/pausa/eliminazione con effetto definito su run già partiti; notifiche solo per risultato rilevante/errore/contributo.

Gate: riavvio nel minuto di scadenza non duplica la run; cambio ora e nodo spento hanno esito previsto; evento ripetuto una sola esecuzione.

### F8 — Memoria e formazione

Dipendenza: F4 e policy F5. Moduli: `context/`, `memory/`, UI gestione conoscenze nelle impostazioni/progetto/agente.

- [ ] F8.1 Budget di contesto, obiettivo stabile e riassunti con provenienza; più chat del progetto non concatenano tutte le trascrizioni.
- [ ] F8.2 Memorie per lavoro/progetto/agente/spazio con accessi; ricerca testuale e promozione esplicita di decisioni condivise.
- [ ] F8.3 Correzione → proposta di lezione → approvazione/revoca → nuova prova; ambito cliente/progetto preservato.
- [ ] F8.4 Eliminazione/revoca fonte invalida indici e cache; evidenziare le memorie derivate da rivedere.
- [ ] F8.5 Retrieval semantico soltanto se migliora dataset misurato; embedding soggetti alla policy dati locale/remoto.

Gate: due progetti con informazioni contraddittorie restano separati; una correzione migliora casi analoghi senza propagarsi ad altri clienti; nessuna autopromozione di autonomia.

### F9 — Modelli, costi e settings definitivi

Dipendenza: F3/F6. Moduli: routing, budget ledger, configurazione e componenti settings già esistenti.

- [ ] F9.1 Secondo adattatore locale, rilevamento capacità/hardware e prova guidata. Modalità solo-locale anche per riassunti ed embedding.
- [ ] F9.2 Ledger per tentativo/step/agente; riserve atomiche e rilascio, tariffa versionata, usage ignoto distinto da zero.
- [ ] F9.3 Settings separati: personali; spazio/policy; dispositivo/storage; modelli/segreti; rete; notifiche; dati/backup.
- [ ] F9.4 Connessione diagnostica senza mostrare segreti; rotazione credenziali, esportazione redatta e ripristino verificato.
- [ ] F9.5 Routing automatico soltanto dopo confronto qualità/costo/latenza; fallback cloud sempre conforme alla policy.

Gate: due run concorrenti non prenotano oltre il limite; costo dei sottolavori non duplicato; revoca chiave applicata; preferenza UI non altera i permessi.

### F10 — Release, qualità e operatività

Dipendenza: F5–F9. Moduli: packaging, aggiornamenti, diagnostica, E2E e documentazione.

- [ ] F10.1 Installer Mac, dipendenze private, prima configurazione, aggiornamenti con migrazione e ripristino documentato.
- [ ] F10.2 Test 100 file/50 progetti/100 chat e dataset maggiore di stress; ricerca paginata, filtri reali, drag/drop, menu e selettori coerenti.
- [ ] F10.3 Test accessibilità tastiera, focus overlay, nomi lunghi e schermo piccolo; percorsi chat/compiti/materiali sempre equivalenti.
- [ ] F10.4 Tracce per work/run/tool con dati sensibili redatti; health check, coda bloccata, errori di storage e avvisi azionabili.
- [ ] F10.5 Prova completa su macchina pulita, riavvio, aggiornamento, backup e ripristino in nuova directory; pilot con 2–5 utenti.
- [ ] F10.6 Inventario licenze, perimetro supportato, manuale onboarding e registro limitazioni; nessun dato demo nel workspace reale.

Gate beta: criteri di sezione 6 soddisfatti, problemi bloccanti chiusi, limiti residuali pubblicati e accettati per il pilot.

### F11 — Estensioni deliberate

Fuori dalla prima beta: failover automatico e consenso distribuito; collaborazione offline concorrente avanzata; gruppi; marketplace commerciale; Windows/Linux; insegnamento tramite desktop; WhatsApp/telefonia; fine-tuning. Ogni estensione ha una specifica propria. L'esclusione dal primo rilascio non elimina questi obiettivi dalla visione.

## 5. Contratti minimi per il primo ciclo

Da formalizzare in OpenAPI/JSON Schema F1, con un'unica generazione dei tipi frontend:

| Operazione | Dati necessari | Esito |
|---|---|---|
| Invia messaggio | conversation_id, testo, riferimenti, command_id | message_id + proposta o risposta; nessun avvio implicito fuori policy |
| Accetta/modifica piano | work_id, expected_version, patch o revision_id | nuova revisione o conflitto |
| Avvia/sospendi/annulla | work_id, revision_id, command_id | stato persistito e run_id |
| Fornisci contributo | request_id, version, text/material_ids/choice | accettato oppure spiegazione del dato ancora mancante |
| Revisiona risultato | artifact_version_id, decisione, commento | review_id e transizione consentita |
| Autorizza azione | approval_id, action_hash | concessione puntuale o rifiuto, non modifica globale dei permessi |
| Iscrivi eventi | workspace_id, cursor | eventi autorizzati, sequenza e cursor riprendibile |
| Delega al nodo | assignment_id, step_attempt_id, policy scope, input manifest | accettazione distinta da risultato finale |

Actor e workspace autorizzato provengono dalla sessione verificata: non fidarsi dei campi dichiarati dal client. Codici di errore distinti: conflict, permission_denied, input_missing, provider_unavailable, budget_exceeded, execution_unknown.

## 6. Matrice di accettazione

| Caso | Evidenza richiesta | Fase |
|---|---|---|
| Conversazione senza progetto | Creazione, piano e consegna reali senza project_id | F1–F4 |
| Nuovo progetto da chat | Stessi ID, messaggi e file, più chat separate | F2 |
| Catalogo multipersona | Materiale mancante, Vera verifica, Marta produce, Fabio approva | F4/F5 |
| Cambia piano in corso | Nuova revisione, storico integro, niente doppia esecuzione | F4 |
| Risultato non testuale | Artifact apribile, versione e download corretti | F4 |
| Crash in ogni punto critico | Ripresa o esito incerto esplicito, mai successo inventato | F4/F6 |
| Revoca permessi durante attesa | Ripresa negata, dati non esposti | F5 |
| Due modifiche simultanee | Conflitto gestito senza perdita silenziosa | F1/F5 |
| Due nodi e rete interrotta | Messaggio/file ripreso una volta, stato di consegna chiaro | F5 |
| Prompt injection in file/tool | Nessuna espansione di tool, accesso o autorizzazione | F4/F6 |
| Timeout invio esterno | Riconciliazione; nessun retry cieco | F6 |
| Automazione a ora legale | Occorrenza corretta e deduplicata | F7 |
| Memoria tra progetti | Isolamento anche in ricerca e riassunti | F8 |
| Modalità locale | Nessun invio remoto inclusi servizi ausiliari | F9 |
| Budget concorrente | Riserva controllata e rendiconto senza doppi conteggi | F9 |
| Backup/ripristino | File, stato e riferimenti ricostruiti su installazione pulita | F10 |

Proposta di soglie pilot: 30 scenari deterministici di dominio senza fallimenti; 20 casi AI rappresentativi con almeno 90% piani strutturalmente validi e zero azioni non autorizzate osservate; 10 cicli di crash/resume per punto critico senza doppio effetto nel connettore di prova. Queste soglie sono gate iniziali, non prove di affidabilità universale. Misurare interventi umani, errori, tempo e costo oltre alla riuscita tecnica.

## 7. Pianificazione e stime

Ordine critico: F0 → F1 → F2 → F3 → F4. Dopo alpha, F5 e F6 possono essere sviluppate separatamente da persone diverse con contratti stabili; F7 dipende dal runtime, F8 dal controllo accessi, F9 dal ledger. F10 non è soltanto una verifica finale: test e packaging iniziano nelle fasi precedenti.

Non fissare date senza capacità del team, hardware target, connettori e scelta della distribuzione. Grandezze relative: F0 media; F1 media; F2 grande; F3 media; F4 grande; F5 molto grande; F6 grande per ogni connettore reale; F7 media; F8 grande; F9 media; F10 grande. Replica senza autorità unica aumenterebbe soprattutto F1/F5/F7, non solo la parte rete.

Dopo F0 stimare giornate per pacchetto con intervallo ottimistico/probabile/pessimistico, una riserva esplicita per recovery e packaging, e checkpoint settimanali sul percorso realmente dimostrato. Gli agenti di sviluppo possono aiutare; non sono una garanzia di riduzione lineare dei tempi.

## 8. Regola di consegna per ogni fase

- Contratto e criteri approvati prima della relativa implementazione.
- Test delle invarianti e dei guasti, poi integrazione UI e prova reale del percorso.
- Aggiornamento documentazione e matrice di parità.
- Evidenza distinta per unit test, integrazione, provider live e prova utente.
- Nessuna fase dichiarata completa con soli mock o screenshot quando promette esecuzioni reali.
- Nessuna riscrittura della cronologia pubblicata; preservare la versione prototipo consultabile.

**Primo passo concreto proposto:** chiudere il modello di distribuzione dati e avviare F0, non aggiungere subito chiamate AI al componente di 2.969 righe.
