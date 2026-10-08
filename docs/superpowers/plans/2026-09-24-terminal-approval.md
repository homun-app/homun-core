# Terminale: proposta, approvazione e riconciliazione

Decisione: un servizio applicativo terminale proprio, appoggiato ai CommandRecord
persistenti e a require_work_access. Non usare un server MCP fittizio; non dare al
modello accesso diretto al backend. Conservare il flusso proposto/approvato/eseguito.
Questa tranche espone API autenticate per il controllo umano; registro agente,
UI, artifact e watchdog rimangono nel seguito della parità, senza esclusioni.

Contratto: proposta immutabile con comando, immagine SHA256, work version e policy
offline. Digest su tutti i parametri; solo persona owner/reviewer approva. Il job
usa la radice privata ctx.data_dir e identità derivate dal lavoro/proposta, mai
percorsi host forniti dal chiamante. Intento DB prima dell'IO; nessuna ripetizione
dell'avvio su approvazione ripetuta, crash o errore. Refresh ispeziona soltanto,
può ritrovare un job dopo crash prima della receipt. Esito mancante resta incerto.
L'IO non trattiene la transazione DB. Accesso rivalidato dopo l'IO prima di
esporre log e stato. Lo stop è riservato al proprietario/revisore, rifiuta un
avvio ancora in corso; altrimenti usa l'ID verificato dal backend.

- [x] Test RED: proposta senza IO, consenso esatto, attore, versione, replay,
  crash dopo avvio, recupero, accesso revocato, stato nonzero e stop.
- [x] Servizio applicativo in moduli piccoli; riuso policy e backend.
- [x] Rotte tipizzate autenticate proposta/elenco/approva/refresh/stop, OpenAPI.
- [x] Test API e prova Docker reale attraverso servizio con riapertura SQLite.
- [x] Revisione, verifiche, docs, commit e merge locale.
- [ ] Seguito: agente e UI, artifact/file, watchdog, PTY/stdin, altri backend.

Collegamento successivo individuato nel codice: agent_run_execution.advance
riconosce gli effetti esterni prima del dispatch ordinario; registry_for costruisce
il manifest fissato per run. Aggiungere una capacità terminale opzionale fissata
all'avvio del run, un binding canonico separato da MCP e una ripresa dalla receipt.
Non basta esporre la nuova route come tool: deve sopravvivere a pause, correzioni,
cancellazioni e cambiamento dell'autorità con lo stesso call ID.
