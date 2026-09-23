# Usare Homun oggi

23 settembre 2026 — uso diretto, squadra e contributi nel percorso motore.
Questa guida descrive l'uso supportato; le [prove](research/2026-09-23-consolidamento-verifica.md)
precisano quali passaggi sono stati verificati dal vivo e quali nei test.

## Che cosa affidargli

Puoi chiedere un risultato direttamente a Homun, senza creare un bot. Quando
serve continuità, puoi costruire una squadra e scegliere con chi lavorare.
Le capacità locali comprendono lettura e ricerca nei materiali selezionati,
sintesi testuale, consultazione dei collaboratori AI e confronto CSV. Le procedure approvate aiutano la sintesi;
server MCP dichiarati possono aggiungere strumenti entro i permessi previsti.

Un profilo agente descrive responsabilità e metodo: non concede da solo accessi
ai dati o capacità eseguibili. Un progetto raccoglie materiali e lavori;
Compiti e Documenti sono viste degli stessi lavori e risultati.

## Prima del primo lavoro

1. Avvia l'app e verifica il collegamento al motore. Per lo sviluppo seguire il
   [README](../README.md); per l'app installata non serve avviare un motore a mano.
2. In Impostazioni → Modelli verifica una connessione utilizzabile. Un modello
   configurato non garantisce qualità per ogni attività: comincia con un caso piccolo.
3. Se servono file, crea o scegli un progetto. In Materiali selezionalo e aggiungi
   i file; aprine uno per verificare che il contenuto necessario sia leggibile.
   I file non supportati non diventano leggibili solo perché sono stati caricati.

Non occorre dichiarare server MCP o costruire un team per iniziare.
Prova una richiesta utile e breve, per esempio una nota operativa basata sulle
informazioni che scrivi in chat. Il confronto listini resta una fixture tecnica.

## Domanda semplice

Apri una conversazione e fai una domanda. Se riconosciuta come domanda, rimane
una risposta in chat. Quando chiedi un risultato operativo, Homun prepara una
proposta di lavoro. Se la distinzione non corrisponde all'intento, chiariscilo
prima di confermare; il modello può classificare male la richiesta.

## Un lavoro con materiali

Esempio: «Esplora queste note, cerca scadenze e responsabilità e prepara
un riepilogo operativo. Se mancano informazioni chiedimele, senza inventarle».

1. Nella conversazione del progetto descrivi risultato e vincoli.
2. Leggi l'accordo proposto: obiettivo, Homun o collaboratore scelto e fasi. Correggi ciò che
   non corrisponde alla richiesta, quindi conferma.
3. Seleziona i materiali richiesti dalla capacità. La libreria e il lavoro
   condividono i riferimenti: un file già presente non richiede un secondo upload.
4. Approva l'esecuzione proposta dopo aver verificato fonti e operazione.
   Confermare l'accordo e autorizzare lo strumento sono oggi decisioni distinte.
5. Apri il risultato. Usa la revisione per approvarlo oppure richiedere correzioni
   motivate. Le fasi successive o la chiusura seguono lo stato del piano.
6. Ritrova il lavoro in Compiti e i risultati approvati in Documenti.

Il risultato approvato non viene automaticamente inviato a un cliente o
pubblicato in un sistema esterno. Un errore di versione o di permessi va letto
prima di riprovare: la UI deve ricaricare lo stato autorevole.

## Una bozza scritta da Homun

Chiedi, per esempio, una relazione breve basata sui materiali del progetto,
indicando destinatario, argomenti e vincoli. Verifica che la proposta usi una
fase di sintesi e che sia disponibile una connessione al modello.
Nella sintesi scegli materiali e procedure approvate pertinenti, autorizza
l'avvio e leggi l'artifact consegnato prima di accettarlo.

Homun usa la connessione attiva; un collaboratore usa la propria connessione
preferita, quando configurata. Fonti cambiate o procedure non più approvate possono invalidare
l'esecuzione. Il testo generato richiede verifica dei fatti; non promette un
file impaginato o ricerche su fonti esterne non acquisite.

