# Usare Homun oggi

23 settembre 2026 — percorso motore integrato in `main` (`8b7658b2`).
Questa guida descrive l'uso supportato; le [prove](research/2026-09-23-consolidamento-verifica.md)
precisano quali passaggi sono stati verificati dal vivo e quali nei test.

## Che cosa affidargli

Homun permette di concordare un risultato, affidarlo a un collaboratore e
verificarlo. Oggi le capacità locali comprendono confronto CSV, lettura dei
materiali e sintesi testuale. Le procedure approvate aiutano la sintesi;
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

Non occorre dichiarare server MCP o costruire un team per provare un confronto locale.
Il primo caso consigliato è il [confronto di listini di esempio](../demo/price-comparison/README.md).

## Domanda semplice

Apri una conversazione e fai una domanda. Se riconosciuta come domanda, rimane
una risposta in chat. Quando chiedi un risultato operativo, Homun prepara una
proposta di lavoro. Se la distinzione non corrisponde all'intento, chiariscilo
prima di confermare; il modello può classificare male la richiesta.

## Un lavoro con materiali

Esempio: «Confronta questi due listini per SKU, evidenzia le variazioni di prezzo
e prepara un report; non convertire valute e non modificare i file originali».

1. Nella conversazione del progetto descrivi risultato e vincoli.
2. Leggi l'accordo proposto: obiettivo, collaboratore e fasi. Correggi ciò che
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

## Una bozza scritta dal collaboratore

Chiedi, per esempio, una relazione breve basata sui materiali del progetto,
indicando destinatario, argomenti e vincoli. Verifica che la proposta usi una
fase di sintesi e che il collaboratore abbia un modello disponibile.
Nella sintesi scegli materiali e procedure approvate pertinenti, autorizza
l'avvio e leggi l'artifact consegnato prima di accettarlo.

La sintesi usa il modello del collaboratore con il fallback dichiarato dal
prodotto. Fonti cambiate o procedure non più approvate possono invalidare
l'esecuzione. Il testo generato richiede verifica dei fatti; non promette un
file impaginato o ricerche su fonti esterne non acquisite.

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
l'analisi UX di questi percorsi; non cambia ancora l'interfaccia.
