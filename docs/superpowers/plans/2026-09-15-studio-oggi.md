# Studio: home operativa e costi

## Direzione approvata

Pulire la home mantenendo la grafica Studio. Rendere immediati gli interventi richiesti, il lavoro della squadra, il prossimo risultato dei progetti e il costo di ogni agente.

## Implementazione

- Home Oggi con richieste da gestire e azione Assegna un lavoro.
- Squadra con attività, dipendenze tra collaboratori e costi del periodo.
- Dettaglio mensile dei costi remoti e servizi; limite API distinto dal totale. Consumi locali non stimati e dati mancanti dichiarati.
- Progetti con prossimo risultato; risultati recenti e attività programmate separati.
- Stato condiviso tra home e progetto per consegna del contesto, preparazione e approvazione del piano. Approvare non equivale a eseguire.
- Incarichi locali collegati al responsabile e, facoltativamente, al progetto di cui fa parte. Visibili nella home, nel progetto e nella conversazione.
- Testata con icona di aggiunta coerente con la creazione del collaboratore.

## Verifica effettuata

- TypeScript, lint dei componenti modificati e build del prototipo superati.
- Browser: priorità confermate rimosse dalle richieste pendenti.
- Browser: consegna Vera, preparazione Elio, approvazione piano e ritorno alla home con stato coerente e nessuna esecuzione dichiarata.
- Browser: nuovo incarico visibile nel progetto e nella conversazione di Elio.
- Browser: cambio periodo costi e apertura dettaglio.
- Ispezione visiva desktop 1440 px e mobile 390 px; larghezza documento mobile 390 px, senza overflow.

## Limiti

Prototipo su /prototypes/first-work.html. Dati dimostrativi; nessun motore, consumo misurato, collegamento esterno o routine attiva. Gli incarichi sono bozze in memoria, perse al ricaricamento. L'interfaccia autenticata preesistente non viene sostituita da questo prototipo.
