# 01 — Prodotto, flussi e dati

Stato: specifica v0.1 da analizzare. [Indice e legenda](README.md).

## PR-01 — Esperienza principale

**C.** Si comincia con una conversazione. Una domanda può restare una domanda; una richiesta operativa può generare un lavoro. Non chiedere ogni volta «messaggio o obiettivo»: interpretare e mostrare la proposta concreta quando cambia il lavoro.

La chat contiene messaggi, riferimenti, proposte di piano, richieste di contributo, risultati e azioni pertinenti. Il pannello destro mostra piano corrente, responsabili, avanzamento e prossima azione; è richiudibile e si riapre selezionando un oggetto che richiede dettaglio. Le azioni organizzative secondarie stanno nel menu della conversazione.

@ apre il selettore coerente di collaboratori/progetti/materiali con avatar, tipo, ruolo e descrizione. I riferimenti inseriti conservano ID, non soltanto testo. Un nome ambiguo richiede scelta; un agente inesistente può essere creato contestualmente senza perdere il messaggio.

## PR-02 — Conversazioni e progetti

Una conversazione può avere project_id nullo e zero o più lavori collegati. Un lavoro ha una conversazione principale e può essere discusso in altre conversazioni autorizzate. Un progetto contiene più conversazioni, lavori, materiali e conoscenze condivise.

Creare un progetto da una chat conserva chat e lavori; spostare una chat cambia l'associazione organizzativa. **P:** spostare non amplia automaticamente i permessi sui materiali o sulle conoscenze. Prima dello spostamento il motore calcola incompatibilità d'accesso e la UI mostra ciò che rimarrà non disponibile; solo chi può concedere accesso può correggerlo.

Rinomina, archivio/ripristino ed eliminazione sono disponibili dal menu. L'archivio non equivale a completamento. Un lavoro attivo deve essere sospeso/annullato esplicitamente prima di archiviare ciò che lo nasconderebbe. Eliminare una chat conserva i file nella raccolta e lo storico minimo del lavoro secondo retention; eliminazione definitiva dei dati ha un flusso distinto.

## PR-03 — Affidamento del lavoro

Il contratto conserva richiesta originale, obiettivo corrente, risultato atteso, criteri di accettazione, vincoli, fonti, responsabile, supervisore/revisore, scadenza e budget se presenti. Non tutti diventano campi da compilare: il motore ricava il possibile e chiede ciò che manca.

Il piano contiene passi con output verificabile e responsabile. L'utente può modificare tramite chat o UI, aggiungere una traduzione o un agente intermedio, riordinare e rimuovere passi non eseguiti. Il motore valida dipendenze, disponibilità degli strumenti e impatto sui risultati precedenti.

**P:** proposta di piano prima del primo avvio; lavori coperti da procedura e autonomia già concesse possono partire entro quel perimetro. Riletture e operazioni autorizzate non provocano conferme ripetitive.

## PR-04 — Contributi e attese

Una richiesta deve dire: cosa serve, perché, chi deve fornirlo e come farlo. Tipi: testo, file/cartella, link/riferimento, scelta, autorizzazione o collegamento account.

Chat, notifica e Compiti aprono la **stessa richiesta**, con azione immediata: allega, scrivi, scegli o collega. Non far cercare un caricamento in una pagina diversa. Un contributo ricevuto è distinto da un contributo valido: se insufficiente, spiegare esattamente cosa manca.

Cambio destinatario ammesso a chi gestisce il lavoro; conservare storico. La riassegnazione non trasferisce più dati di quelli consentiti al nuovo destinatario. Una scadenza superata genera attenzione, non risposta inventata.

## PR-05 — Risultati, revisione e azioni

Una consegna può avere più artifact versionati: documento, immagine, tabella, codice, ricerca o ricevuta di un'azione. Mostrare titolo, contenuto/anteprima, fonti, controlli e incertezze; dettagli tecnici espandibili.

Azioni: approva, chiedi modifica, segnala problema, apri/scarica; azioni specifiche dipendono da capacità e oggetto sorgente. «Sposta scheda» richiede connessione e permesso per quella scheda. Non visualizzare un'azione eseguibile solo perché il modello la suggerisce.

L'approvazione riguarda una versione precisa. Modificare il risultato invalida l'approvazione per la nuova versione. Accettare una bozza non autorizza a inviarla. Un esito sconosciuto di invio resta da riconciliare, non «fallito, riprova» senza verifica.

