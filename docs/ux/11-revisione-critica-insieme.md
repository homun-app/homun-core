# Revisione critica dell’insieme — 16 settembre 2026

## Verdetto

Il prototipo rappresenta molte funzionalità, ma non è ancora una UX definitiva.
La lacuna principale è la continuità del lavoro fra conversazione, compito, materiale,
richiesta a un collega ed esecuzione di una procedura. Aggiungere altri pannelli prima
di risolverla aumenta il carico cognitivo.

Questa revisione distingue osservazioni nel browser, riscontri nel codice e proposte.
Non certifica un motore, invii, autorizzazioni reali o una sessione multiutente.
I precedenti test tecnici restano utili, ma non dimostrano coerenza del prodotto.

## Percorsi esaminati ed evidenze

### 1. Concordare un lavoro con Elio e ritrovarne la discussione — interrotto

**Riprodotto nel browser:** aperto il messaggio di Elio con riferimento
“Preparare il piano di lavoro”; nel compito il messaggio non compare.
Aggiunta la nota “AUDIT: priorità concordata con Giulia” al compito; riaprendo
“Parla con Elio” la nota non compare nella chat filtrata.

**Codice:** StudioWorkbench conserva conversationMessages per interlocutore;
StudioSchedule conserva task.notes separatamente. Manca anche un autore strutturato
nelle note dell’incarico. StudioConversation presenta tutti i messaggi come Fabio.

**Impatto:** l’utente deve ricordare dove ha scritto una decisione. Un filtro
per compito promette un contesto che in realtà è incompleto.

**Correzione:** conversazione condivisa del compito con partecipanti espliciti.
La chat privata resta privata; un riferimento è un collegamento, non una
condivisione. “Condividi nel compito” mostra destinatari e allegati prima di confermare.
La conversazione del compito si apre anche dalla scheda del collaboratore.
Non unire automaticamente tutte le chat riferite allo stesso progetto.

### 2. Giulia consegna il listino che serve a Marta — interrotto

**Riprodotto nel browser:** dal preventivo Rossi, “Assegna richiesta alla persona”;
aperta la richiesta a Giulia, allegato homun-ux-listino.txt, impostato Completato.
Tornando al preventivo non compare “Usa la risposta e sblocca”.

**Codice:** il comando richiede sia stato done sia result testuale non vuoto.
Lo sblocco copia solo response.result nelle note; non collega i file della richiesta.
La richiesta nasce senza scadenza. Il sollecito evita di creare un duplicato:
questa parte è corretta e va conservata.

**Impatto:** Giulia può aver consegnato esattamente il materiale richiesto e il
sistema non lo riconosce come consegna. Il responsabile deve fare da intermediario.

**Correzione:** risultato composto da testo e/o riferimenti a file/documenti.
Mostrare “Consegna ricevuta — verifica”, origine e versione; accettare la consegna
collega il materiale al passaggio e registra la decisione. La ripresa automatica
dipende da una politica esplicita; non ogni allegato deve sbloccare un lavoro.
La richiesta propone una scadenza coerente con il lavoro principale, modificabile.

### 3. Entrare in Home e capire cosa fare — ambiguo

**Osservato nel browser:** preventivo Rossi sia in “Da gestire” sia in “In corso”,
pur essendo in attesa di Giulia. “In corso 3” include due incarichi bloccati.

**Codice:** attention include qualunque blocco user:, senza distinguere Fabio
dagli altri; active include qualsiasi stato diverso da done e review.

**Impatto:** la pagina comunica attività, ma non distingue il mio intervento
dall’attesa di altri. Il conteggio “In corso” non significa davvero in esecuzione.

**Correzione:** “Richiede te” con azione e motivo; “La squadra sta lavorando”
per attività effettivamente in corso; attese con destinatario e prossima azione;
risultati recenti. Un’attesa di Giulia diventa attenzione per Fabio solo per una
ragione esplicita, per esempio scadenza superata o decisione richiesta.
Calendario e Kanban restano viste degli stessi compiti.

### 4. Controllare i log ogni 30 minuti nei giorni lavorativi — incompleto

**Osservato nel browser:** Nuova procedura > Avvio > A intervalli mostra solo
“Ogni quanti minuti”. Giorni e fascia oraria non sono combinabili qui.

**Codice:** Rule dell’incarico gestisce weekdays/from/until, mentre Procedure
separa schedule e interval senza fascia per gli intervalli.
L’evento di procedura è una descrizione libera; manca la configurazione della
sorgente effettiva. Il simulatore dell’incarico include prove di errore/riprova:
non sono assenti ovunque, ma non costituiscono una gestione unificata delle esecuzioni.

