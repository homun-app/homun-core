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

Dalla versione 4 del contratto, una sessione in background nasce con lo stdin
aperto. `terminal_write` invia byte a quel processo, senza avviarne un altro.
Lo stesso identificativo di chiamata non rimanda i byte se la consegna è già
riuscita o è rimasta incerta. Non è un PTY: un programma che richiede un
terminale interattivo non riceve questo input.

La scadenza del comando vale ancora solo mentre Homun è acceso. Non c'è un
timer indipendente nel container a motore spento.

## Prove

Motore: 971 passati, 1 saltato. Web: 226 passati. Architettura: 0 errori,
35 avvisi dimensionali preesistenti. OpenAPI rigenerato. Il test del pannello
mostra la frase sul comando che resta in esecuzione solo quando la proposta è
in background.

Le prove di stato usano un backend finto per approvazione, ripresa unica,
avviso, assenza di un secondo avvio e stdin non ripetuto. Una prova isolata
con l'immagine pinnata ha avviato due container `sleep`, ne ha arrestato uno
e ha lasciato l'altro in esecuzione. Un'altra ha inviato una riga allo stdin
di un processo già avviato e ha lasciato quel processo in esecuzione. In entrambi
i casi sono stati rimossi solo i container della prova. Evidenze:
[terminal_background_docker.json](evidence/2026-09-23-hermes-parity/terminal_background_docker.json)
e [terminal_stdin_docker.json](evidence/2026-09-23-hermes-parity/terminal_stdin_docker.json).
Il PTY non è implementato. Gli altri backend di H10 restano assenti.
