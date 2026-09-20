# 02 — Agenti, esecuzioni e memoria

Stato: v0.1. Runtime agenti/esecuzioni: **Pydantic AI + DBOS adottati** (D-RUN-01). Dettagli e fonti nella [scelta framework](../architecture/2026-09-17-scelta-framework.md) e nell'[ADR F0.2](../architecture/decisions/2026-09-17-f0-2-runtime-spike.md).

## AG-01 — Profilo del collaboratore

Un agente è un'identità persistente configurabile; non coincide con un modello, processo o conversazione.

| Campo | Regola |
|---|---|
| id, workspace_id, revision | Stabili/versionati; il nome non è una chiave |
| nome, avatar, ruolo breve | Visibili in tutte le selezioni; distinguere AI da persona |
| curriculum | Responsabilità e capacità dichiarate; non prova di competenza verificata |
| specializzazioni | Etichette e descrizioni ricercabili |
| missione e istruzioni | Testo/Markdown versionato, separato dai documenti non fidati |
| stile e lingua | Preferenze di comunicazione, non autorizzazioni |
| strumenti | Riferimenti a capacità concesse e connessioni disponibili |
| modelli | Policy, capacità richieste, modello preferito e fallback consentiti |
| memoria | Ambiti consultabili e politica di proposta/salvataggio dei ricordi |
| supervisione | Responsabile e regole per competenza/ambito/azione |
| budget | Limiti o ereditarietà dallo spazio, mai numeri demo impliciti |
| stato | draft, active, paused, retired |

Creazione da chat: descrizione del bisogno → proposta profilo → salva; avanzate progressivamente visibili. Creare durante l'editing del piano restituisce agent_id allo stesso passo. Due nomi uguali ammessi solo se chiaramente distinguibili nell'interfaccia; nessuna risoluzione ambigua automatica.

## AG-02 — Versioni e ciclo di vita

Ogni modifica sostanziale produce una revisione. Run in corso conservano profilo/modello/strumenti effettivamente usati; nuove istruzioni si applicano alle nuove run o a un cambio esplicito al punto sicuro. Le restrizioni e revoche di sicurezza si applicano subito alle azioni future anche di run esistenti.

Pausa impedisce nuove assegnazioni e propone gestione dei lavori attivi. Eliminazione/ritiro richiede riassegnazione delle responsabilità pendenti; l'ID storico resta nelle ricevute. Duplicazione copia il profilo, non segreti, memorie private o autonomia concessa.

## AG-03 — Coordinamento

Il coordinatore è un agente con capacità di pianificazione/delega autorizzate. Produce una proposta strutturata; il dominio controlla assegnazioni, dipendenze, accessi e budget. Non può inventare nuovi permessi per sé o per un figlio.

**P v1:** passi seriali con dipendenze esplicite; limiti iniziali da configurare: 20 passi per piano, profondità delega 2, 50 chiamate tool per run. Sono protezioni proposte da tarare con prove, non limiti delle librerie. Superamento genera richiesta di estensione o arresto motivato. Un lavoro coordinato resta collegato alla stessa consegna.

## AG-04 — Contratto e stati

Work separato da Run: il lavoro descrive risultato atteso, una run è un tentativo operativo su revisioni precise.

Stati Work: draft → ready → running → review → completed; deviazioni waiting_input, waiting_approval, paused, failed, cancelled. La ripresa ricontrolla input, policy e versione. Il motore distingue technical_success del passo da accepted della consegna.

Step: pending, running, waiting_input, waiting_approval, succeeded, failed, cancelled, superseded. Ogni tentativo conserva input/versioni, tool/model, orari, risultati, errori, costi e ricevute. Il contatore completati è derivato.

Una modifica del piano genera nuova revisione e impact preview. Passi in corso non si riscrivono; si fermano al punto sicuro o si annullano con esito registrato. Risultati resi obsoleti restano storici e i dipendenti vengono rivalutati. Nessuna modifica dell'obiettivo come effetto silenzioso di una correzione locale.

## AG-05 — Esecuzione affidabile

DBOS è il proprietario del checkpoint (D-RUN-01 adottata); Homun conserva il dominio aziendale e associa command_id/work_id/run_id al workflow. Mutazioni aziendali atomiche con eventi/outbox; consumer idempotenti. Nessun secondo scheduler di recovery sviluppato senza necessità dimostrata.

Run durable solo se realmente avviata nel workflow previsto. Tool con I/O, registrazione dinamica di agenti/MCP, versionamento workflow e cifratura dei checkpoint sono prove obbligatorie prima dell'adozione. Registro di handler stabile; evitare codice generato dal modello per installare un agente.

Retry: letture e operazioni idempotenti con limite/backoff; scritture esterne secondo contratto del connettore. Esito incerto richiede riconciliazione. Non garantire exactly-once su API che non lo supportano. Annullamento non ritira effetti già avvenuti.