**Impatto:** lo stesso “quando” cambia capacità a seconda del punto di ingresso.
Non è definito nell’editor cosa succede se la precedente esecuzione è ancora aperta.

**Correzione:** una configurazione comune: evento/orario/intervallo, eventuali
giorni e fasce, riepilogo leggibile. Per la prima versione: politica semplice e
visibile per un’esecuzione già aperta; stato connessione e ultimo evento ricevuto
rappresentati nella demo. Distinguere definizione della procedura ed esecuzioni.

### 5. Trasformare una conversazione in incarico — perde contesto

**Riscontro nel codice:** onAssign riceve solo m.text; chatAssignment contiene
person e title. Non trasferisce allegati, progetti o riferimento al messaggio.
La conversazione umana non espone questa stessa conversione.

**Correzione:** proposta di incarico con testo, materiali e contesto ereditati,
modificabili; link di provenienza e ritorno alla conversazione. Il tipo di
destinatario non deve cambiare la struttura del lavoro.

### 6. Approvare e proseguire in squadra — responsabilità incompleta

**Riscontro nel codice:** ProcedureStep ha approval booleano; AssignedWork
ha un responsabile, ma non un approvatore o partecipanti strutturati.
Le dipendenze sequenziali esistono e vengono riconciliate: non vanno ricostruite.
Il passaggio successivo ha un link al precedente, ma manca una consegna condivisa
strutturata con materiali e versione.

**Correzione:** responsabile, eventuali partecipanti e “approva: persona/ruolo”
con valore predefinito chiaro. L’agente può proporre un risultato; l’approvazione
deve riferirsi a quella versione. Rendere visibile chi deve agire dopo.

### 7. File riservato usato in chat, compito e progetto — contratto incompleto

**Riscontro nel codice:** SharedDocument ha identità, versioni e accessi, mentre
chat e incarichi conservano File[] locali indipendenti. Collegare un documento
non estende gli accessi, ma gli allegati non seguono ancora lo stesso modello.
Non è stata simulata una sessione autenticata come cliente.

**Correzione:** un materiale con identità e versione, visibile in più contesti
tramite riferimenti. Distinguere appartenenza ai progetti e persone autorizzate.
Prima della condivisione mostrare chi otterrà accesso. “File allegato” e
“salvato nella raccolta” devono essere distinguibili e collegati, non copie mute.

### 8. Gestire molti lavori e tornare indietro — incoerenza di scala

**Riscontro nel codice:** i documenti hanno selettori ricercabili multipli,
ma incarichi, filtri Kanban e procedure conservano select native.
openTask imposta sempre view=kanban: il dettaglio perde il contesto di navigazione
da cui è stato aperto (chat/progetto/Home).

**Correzione:** stesso selettore ricercabile nei punti affollati e dettaglio del
compito sovrapposto alla vista di origine. Chiudi/indietro deve riportare a filtri,
posizione e contesto precedenti. Non richiede aggiungere una nuova sezione.

## Struttura proposta

- Collaboratore: identità, responsabilità, strumenti, autonomia, memoria e costi.
- Compito: risultato atteso, responsabile, scadenza opzionale, stato, partecipanti,
  conversazione condivisa, materiali, decisioni e cronologia.
- Progetto: contenitore opzionale di compiti, partecipanti e materiali.
- Procedura: metodo riutilizzabile, avvio e passaggi; ogni esecuzione genera
  lavoro tracciabile, con provenienza e consegne.
- Materiale: identità unica, versioni e accessi; chat e compiti lo referenziano.
- Chat privata: conversazione libera; può proporre compiti e condividere
  esplicitamente singoli messaggi. Un semplice collegamento resta privato.

Questa struttura non impone di creare progetti o procedure per ogni richiesta.
Un agente deve poter rispondere a una domanda senza generare un compito.
Quando la richiesta implica lavoro continuativo/delegato, mostra una proposta
di incarico con cosa farà, materiali, autonomia e risultato atteso.

### Alternative considerate

1. Tutto nella chat: avvio facile, ma responsabilità, scadenze e passaggi diventano
   difficili da ritrovare. Non sufficiente per la squadra descritta dall’utente.
2. Tutto obbligatoriamente un compito: tracciabile, ma appesantisce domande e
   interazioni rapide. Troppo vincolante.
3. Conversazione libera + compiti espliciti per il lavoro, con collegamenti e
   condivisione controllata: raccomandata. Richiede chiarire bene il passaggio
   da “ne parliamo” a “lo esegui”, senza duplicare l’informazione.

## Piano di correzione, nell’ordine

1. Unificare contesto e consegne: conversazione del compito, privato/condiviso,
   file referenziati, conversione in incarico senza perdita dei materiali.
