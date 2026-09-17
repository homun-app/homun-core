# Squadra mista e documenti
## Direzione
Persone e agenti condividono incarichi e materiali. Progetto, scadenza e checklist restano facoltativi. Nessun flusso unico obbligatorio.

## Implementazione
- Persone attive dello spazio visibili nella squadra, con avatar e indicazione Persona; agenti distinti.
- Incarichi assegnabili a persone e agenti, anche senza progetto; sezione personale con conversazione e incarichi.
- Richiesta collegata a un passaggio bloccato: primo invio crea un incarico, solleciti successivi aggiornano lo stesso incarico.
- Collegamenti tra richiesta e lavoro iniziale. Risposta completata e approvata utilizzabile per sbloccare esplicitamente il passaggio; non viene marcato automaticamente completato.
- Documenti indipendenti o collegati a più incarichi: upload, testo, download, numero di versione, registro delle revisioni.
- Risultati trasferibili ai documenti senza duplicare la stessa versione. Modifiche del documento invalidano lo stato concluso/in revisione dei lavori collegati.
- Persone restano soggette alla gestione accessi esistente; la partecipazione alla squadra non concede automaticamente accesso ai materiali del progetto.

## Verifiche
Browser: richiesta a Giulia, sollecito senza duplicazione, accesso dalla sezione della persona, risultato e approvazione, ritorno al lavoro e sblocco. Condivisione risultato, modifica a versione 2 e incarico riportato in lavorazione. Documento autonomo senza incarichi; layout mobile largo 390 px su viewport 390 px. TypeScript e build prototipo.

## Limiti
Tutto resta locale e dimostrativo: nessun recapito a un altro account, nessuna risposta AI o persona remota, nessuna esecuzione immediata degli agenti. La richiesta verso un agente viene assegnata, non eseguita. Le note sono aggiunte dall'utente corrente. La cronologia registra le revisioni, ma non conserva copie ripristinabili. Condivisione, autorizzazioni effettive, sincronizzazione multiutente e archiviazione persistente richiedono il motore.
