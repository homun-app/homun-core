# Motore Homun: affidabilità, formazione e verifica
Data: 16 settembre 2026.
Stato: indirizzi di prodotto raccolti con Fabio; requisiti e proposte per il futuro motore.
Non descrive capacità già implementate e non sceglie runtime, modelli o framework.

## 1. Obiettivo da preservare

Homun deve facilitare l’adozione dell’AI nelle piccole aziende: spazio multiutente
installabile in locale, squadra mista di persone e agenti, delega di attività e
controllo dei costi. Compiti, chat, documenti e pipeline sostengono questo obiettivo.
Non basta che un agente esegua molti passaggi: deve ottenere il risultato richiesto
e renderlo verificabile senza costringere l’utente a coordinare ogni operazione.

Il caso osservato durante la progettazione è un requisito: un agente può seguire
richieste successive perdendo l’obiettivo iniziale. Il motore deve conservare
obiettivo, vincoli e criteri di riuscita e confrontarli con piano e risultati.
Una proposta di cambiamento dell’obiettivo va resa esplicita; non deve essere una
conseguenza silenziosa dei passi intermedi.

## 2. Indirizzi espressamente richiesti

- Agenti affidabili e controllabili, inseriti nei sistemi aziendali attraverso
  strumenti, MCP e plugin; capaci di comporre pipeline, non soltanto eseguire
  sequenze configurate manualmente dall’utente.
- Formazione iniziale supervisionata, paragonabile a un periodo di stage.
- Possibilità di verificare il lavoro, confermare ciò che è corretto e correggere
  ciò che non lo è; queste esperienze devono essere riutilizzabili.
- Autonomia differenziata per attività: uno stesso agente può lavorare da solo
  su alcuni compiti e restare in formazione su altri.
- Verifica semplice: mostrare cosa è stato fatto e permettere di aprire il risultato.
- Risultati eterogenei: codice, immagini, ricerche, relazioni, documenti e altri
  formati. La struttura non deve dipendere dall’esempio del preventivo.
- L’autonomia deve convivere con limiti di accesso, budget e responsabilità umane.

## 3. Proposta: formazione per competenza e ambito

Lo “stage” non è un unico interruttore per tutto l’agente.
L’unità da valutare è una competenza in un contesto: attività, strumenti, dati
accessibili, destinatari e limiti. Preparare una bozza, modificarla in un sistema
condiviso e inviarla all’esterno sono autorizzazioni diverse.

Esempio illustrativo per lo stesso collaboratore:
- ricercare nei documenti autorizzati: autonomo;
- preparare un preventivo: risultato da verificare;
- modificare prezzi nel gestionale: operazione da autorizzare;
- inviare al cliente: conferma sempre richiesta.

Livelli proposti, da validare nella UX:
1. **In formazione:** propone il metodo e prepara una prova; le operazioni con
   effetti aziendali richiedono il controllo previsto. Le letture già autorizzate
   non devono generare una conferma per ogni click.
2. **Con revisione:** lavora entro un perimetro approvato e presenta la consegna
   prima della pubblicazione o di un’altra azione soggetta ad approvazione.
3. **Autonomo entro i limiti:** procede sui casi autorizzati e segnala eccezioni;
   risultato, attività e costo restano consultabili.

Un supervisore autorizzato decide il passaggio di livello per quella competenza.
Una serie di successi può suggerire maggiore autonomia, non attribuirla da sola.
L’utente può restringere o revocare l’autonomia. Nuovi strumenti, fonti, destinatari
o cambiamenti sostanziali di procedura richiedono una rivalutazione del perimetro.
L’agente può tornare a chiedere aiuto quando il caso esce da ciò che sa gestire.

## 4. Contratto del lavoro e ciclo di controllo

All’affidamento, conservare:
- richiesta originale e risultato atteso;
- criteri di accettazione, vincoli e scadenza eventuale;
- contesto e fonti autorizzate;
- responsabile, supervisore e autonomia applicabile;
- budget e azioni che richiedono conferma.

Il motore costruisce o recupera un piano adeguato, usa i collegamenti disponibili,
verifica i risultati intermedi e modifica il metodo quando necessario.
Cartelle, messaggi, gestionali e persone sono possibili fonti; nessuna fonte deve
essere obbligatoria per costruzione.

Prima di dichiarare completato il lavoro, confronta la consegna con i criteri.
Se il risultato non è verificabile, manca una fonte o il costo previsto supera
il limite, espone l’eccezione e la decisione necessaria.

Distinguere:
- proposta di azione;
- azione autorizzata;
- azione eseguita;
- esito verificato;
- risultato accettato.

Un OK su una bozza non equivale a un’autorizzazione a inviarla.
Il completamento tecnico di un comando non dimostra il raggiungimento dell’obiettivo.
Un agente supervisore può aiutare nella verifica, ma non crea da sé garanzie
di correttezza né sostituisce autorizzazioni umane richieste.

## 5. Apprendimento dal feedback

“Impara” è un comportamento di prodotto da progettare e misurare, non una promessa
che il modello aggiorni automaticamente i propri pesi.

Per ogni esperienza utile, la proposta è registrare:
- obiettivo e contesto, con provenienza e confini di accesso;
- procedura/versione, strumenti e modello impiegati;
- risultato e versione effettivamente valutati;
- controlli eseguiti ed evidenze;
- esito della revisione, autore, data, correzione e motivazione;
- costo e interventi richiesti.