## PR-06 — Materiali

File/cartelle trascinabili, caricamento selettivo, note, ricerca e filtri per tipo/data/progetto/collaboratore/accesso. Selezione multipla e rimozione; anteprime/fallback per formati non supportati. Nomi lunghi senza overflow.

Caricamento da chat: collegamento automatico a quella conversazione/lavoro; raccolta globale come ulteriore vista. Dal catalogo materiali si può condividere altrove con una scelta esplicita. Cartella importata e cartella sincronizzata sono capacità distinte: **P v1: importazione**, non promessa di sincronizzazione continua.

Oggetto/versione con hash, tipo, dimensione, nodo custode, fonte e permessi. Originale separato da testo estratto, miniature e indice. Eliminazione segnala dipendenze e invalida copie gestite/indici secondo policy; non promette cancellazione da dispositivi ostili.

## PR-07 — Squadra e plugin

Persone con identità e membership; agenti con profilo eseguibile. Team riutilizzabili tra progetti, con coordinatore facoltativo. Selettore unico ricco di identità in tutti i flussi. Invitare una persona non equivale a creare un agente.

Catalogo plugin unico con ricerca/categorie/origine. Separare installazione, account connesso e concessione d'uso all'agente. MCP, skill, Composio e plugin propri condividono la UX ma usano adattatori distinti. Rimozione mostra dipendenze e blocca nuove chiamate senza cancellare ricevute pregresse.

## PR-08 — Automazioni

Creare da chat o lavoro. La regola naturale diventa un trigger strutturato con riepilogo: quando, timezone, ambito, procedura, responsabili e destinazione risultati. Attivazione solo se supportata e connessioni valide.

Una nuova run non eredita esiti/approvazioni delle precedenti. Modifica produce nuova versione; run avviate conservano versione originaria salvo intervento esplicito. Pausa ferma nuove occorrenze, non annulla automaticamente quelle attive.

**P:** serializzare run della stessa routine; dopo indisponibilità accorpare in una sola run di recupero segnalata, modificabile in «salta». Computer spento significa nessuna esecuzione su quel nodo. Eventi webhook richiedono raggiungibilità; polling alternativo dove consentito.

## PR-09 — Ricerca, compiti e notifiche

Ricerca globale su oggetti autorizzati, filtri e navigazione diretta al risultato. Indicazione fonte/progetto e tipo; niente titoli/snippet di dati non accessibili. Ricerca testuale iniziale; semantica sostituibile e misurata.

Compiti: elenco/Kanban/calendario sullo stesso stato canonico. Trascinare tra stati non può aggirare una verifica o approvazione obbligatoria. Date UTC conservate con timezone dell'evento; UI localizzata.

Notifiche persistenti per destinatario: contributo, revisione, blocco, esito. Letto/non letto distinto da risolto; deduplica sull'evento. Non mostrare contenuto sensibile nelle notifiche OS per default. Silenziare interrompe gli avvisi, non nasconde le richieste nell'inbox.

## PR-10 — Oggetti canonici

Workspace, Membership, Person, Device, AgentProfileRevision, Team, Project, Conversation, Message, Work, WorkConversation, PlanRevision, Step, Run, StepAttempt, ContributionRequest, ArtifactVersion, Review, ActionApproval, MaterialVersion, AccessGrant, ProcedureRevision, Automation, PluginInstallation, Connection, ToolGrant, MemoryRecord, UsageEntry, BudgetReservation, DomainEvent, Notification.

ID opachi e stabili; workspace su ogni entità condivisa; created_at/updated_at UTC; revisione per concorrenza; soft deletion dove serve retention. Credenziali mai incorporate negli oggetti esportabili. Trascrizione e file sono fonti; ricordi e indici sono derivati con provenienza.

## PR-11 — Percorsi minimi

1. Catalogo: Fabio affida, Vera verifica prezzi, Marta prepara, traduttore aggiunto in corsa, Fabio approva.
2. Ricerca: brief senza file, fonti web, confronto e consegna con citazioni.
3. Trello: evento su scheda, analisi, proposta di spostamento, autorizzazione e ricevuta.
4. Richiesta umana: Giulia riceve notifica su altra app, allega il materiale, lavoro riprende.
5. Memoria: correzione circoscritta a cliente ricordata in altra chat dello stesso ambito, assente altrove.
6. Guasto: chiusura o disconnessione durante lavoro, stato recuperato senza doppio effetto.
