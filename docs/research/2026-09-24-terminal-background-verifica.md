# Sessioni terminale in background

Tranche H09 sul backend Docker già approvato. I run nuovi con immagine terminale
usano la versione 5 del contratto. I run salvati alle versioni 1 e 2 restano
senza poll, attesa e arresto. La versione 3 non ha stdin né terminale. La
versione 4 ha lo stdin a pipe e non ha il terminale.

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

Dalla versione 5 del contratto, `pty: true` insieme a `background: true` avvia
un terminale sul container nuovo. A ogni aggiornamento dei log Homun risponde
una sola volta alle richieste di stato, cursore e dimensione. I log mostrati
al modello non contengono quelle richieste. Un container già avviato non viene
riavviato per aggiungere il terminale. Non è uno schermo: niente ridimensionamento,
segnali o emulazione completa.

La scadenza del comando vale ancora solo mentre Homun è acceso. Non c'è un
timer indipendente nel container a motore spento.

## Prove

Motore: 978 passati, 1 saltato. Web: 226 passati. Architettura: 0 errori,
35 avvisi dimensionali preesistenti. OpenAPI rigenerato. Il test del pannello
mostra la frase sul terminale solo quando la proposta lo chiede, e tiene la
frase sullo stdin a pipe quando il terminale non c'è.

Le prove di stato usano un backend finto per approvazione, ripresa unica,
avviso, assenza di un secondo avvio, stdin non ripetuto e una sola risposta
alla richiesta di cursore. Prove isolate con l'immagine pinnata: due container
`sleep` con arresto di uno solo; una riga sullo stdin di un processo già
avviato; un terminale nuovo che riceve la risposta di cursore e resta in
esecuzione. Sono stati rimossi solo i container di quelle prove. Evidenze:
[terminal_background_docker.json](evidence/2026-09-23-hermes-parity/terminal_background_docker.json),
[terminal_stdin_docker.json](evidence/2026-09-23-hermes-parity/terminal_stdin_docker.json)
e [terminal_pty_docker.json](evidence/2026-09-23-hermes-parity/terminal_pty_docker.json).
Lo schermo completo non è implementato.

## Processo sul computer

Un run può scegliere il processo locale al posto dell'immagine Docker. Il
comando gira in `sh -c`, nella cartella del lavoro, con un ambiente fisso che
non copia le variabili del processo Homun. L'approvazione resta esatta e un
secondo avvio non ripete il comando. Arrestare una sessione non tocca l'altra.
Non è un container: percorsi assoluti e rete restano raggiungibili. Non ci sono
stdin né terminale. Motore: 983 passati, 1 saltato. Web: 226 passati.
Architettura: 0 errori, 35 avvisi dimensionali preesistenti. OpenAPI rigenerato.
## Host SSH

Un run può scegliere un host SSH al posto del container o del processo locale.
Ogni comando resta da approvare. Homun ignora la configurazione SSH di questo
computer e l'agent delle chiavi, fissa la chiave pubblica del server
nell'approvazione e controlla l'impronta della chiave privata. Il comando gira
in una cartella sotto la home di quell'account e non eredita le variabili del
processo Homun. I file non vengono copiati. Non ci sono stdin né terminale.
Arrestare una sessione non tocca l'altra. La prova usa un `sshd` usa e getta
su 127.0.0.1, con chiavi generate per il test e rimosse alla fine. Motore: 986
passati, 1 saltato. Web: 226 passati. Architettura: 0 errori, 35 avvisi
dimensionali preesistenti. OpenAPI rigenerato. Modal, Singularity, Daytona e
Vercel restano assenti.
