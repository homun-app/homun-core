# Riapprovazione della consegna di risultati esterni

## Risultato

Chiuso il limite del rapporto sulle ricevute: quando il lavoro cambia dopo la
chiamata MCP, il proprietario o revisore umano può rivedere e approvare la sola
consegna del risultato già salvato. L'approvazione originale dell'azione esterna,
il suo digest e la sua versione del lavoro restano invariati.

L'anteprima mostra titolo e obiettivo attuali del lavoro e testo da pubblicare.
Il digest di consegna vincola destinazione, versione del lavoro, hash dell'intera
ricevuta, server e strumento originari. Un cambiamento tra anteprima e consenso
produce un conflitto tipizzato. La pubblicazione, la nuova traccia di consenso e
il record idempotente vengono committati insieme. Anche il replay rivalida
l'autorità attuale e non può usare un ID appartenente a un altro comando.

La UI richiede prima «Rivedi consegna», poi «Approva la consegna al lavoro».
La richiesta mantiene lo stesso ID quando viene ritentata dopo una risposta
persa. Il modulo di consegna non chiama trasporti; funziona anche dopo la
rimozione del server, perché consegna una ricevuta persistita.

## Verifica

- Test applicativi e HTTP: anteprima, digest errato, versione o ricevuta mutate,
  autorità attuale, collisione ID, replay e approvazione originale immutabile.
- Fixture con vero processo MCP stdio: una chiamata incrementa un file, il suo
  risultato viene salvato e la pubblicazione interrotta. Il contesto è ricreato
  dalla stessa SQLite, il lavoro modificato e il server rimosso; la nuova
  approvazione consegna un artifact mantenendo il contatore esterno a **1**.
- Revisione indipendente senza rilievi. Nessuna attestazione visiva sull'app
  installata: l'interfaccia è verificata tramite typecheck/build, il contratto
  completo mediante le route HTTP e i test del motore.

Suite completa: **777 test engine passati, 1 saltato**. Dopo l’estensione della
fixture stdio ai lavori modificati, **19 verifiche mirate passate**. Inoltre
**216 test web passati**, typecheck/build riusciti, OpenAPI allineato e controllo
architetturale senza errori (35 avvisi dimensionali preesistenti).

## Limiti

Gli esiti esterni incerti non diventano successi e non sono consegnabili senza
ricevuta. La riconciliazione con il servizio, il pin degli schemi e il collegamento
MCP al ciclo adattivo restano aperti. Il consenso alla consegna non aggira stati
chiusi o altre regole del dominio. Nessun push o aggiornamento dell'app installata.
La parità completa continua a richiedere le 46 righe della matrice Hermes.