2. Completare il passaggio fra collaboratori: richiesta, scadenza, consegna,
   verifica, sblocco e aggiornamento visibile nel compito principale.
3. Riallineare Home e navigazione: chi deve agire e perché; ritorno alla vista
   precedente; selettori coerenti.
4. Unificare avvii e approvazioni: procedura/esecuzione, finestre temporali,
   destinatario dell’approvazione e gestione di esecuzioni già aperte.
5. Rivalutare onboarding e pannelli avanzati su questi percorsi, senza ampliare
   il menu finché i flussi centrali non sono completi.

## Criteri di accettazione della prossima baseline

- Da un messaggio con file creo un incarico senza ricaricare i file; ritrovo l’origine.
- Una nota condivisa è la stessa da tutti i punti di ingresso autorizzati.
- Una chat privata collegata al progetto non appare agli altri automaticamente.
- Giulia consegna un file; Marta trova la versione accettata e il lavoro può proseguire.
- La Home distingue chiaramente la mia approvazione dall’attesa di un collega.
- Una revisione del risultato rende esplicito cosa deve essere approvato di nuovo.
- Posso descrivere “ogni 30 minuti, lun–ven, 9–18” nello stesso modo ovunque.
- Con due eventi ravvicinati è visibile quale esecuzione parte o resta in attesa.
- Riaprendo il dettaglio da chat o progetto posso tornare al contesto precedente.
- Un lettore limitato vede solo materiali e conversazioni condivisi con lui:
  verificare con anteprima di ruolo nella UX; enforcement demandato al motore.

## Da definire prima del motore, senza appesantire la Home

Gerarchia budget spazio/agente/compito, costi della delega senza doppio conteggio,
limite raggiunto e autorizzazione al modello remoto; memoria del collaboratore
distinta dai file del progetto; stato reale delle connessioni e recupero credenziali.
Sono contratti di prodotto ancora da completare, non ragioni per introdurre ora
una dashboard tecnica.

Rinviabili: editor a nodi, rami paralleli avanzati, registrazione desktop,
telefonia, analisi economiche sofisticate. Non rinviabili: chi agisce, cosa
consegna, dove si trova il risultato e chi può leggerlo.

## Portata della verifica

Navigazione e modifiche solo nella sessione locale di test: chat/compito, Home,
richiesta a Giulia con allegato e completamento, editor avvio della procedura.
Gli altri rilievi sono esplicitamente basati sul codice, non su simulazioni
multiutente o esecuzioni reali. Nessun cambiamento applicativo in questa revisione.

## Intervento successivo — 16 settembre 2026

Implementato nel prototipo:
- Discussione condivisa del compito, accessibile anche dalla scheda del collaboratore.
  Le chat private restano separate; condivisione esplicita con anteprima dei destinatari.
- Conversione messaggio/incarico per persone e agenti con file e riferimento alla
  conversazione di origine. Corretto un difetto di lettura tardiva del file input.
- Distinzione materiali/consegna; risultati solo file ammessi. Le richieste
  ereditano la scadenza e includono il responsabile del lavoro principale.
- Accettazione della consegna con file conservati per riferimento, provenienza e
  completamento del passaggio. Una consegna riaperta riblocca il lavoro dipendente.
- Home separa interventi personali, lavoro attivo, attese e compiti da iniziare;
  le approvazioni indicano il destinatario.
- Dettaglio in sovrapposizione alla vista corrente: la pagina di origine rimane
  montata. Corretto il cambio di compito nel pannello senza rimontarlo.
- Selettori con ricerca per assegnazione, filtri di calendario/Kanban,
  progetto e responsabili della procedura.
- Intervalli delle procedure con giorni e fascia; approvatore per passaggio;
  spiegazione della politica che impedisce prove sovrapposte.

Verifiche effettive: 58 test di dominio superati, TypeScript, lint dei file modificati
e build del prototipo. Browser: richiesta e consegna di file con approvazione,
accettazione e riapertura; conversione di messaggio con allegato; condivisione
esplicita; ritorno a Home/persona/procedura; procedura a intervalli, selezione
responsabile e approvatore, rifiuto di seconda prova aperta. Ispezione screenshot
mobile del pannello e desktop della configurazione.

Ancora aperti: identità/versioni comuni tra allegati e raccolta documenti;
anteprima dei ruoli e controllo accessi reale; sorgenti evento strutturate;
gestione unificata di memoria, connessioni e budget. Il passaggio di materiale
nelle procedure sequenziali mantiene ancora il riferimento al predecessore,
non un sistema completo di consegne versionate. Nessuna pianificazione o invio reale.
