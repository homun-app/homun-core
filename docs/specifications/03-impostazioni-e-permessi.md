# 03 — Impostazioni, permessi e sicurezza

Stato: v0.1 da analizzare. Default e ruoli seguenti sono **P**, salvo direzioni già confermate. [Indice](README.md).

## SE-01 — Organizzazione

Un solo accesso Impostazioni, con categorie. Campi personali separati da spazio/dispositivo; indicare «vale per te», «vale per questo spazio», «vale su questo dispositivo». Ricerca nelle impostazioni. Configurazioni dell'agente accessibili anche dal profilo, usando lo stesso componente.

Form brevi per valori precisi; chat utilizzabile per proporre modifiche. La chat presenta il cambiamento concreto prima dei casi che richiedono consenso. Per entrambe le modalità la stessa API applica autorizzazione, validazione e revisione.

## SE-02 — Catalogo impostazioni

| Categoria / campi | Ambito e modifica | Default proposto / comportamento |
|---|---|---|
| Profilo: nome, avatar, lingua, timezone | Persona | Italiano, timezone dispositivo con conferma; cambiare nome non cambia ID |
| Aspetto: tema, testo, animazioni | Persona/client | Tema sistema, testo standard, rispetto riduzione movimento |
| Navigazione: pannelli e sidebar | Client | Ultima preferenza, adattamento mobile |
| Notifiche: contributi, revisioni, risultati, suoni, orari silenziosi | Persona/dispositivo | Inbox sempre completa; avvisi contributi/revisioni attivi, risultati opzionali |
| Privacy notifiche: anteprima contenuto | Dispositivo | Contenuto sensibile nascosto su OS/schermo bloccato |
| Spazio: nome, descrizione, lingua/timezone predefinite | Proprietario/gestore | Richiesti nome e timezone per routine; dati aziendali opzionali |
| Membri: inviti, ruoli, disattivazione | Proprietario/gestore entro propria delega | Nessun accesso prima di accettazione e assegnazione |
| Team: membri e coordinatore | Gestore/creatore autorizzato | Non concede automaticamente tutte le risorse ai membri |
| Progetti: membri, materiali, default di condivisione | Gestore progetto | Privato ai partecipanti assegnati |
| Agenti: profilo, istruzioni, capacità, memoria | Gestore agente | Nuovo agente in formazione; nessuna credenziale ereditata |
| Supervisione: regole per azione/ambito, revisori | Proprietario/gestore policy | Scritture esterne soggette a concessione esplicita |
| Modelli: provider, endpoint, modelli, capacità | Gestore connessioni/dispositivo | Nessun provider attivo finché configurato e testato |
| Esecuzione: solo locale/remoto consentito, fallback | Policy spazio + restrizioni risorsa | Nuovo spazio senza trasmissione cloud fino a configurazione consapevole |
| Budget: per lavoro/agente/spazio, valuta, soglie avviso | Gestore budget | Nessun valore monetario demo applicato al prodotto; scelta esplicita prima uso a pagamento |
| Memoria: ambiti, proposte, conservazione, revisione | Policy spazio e titolare memoria | Conferma delle lezioni condivise, niente condivisione globale implicita |
| Contesto: limiti tecnici e riassunti | Avanzate gestore motore | Automatici dal modello; obiettivo/permessi mai sacrificati per compattazione |
| Plugin: catalogo, installazioni, versioni | Gestore plugin | Disabilitato finché dipendenze/connessione/permessi validi |
| Connessioni: account, test, rotazione, revoca | Titolare connessione/gestore | Segreto mai rileggibile dalla UI; mostra maschera e ultimo test |
| Materiali: posizione archivio, import, limiti caricamento | Nodo custode/gestore | Importazione; sincronizzazione cartelle non implicita |
| Condivisione: destinatari, scope, copie offline | Titolare risorsa entro policy | Solo necessario; cache offline esplicitamente consentita |
| Dispositivi: nome, pairing, sessioni, revoca | Proprietario/gestore dispositivi | Device sconosciuto non fidato |
| Rete: locale/remota, trasporto, relay, diagnostica | Gestore nodo | Tunnel disattivato prima del pairing; endpoint motore non esposto pubblicamente |
| Esecuzione nodo: capacità offerte, concorrenza, avvio automatico | Proprietario nodo | Una esecuzione agente per nodo iniziale; limiti adattati all'hardware |
| Automazioni: timezone, recupero, sovrapposizioni | Responsabile routine | Nessuna sovrapposizione; recupero accorpato dichiarato |
| Cifratura: stato archivio, dispositivi autorizzati, recupero | Proprietario nodo/spazio | Attiva prima dell'uso con dati reali; chiavi mai nella chat |
| Backup: destinazione, frequenza, retention, prova ripristino | Proprietario dati | Configurazione proposta durante onboarding; mai backup cifrato senza recupero verificabile |
| Archivio/cestino: ripristino e cancellazione definitiva | In base a risorsa e retention | Separare archiviazione, revoca e cancellazione |
| Diagnostica: log, livello, esportazione | Proprietario nodo | Log minimizzati, nessuna telemetria esterna facoltativa attiva per default |
| Aggiornamenti: versione client/motore, compatibilità | Proprietario nodo | Notifica aggiornamento; migrazione verificata prima sostituzione |
| Guida: connessioni, scorciatoie, stato servizi | Tutti | Informazioni coerenti col runtime, nessun interruttore demo nel prodotto |