Input di file/tool trattato come dato. L'LLM può proporre comandi ma non scrivere direttamente stato, ACL o budget. Eventi UI mostrano attività/evidenze sintetiche, non richiedono catena di pensiero privata del modello.

## AG-06 — Autonomia e formazione

| Modalità proposta | Comportamento |
|---|---|
| In formazione | Metodo e risultato da verificare; letture già concesse senza conferme ripetitive |
| Con revisione | Esegue entro il perimetro, presenta consegna e trattiene gli effetti che richiedono consenso |
| Autonomo entro i limiti | Esegue e consegna sui casi concessi; segnala eccezioni e conserva ricevute |

La modalità è per competenza/ambito, non semplice interruttore universale dell'agente. Nuovo destinatario, strumento o uso dei dati può richiedere rivalutazione. Un umano autorizzato concede o revoca autonomia; successi e valutazioni AI possono proporla, non attribuirla.

Approvazione azione include attore, scadenza facoltativa, hash parametri, risorsa e versione. «OK» nella chat risolve soltanto una proposta corrente inequivoca; più proposte o parametri cambiati richiedono chiarimento.

## AG-07 — Modelli e costi

Provider e modelli registrati con ID/versione, contesto, output strutturato, strumenti e formati supportati. Policy spazio → restrizioni progetto/materiale → policy agente → selezione run; nessuna scelta può allentare il vincolo superiore. Fallback cloud disabilitato senza concessione.

Ledger per chiamata/tentativo e riserva atomica prima dell'avvio; rilascio o riconciliazione dopo. Uso sconosciuto distinto da zero; stime distinte da addebiti. Somme per lavoro/agente/spazio evitano doppio conteggio delle deleghe. Costi energetici locali, se stimati, separati da spese provider.

**P:** v1 scelta modello esplicita e fallback consentito; routing automatico solo su valutazioni riproducibili. API key custodita dal motore, mai nei messaggi/export. L'agente sul peer usa connessione locale autorizzata o chiede una capacità remota, non riceve automaticamente le chiavi del mittente.

## ME-01 — Strati di memoria

1. Conversazione originale: messaggi persistiti.
2. Memoria di lavoro: obiettivo, piano, vincoli, stato e questioni aperte; dati esatti.
3. Conoscenze: fatti, preferenze, decisioni e lezioni con provenienza.
4. Procedure: metodi e istruzioni versionati.
5. Indici: ricerca testuale/semantica, ricostruibili dalle fonti.

Il contesto della chiamata combina poche istruzioni stabili, contratto del lavoro, riassunto aggiornato e informazioni selezionate. Non concatenare tutte le chat di un progetto. Conservare riferimenti al testo originale quando il riassunto perde dettaglio.

## ME-02 — Markdown e backend sostituibile

**P:** Markdown per istruzioni/procedure/conoscenze leggibili, con metadati ID, ambito, versione e fonti. Può essere una rappresentazione esportabile dell'archivio cifrato, non obbligatoriamente una cartella in chiaro. Database per stato e autorizzazioni. Indice e backend memoria non duplicano l'autorità editoriale.

La scelta tra file+ricerca e Mem0 OSS resta D-MEM-01: sono approcci da provare sullo stesso contratto, non due sistemi autorevoli da tenere sincronizzati senza regole. Il vecchio Homun potrà implementare quel contratto senza bloccare il primo ciclo funzionante. Le precedenti raccomandazioni a favore di Mem0 sono candidate, non decisione definitiva.

MemoryPort proposto: propose, approve, recall, revise, forget, export. Nessuna API del framework è presunta uguale a questo contratto. Record: id, scope, text, kind, sources/versioni, autore, stato, validità temporale, supersedes, revisione e access grants. Backend IDs mappati internamente.

## ME-03 — Scrittura e accesso

Ambiti: personale, conversazione, lavoro, progetto, agente, spazio. Essere «memoria dell'agente» non autorizza esposizione a tutti i suoi interlocutori. Filtri/policy prima dell'estrazione e della ricerca, controllo finale prima dell'inclusione nel prompt.

Una correzione può produrre proposta di lezione. V1: regole aziendali confermate dall'utente; inferenze marcate come tali. Nessuna promozione di una nota cliente a regola globale senza scelta esplicita. Contraddizioni mostrate con fonti/date; fonti revocate invalidano recuperi e derivazioni secondo policy.

Cancellazione: tombstone nel registro, rimozione indice/cache, propagazione ai peer quando tornano online. Backup con retention distinta e dichiarata. Non promettere cancellazione istantanea di copie offline o esportate.

## ME-04 — Prova della memoria

Ricordare dopo riavvio; separare due clienti; applicare una correzione; dichiarare fonte; non recuperare un dato revocato; gestire due fatti di periodi diversi; esportare/reimportare; nessun traffico remoto in modalità locale. Misurare anche informazioni sbagliate introdotte, latenza e costo: il solo numero di ricordi recuperati non basta.
