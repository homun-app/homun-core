# Desktop Electron

Electron è la scelta confermata per le versioni installabili. Questa cartella è predisposta; non contiene ancora una shell eseguibile.

Responsabilità previste:

- Caricare la build React da `apps/web/dist` con un'origine applicativa stabile.
- Gestire avvio, health check, riavvio controllato e arresto del motore Python incluso nel pacchetto.
- Isolare la UI: sandbox, context isolation e nessuna integrazione Node nel renderer; eventuale preload espone solo operazioni esplicite.
- Custodire credenziali nel portachiavi del sistema e conservare dati fuori dalla directory di installazione.
- Produrre installer, firma, notarizzazione, aggiornamento e rollback secondo la matrice piattaforme concordata.

Prima prova: installazione macOS su macchina pulita, senza Python o Node globali. Non importare direttamente il codice Python nella UI: le API sono comuni a React e ai futuri client mobili.
