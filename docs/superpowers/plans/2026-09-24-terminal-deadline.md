# Scadenza durevole dei comandi

Nuove proposte: timeout_seconds 1..3600, default 300, incluso nel consenso e
visibile prima dell'esecuzione. L'approvazione fissa una scadenza UTC persistente.
Le vecchie proposte senza timeout conservano digest/comportamento: non applicare
retroattivamente un limite non approvato. Manifest terminale v1 conservato;
nuovi run v2 possono proporre la durata insieme al comando.

Un watchdog applicativo, indipendente dallo stato del run e dalla revoca del suo
attore, ispeziona soltanto job già approvati. Se ancora vivo e scaduto, registra
l'intento di arresto, ferma solo il container con proprietà verificata e conserva
uscita/log/esito timeout. Mai avviare o riavviare job. Fallimenti sono incerti e
ritentabili mediante ispezione; un job guasto non impedisce di controllare gli altri.
Ordine per ultimo controllo, lotto limitato. La receipt al modello include timeout.

Limite esplicito: il watchdog opera quando il motore è acceso; alla ripartenza
riconcilia le scadenze trascorse. Non è un timer autonomo del daemon Docker e non
garantisce arresto puntuale a motore spento. Questo resta un requisito aperto.

- [x] RED: consenso durata, scadenza fissa, stop scaduto, nessuno stop anticipato,
  processi già terminati, riavvio, legacy, guasti isolati e run annullato.
- [x] Contratti compatibili e watchdog senza duplicare il salvataggio delle prove.
- [x] Runtime/UI/receipt; prove Docker, test, revisione, docs e merge locale.