## SE-03 — Regole di salvataggio

Modifiche persistenti con Save/Annulla, stato dirty e messaggio di errore vicino al campo; niente «salvato» prima dell'ACK autorevole. Preferenze puramente locali possono salvarsi automaticamente con indicazione coerente.

Campi ereditati mostrano origine e valore effettivo. Una policy più restrittiva non è sovrascrivibile da un agente o progetto. expected_version evita perdita da modifiche simultanee. Registro prima/dopo per cambi di accesso, autonomia, modelli, rete e budget.

Validazioni: nome non vuoto; timezone IANA valida; URL provider HTTPS salvo loopback locale esplicito; importi non negativi con valuta; limite lavoro non superiore al tetto disponibile; revoca dell'ultimo proprietario vietata prima del trasferimento. Un test connessione riuscito non certifica tutte le capacità del modello.

## AU-01 — Ruoli proposti

| Azione | Proprietario | Gestore delegato | Collaboratore | Ospite |
|---|---|---|---|---|
| Gestire proprietà/recupero spazio | Sì | No | No | No |
| Gestire membri e policy | Sì | Entro delega, senza auto-elevazione | No | No |
| Creare agenti/team/plugin | Sì | Sì | Solo concessione specifica | No |
| Creare lavori/progetti | Sì | Sì | Entro risorse assegnate | No per default |
| Leggere e contribuire | Entro policy dati | Entro policy dati | Risorse assegnate | Risorse esplicitamente condivise |
| Approvare risultato/azione | Solo se revisore/autorizzato | Solo se revisore/autorizzato | Solo se revisore/autorizzato | No per default |
| Condividere materiale | Entro facoltà di condivisione | Entro facoltà di condivisione | Solo proprie risorse/concessioni | No |

Il proprietario può amministrare lo spazio ma il ruolo non costituisce automaticamente una chiave per decifrare ogni file privato di un altro dispositivo. Spazi aziendali con recupero amministrativo dei dati richiedono policy esplicita D-KEY-01. Assenza di grant significa deny; revoca prevale sulle concessioni interessate.

Autenticazione della persona, fiducia del dispositivo e autorizzazione della risorsa sono verifiche distinte. Il selettore Vista demo non diventa autenticazione reale.

## AU-02 — Materiali e strumenti

Link organizzativo distinto da AccessGrant. Grant per soggetto/risorsa/capacità/ambito, eventuale scadenza e issuer; firma/validazione nella rete peer. Revoca ricontrollata alla lettura e all'esecuzione, non soltanto durante l'invito.

ToolGrant distingue lettura, modifica, invio, eliminazione e destinatari. Installare un plugin non concede questi effetti. Le approvazioni sono legate ai parametri della singola azione, salvo policy esplicita riutilizzabile.

## AU-03 — Cifratura e recupero

Requisito C: archivio locale e trasferimenti protetti. Scelta librerie D-CRYPTO-01. Copertura: database del prodotto, checkpoint runtime, file, indici, anteprime, temporanei e backup. Non basta cifrare il documento originale.

Chiavi dispositivo separate da persona e contenuti; segreti nel portachiavi/secret store. Scambio tramite protocolli esistenti, non algoritmi Homun. Recupero verificato su nuovo dispositivo; policy per esecuzione con schermo bloccato/riavvio prima delle routine non presidiate.

Limiti dichiarati: processo autorizzato vede dati in chiaro durante uso; device compromesso non protetto magicamente; revoca non cancella copie già decifrate; relay può vedere metadati; provider remoto riceve contenuto necessario all'inferenza se consentita.

## AU-04 — Onboarding

1. Crea/apri spazio locale oppure associa spazio esistente.
2. Verifica identità del dispositivo e autorizzazione ricevuta.
3. Configura archivio, protezione e recupero.
4. Configura almeno un modello, locale o remoto consapevolmente; test capacità.
5. Crea primo collaboratore e svolgi un lavoro guidato.
6. Proponi backup e, solo quando richiesto, collegamento remoto/peer.

Il percorso locale non deve richiedere account presso un backend centrale Homun. Provider e servizi esterni possono richiedere account propri.
