# Controlli del ciclo nativo: verifica del 23 settembre 2026

Tranche successiva a `5ce6646b`, nel percorso verso la [parità completa](2026-09-23-hermes-parity-matrix.md).
Non dichiara parità completa di H02: arresto del socket di generazione e cancellazione
fisica di processi/tool esterni richiedono ancora i rispettivi adattatori.

## Comportamento

- I messaggi nella chat di un unico lavoro nativo attivo del proprietario/revisore
  entrano come istruzioni del run. Non avviano un secondo modello di interpretazione.
- `steer` conserva la sequenza di risultati già richiesti e inserisce la correzione
  prima della prossima richiesta al modello. Una correzione arrivata durante la
  generazione impedisce di pubblicare una risposta finale ormai superata.
- `redirect` invalida il tentativo corrente e chiude le chiamate pendenti con esiti
  espliciti: non eseguita oppure incerta se già iniziata. Il nuovo contesto elenca le
  attività incomplete da rivalutare, senza trattarle come letture effettuate.
- Pausa e ripresa persistono, conservano i tool pendenti e non avviano la fase
  successiva. Annullamento disponibile anche mentre si attende un contributo umano;
  in tale stato le correzioni restano nel percorso del contributo autorizzato.
- Ogni controllo è idempotente con comando e versione fissati anche nel client.
  I workflow vecchi vengono esclusi tramite epoch; le risposte tardive tramite lease.
  Gli invii DBOS già persistiti senza argomento epoch ricavano la generazione dal loro ID.
- Controlli owner/reviewer, rivalidazione delle fonti alla ripresa, nessun ampliamento
  implicito degli accessi. Pausa/annullamento possibili anche dopo revoca della fonte;
  risposte fresche e memorizzate oscurano lo storico non più leggibile.

Il frontend usa un pannello separato per Pausa, Riprendi, Interrompi e correzioni;
la chat rimane il percorso naturale per nuove indicazioni. Gli stati paused/cancelled
sono espliciti e il polling continua durante la pausa.

## Prove

- Suite engine completa: **640 passati, 1 saltato**, 104,84 s.
- Successivamente: **32 test agent/control passati**, inclusa una regressione aggiunta
  per migrazione dei workflow senza argomento epoch. Totale test controllo: 16.
- Revisione indipendente: corretti esito incerto dopo pausa, controlli non disponibili
  durante chiarimento e redazione dello storico nelle risposte di controllo. Ogni
  difetto riprodotto con test prima della correzione.
- Suite web: **216 test passati**. Typecheck e build web passati; build con avviso preesistente sui chunk >500 kB.
- OpenAPI aggiornato/verificato; architettura 0 errori e 35 avvisi dimensionali.
- Prova reale locale [script](evidence/2026-09-23-hermes-parity/controls_ollama.py) e
  [traccia](evidence/2026-09-23-hermes-parity/controls_ollama.json): Qwen3.5 4B in Ollama,
  prima lettura, pausa, correzione, chiusura/riapertura del contesto applicativo,
  ripresa e consegna in revisione. Entrambi i materiali effettivamente letti; Ada,
  2 ottobre 2026, modulo B7 e HX-73Q9 presenti; destinatario e data superati assenti.
  Nessun mock del modello; nuovo contesto nello stesso processo, non un riavvio OS.

App desktop non ricostruita/installata. Nessuna verifica visuale browser in questa
tranche: test dei componenti, trasporto HTTP, runtime DBOS e prova locale del motore
sono evidenze distinte, non una certificazione dell'intera UX.

## Riferimento e limiti

Logica di interrupt/redirect Hermes dal commit congelato
`c9dca726514b709cf6e677d236a79fc8d0627f37`, adattata a epoch/lease e transazioni Homun.
Attribuzione aggiornata in `engine/src/homun/notices/hermes-agent.txt`.
Un controllo può invalidare gli effetti futuri e la pubblicazione senza interrompere
immediatamente la chiamata HTTP già in corso; il relativo consumo resta contabilizzato.
Gli strumenti attuali sono letture/consultazioni: strumenti mutanti richiederanno
ricevute e cancellazione specifiche, senza promessa exactly-once generica.