## Costruire una squadra, quando serve

Da “Costruisci la tua squadra” nell'ingresso iniziale o in Squadra descrivi
azienda, persone, strumenti e difficoltà. Salva il contesto, genera una proposta,
leggila e conferma solo i ruoli utili. Puoi correggere il contesto e rigenerarla.
Il contesto salvato viene utilizzato nelle richieste successive della tua identità.
Creare un collaboratore non collega automaticamente posta, CRM o altri strumenti.

In un lavoro adattivo puoi scegliere una squadra esistente. L'esecutore può
consultare i suoi collaboratori attraverso i modelli configurati; le risposte
entrano nella stessa esecuzione e nel suo budget. Le consultazioni non delegano
azioni esterne o accesso autonomo ad altri documenti.

## Coinvolgere una persona

Prima dell’esecuzione adattiva puoi scegliere chi contattare per eventuali
chiarimenti, registrando un nuovo destinatario se necessario. Una persona
registrata come destinatario può ricevere una richiesta circoscritta.
Il pannello del lavoro permette di preparare un collegamento per leggere la domanda
e rispondere. Il collegamento è temporaneo e revocabile: chi lo possiede può
rispondere con l'identità indicata, senza accedere all'intero spazio.
Non è un account autenticato della persona e Homun non invia il collegamento.

Il browser del destinatario deve poter raggiungere sia la pagina sia il motore.
Un indirizzo localhost funziona solo sul computer che ospita il motore: questa
funzione non configura rete, tunnel, server pubblico o collaborazione tra installazioni.

## Lavoro adattivo e revisione

“Lavora con Homun” prepara un ambito con fonti, squadra e limiti. Dopo l'avvio,
Homun può elencare, leggere e cercare nelle fonti selezionate, consultare la squadra,
chiedere un chiarimento e consegnare. Attività e risposte sono persistenti;
la consegna richiede la tua revisione. Una richiesta di modifiche crea una nuova
fase e conserva il risultato e le fasi precedenti.

Questo ciclo non include ancora navigazione web, shell o chiamate MCP generiche.
Una capacità dichiarata nel profilo non estende gli strumenti disponibili nel ciclo.

## Correggere, riprendere e ripetere

- **Scadenza:** si modifica dal lavoro o da Compiti; il valore è persistente.
- **Budget esaurito:** controlla i consumi e modifica esplicitamente il limite
  se vuoi continuare. I token sconosciuti non sono consumi gratuiti.
- **Procedura:** da un messaggio utile dell'agente scegli “Salva come procedura”,
  poi revisiona e approva in Impostazioni → Skill. La procedura può essere usata
  nelle sintesi successive; non significa addestramento automatico del modello.
- **Ricorrenza:** da un lavoro concluso scegli “Rendi ripetibile”, verifica
  cadenza e prossime esecuzioni. Automazioni permette di gestire la routine.
  Il motore deve essere disponibile per eseguirla: ogni occorrenza crea un
  lavoro supervisionato, non un risultato già accettato.
- **Ripresa:** torna alla conversazione del lavoro per vedere piano, materiali,
  risultati e attese. Un'esecuzione riuscita può attendere ancora la tua revisione.

## Perimetro del pilot

Inizia con file di prova e un risultato verificabile. Scegli poi un caso reale
con criteri di accettazione espliciti. Identità multiutente fra installazioni,
cifratura completa del profilo, effetti esterni recuperabili e upgrade firmato
hanno ancora limiti descritti nello [stato corrente](STATO.md).
La [ricerca Hermes/Homun](research/2026-09-23-hermes-homun-utilizzo.md) prepara
l'analisi UX di questi percorsi; le implementazioni successive sono descritte
nel [rapporto operativo](research/2026-09-23-homun-operativo-verifica.md).
