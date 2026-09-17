# Dal messaggio al compito nel progetto

## Percorso concordato
La chat chiede solo i dati mancanti: collaboratore, materiali, scadenza facoltativa. Mostra un piano modificabile e crea il compito solo alla conferma. Non chiede di classificare il messaggio come obiettivo o nota.

## Prototipo
Scenario guidato del catalogo: riconosce la parola catalogo e un collaboratore selezionato con @ oppure un nome esplicito preceduto da @. Le altre richieste vengono conservate e dichiarate non interpretate. Nessuna chiamata AI.

Si possono importare cartelle/file, scegliere materiali del progetto accessibili al responsabile, scegliere una scadenza oppure rimandarla. Rimandare i materiali produce un compito bloccato. Confermare aggiunge il responsabile alla squadra e crea un AssignedWork condiviso dalle viste esistenti. Non riscrive automaticamente l'obiettivo del progetto. Le autorizzazioni delle persone restano separate.

Il piano è modificabile nei controlli: titolo, responsabile, passaggi e scadenza. Le istruzioni libere successive non vengono finte come eseguite. Il compito confermato si riapre dalla chat e da Compiti. La proposta non confermata è transitoria; dati e file restano in memoria fino al ricaricamento. Nessuna esecuzione esterna.

## Motore futuro
Interpretazione agnostica delle richieste, aggiornamento del piano tramite conversazione, accessi verificati prima dell'esecuzione, notifiche e risultati reali. Il catalogo è solo una fixture di esperienza, non una specializzazione del modello dati.

## Richieste di contributo
Una dipendenza deve avere un destinatario identificabile e una richiesta concreta. Il componente StudioContribution è comune alle richieste collegate ai passaggi dei lavori: risposte testuali, riferimenti, file e cartelle, non soltanto cataloghi. Le richieste a Fabio compaiono nel centro attività e in Richiede te. Il badge indica elementi da gestire, non semplicemente letture.

Nello scenario catalogo rinviare i listini genera un compito per Fabio collegato al passaggio input di Marta. La consegna chiude la richiesta e rimuove solo il relativo blocco, conservando le altre dipendenze. Non completa i passaggi dell'agente e non genera risultati fittizi. File e cartelle entrano nella raccolta del progetto con accesso ristretto ai due partecipanti entro i permessi del progetto. Nella demo il contenuto consegnato non è validato e il completamento della richiesta indica la consegna, non la correttezza del materiale.
