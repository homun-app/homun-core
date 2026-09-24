# Sessioni terminale in background

Tranche H09 sul backend Docker già approvato. I run nuovi con immagine terminale
usano la versione 3 del contratto. I run salvati alle versioni 1 e 2 restano
senza poll, attesa e arresto.

## Contratto

`terminal_execute` con `background: true` richiede la stessa approvazione esatta.
Quando il container è in esecuzione, il risultato del tool torna subito con
`job_id` e `complete: false`. Il comando non viene riavviato. Se il processo è
già uscito prima di quel risultato, il modello riceve una sola ricevuta di
completamento.

`terminal_poll` legge stato e log. `terminal_wait` sospende il run finché la
sessione esce, poi consegna una sola ricevuta. `terminal_stop` arresta solo
quella sessione. Un esito `outcome_unknown` non autorizza un secondo avvio.
Se il modello non attende, un messaggio utente registra la fine una sola volta.
PTY e scrittura su stdin non esistono e non sono annunciati al modello.

La scadenza del comando vale ancora solo mentre Homun è acceso. Non c'è un
timer indipendente nel container a motore spento.

## Prove

Motore: 970 passati, 1 saltato. Web: 226 passati. Architettura: 0 errori,
35 avvisi dimensionali preesistenti. OpenAPI rigenerato. Il test del pannello
mostra la frase sul comando che resta in esecuzione solo quando la proposta è
in background.

Le prove di stato usano un backend finto per approvazione, ripresa unica,
avviso e assenza di un secondo avvio. Una prova isolata con l'immagine pinnata
ha avviato due container `sleep`, ne ha arrestato uno e ha lasciato l'altro in
esecuzione, poi ha rimosso solo quei due container. Evidenza:
[terminal_background_docker.json](evidence/2026-09-23-hermes-parity/terminal_background_docker.json).
PTY e stdin non sono stati provati: non sono implementati. Gli altri backend
di H10 restano assenti.
