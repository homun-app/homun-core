# Terminale nel ciclo agente

Estendere il registro nativo con terminal_execute soltanto quando la proposta
run fissa un'immagine SHA256. L'approvazione del run abilita la capacità di
proporre; ogni comando richiede consenso separato. Nessun runtime Hermes.

Usare lo stato waiting_external già gestito da controlli/runtime, con un
terminal_request_id distinto da MCP. Collegare proposta e receipt a run, epoch,
lease e call ID. Validare il comando canonico e l'immagine alla proposta e
all'approvazione. Il job usa la directory del run, non quella generica del lavoro.
Il runtime riconcilia soltanto; riprende il modello dopo exit/dead con esito
esplicito e log limitati. Unknown non è successo. Annullamento prima del consenso
blocca l'avvio; dopo l'avvio registra l'incertezza e conserva la gestione del job.

- [x] Test RED consenso separato, ripresa singola, cancellazione, assenza opt-in.
- [x] Modulo agent_terminal: contratto, binding e receipt; integrazione registro,
  proposta, dispatch, runtime e API; nessuna modifica ai manifest di run precedenti.
- [x] UI per immagine opzionale e consenso comando; errore motore esplicito.
- [x] Verifica con modello/Docker se disponibile, restart, test/contratti/revisione.
- [x] Documenti, commit e merge locale; parità completa ancora aperta.

Rimangono obblighi successivi: watchdog/timeout, PTY/stdin, gestione file/artifact,
background non bloccante per il modello, altri backend e tutta la matrice H01–H46.
