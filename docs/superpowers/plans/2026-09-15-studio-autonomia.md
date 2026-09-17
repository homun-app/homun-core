# Iterazione autonoma autorizzata
## Obiettivo
Validare UX con eventi, intervalli, materiali mancanti, risultati, approvazioni, sovrapposizioni, errori e budget. Preparare Settings senza decidere backend.
## Piano
1. Modulo puro di simulazione con orologio virtuale, regole, eventi e diario. Nessun timer, rete o azione esterna.
2. Controlli nel dettaglio incarico: avvio manuale/intervallo/evento/risultato, finestra di lavoro, requisiti, approvazione, limite.
3. Settings: spazio, modelli locali/remoti, politica di escalation, budget, notifiche e dati demo. Nessun segreto richiesto.
4. Test automatici delle transizioni e prove browser di setup, pause, errori, modifiche materiali e mobile.
5. Riepilogo verifiche e limiti. Preservare la direzione grafica e lo scope UX.

## Implementato
- Regole per avvio manuale, intervallo, evento e risultato di incarico; finestra oraria, giorni lavorativi, prerequisiti, approvazione e budget della prova.
- Simulatore separato dallo stato della scheda, con orologio virtuale, diario, pausa/ripresa, errore/retry, deduplicazione e invalidazione al cambio materiali.
- Selezione di un incarico concreto come dipendenza, limitata allo stesso progetto, con prevenzione di cicli.
- Settings: spazio e fuso proposto, registro modelli locali/remoti, associazione principale/alternativa per collaboratore, politica di escalation, budget spazio, preferenze notifiche e spiegazione connessioni/dati.
- Home: le normali attese tra agenti non entrano nelle richieste di intervento, salvo scadenze vicine.
- Risultato obbligatorio per revisione/completamento; azioni di revisione esplicite; modifiche a risultato/materiali invalidano il completamento.

## Verifiche
31 test automatici: 30 casi nominati più 500 sequenze generate da 30 eventi ciascuna (15.000 transizioni), verificando costi, contatori, prerequisiti e stati. Tutti superati.
Prove browser: configurazione modello e URL non valido, scelta modello di Marta, budget e mantenimento tra viste; attesa materiale, evento duplicato, intervallo durante esecuzione, approvazione e cambio materiale; dipendenza da altro incarico, errore, budget e ripresa senza aggirare il limite; riapertura con diario conservato. Layout a 390 px senza overflow orizzontale per Settings e simulatore.

## Limiti espliciti
Nessun backend, timer reale, connessione, consumo misurato, indicizzazione, notifica o invio. I Settings sono bozze, non applicano politiche allo spazio reale o al simulatore. Il simulatore ha budget e orologio propri e non altera lo stato della scheda; ricevere un risultato è un evento dimostrativo, non il completamento reale dell'altro agente. I dati durano fino al ricaricamento. Eventi, modelli e documenti non vengono interpretati da AI.