Possibili riusi: esempi approvati, istruzioni circoscritte, checklist, memoria di
lavoro e nuove versioni di procedure. Fine-tuning e scelta dei meccanismi sono aperti.

Il feedback va distinto in:
- errore su questo caso;
- preferenza personale o del cliente;
- regola aziendale da riutilizzare.

L’interfaccia può suggerire una lezione sintetica, ad esempio:
“Per questo cliente usa il listino concordato, non quello generale”.
L’ambito deve essere visibile e correggibile. Non generalizzare una correzione
locale a tutti i clienti o condividere informazioni riservate fra progetti.

Le lezioni devono poter essere consultate, modificate, disattivate e versionate.
Feedback contraddittori richiedono una risoluzione esplicita. Un’approvazione
accidentale deve poter essere revocata. Le nuove procedure vanno provate su casi
rappresentativi prima di trattarle come affidabili.

## 6. Verifica semplice di risultati diversi

Un unico punto di revisione, con anteprime specializzate per formato.

Presentazione principale proposta:
1. cosa era stato richiesto;
2. risultato da aprire, con autore/agente e versione;
3. sintesi delle modifiche o del lavoro svolto;
4. verifiche effettuate, incertezze ed eventuali decisioni;
5. costo del lavoro, distinguendo stima e consuntivo disponibile.

Azioni essenziali: **Approva**, **Chiedi una modifica**, **Segnala un problema**.
Il feedback deve poter riferirsi al risultato intero o a una parte precisa.
I dettagli tecnici e la cronologia completa restano espandibili.

| Risultato | Vista utile |
| --- | --- |
| Documento o relazione | Anteprima leggibile, confronto versioni, commenti |
| Codice | File modificati, diff e risultati dei controlli |
| Immagine | Anteprima, confronto, annotazione su un’area |
| Ricerca | Sintesi, fonti apribili, distinzione fatti/ipotesi |
| Foglio o dati strutturati | Tabella, variazioni e controlli sui dati |
| Azione su un’applicazione | Prima/dopo, oggetti modificati e ricevuta dell’operazione |
| Formato non supportato | Metadati, download o apertura nell’app compatibile |

La struttura può ospitare qualsiasi file; non si promette un’anteprima nativa di
qualsiasi formato. Il fallback deve essere onesto e utilizzabile.
Una consegna può contenere più file e tipi di risultato, non un unico campo testo.
I contenuti ricevuti non vanno eseguiti automaticamente per mostrarli.

L’approvazione si riferisce a una versione precisa. Se quella versione cambia,
l’approvazione precedente resta nello storico ma non certifica la nuova.
I passaggi dipendenti devono sapere quale versione hanno usato e se è da riverificare.

## 7. Controllo, permessi, costi e funzionamento locale

Le politiche devono essere applicate dal motore prima delle azioni, non soltanto
descritte nel prompt. La delega a un altro agente non amplia permessi o budget.

Chi può supervisionare, approvare e concedere autonomia deve essere distinto
da chi può soltanto leggere il risultato. Una conferma deve mostrare l’effetto
dell’azione e il suo ambito.

Registrare il costo di esecuzione e supervisione senza contare due volte le deleghe.
Modelli locali non significano costo operativo nullo. Le stime devono essere
distinte dagli importi misurati e dagli elementi non misurati.

Decisioni ancora necessarie: dove esegue lo spazio multiutente, cosa accade con
host spento/offline, disponibilità delle fonti e gestione di attività sospese.
Una richiesta di approvazione deve poter attendere senza perdere piano o stato.
La UX deve distinguere attesa di una persona, attesa di un sistema e lavoro in corso.

## 8. Casi di accettazione del futuro motore

- Lo stesso agente esegue una ricerca autorizzata e chiede conferma per un invio.
- Un’approvazione del risultato non modifica il suo livello di autonomia.
- Una correzione per un cliente non si applica automaticamente agli altri.
- Un materiale cambiato rende visibile la necessità di riverificare la consegna.
- Una pipeline composta dall’agente mantiene l’obiettivo e i criteri originali.
- Il supervisore apre codice, immagine e documento nello stesso flusso di revisione,
  con viste adatte e fallback per un formato sconosciuto.
- Il cambio di modello o la delega non aggira accessi, approvazioni o limiti di spesa.
- Una modifica alle politiche mentre un lavoro è sospeso viene controllata alla ripresa.
- Un’azione fallita o un risultato non verificato non viene presentato come completato.
- Una sequenza di esempi approvati migliora i risultati su nuovi casi rappresentativi:
  misurare correzioni, errori, tempo umano richiesto e costo, non soltanto esecuzioni.

## 9. Questioni aperte e prossima validazione

Da decidere: ambito iniziale delle competenze, ruoli dei supervisori, modalità di
salvataggio delle lezioni, criteri per proporre autonomia, gestione delle versioni,
formati di anteprima prioritari e protocollo per comporre/verificare pipeline.

Prima del motore completo, validare un ciclo:
affidamento → lavoro in formazione → consegna visibile → correzione →
lezione circoscritta → nuova prova → eventuale autonomia concessa esplicitamente.

Questo documento preserva la direzione. Non autorizza a implementare ora il motore
e non trasforma proposte operative in decisioni tecniche già approvate.
