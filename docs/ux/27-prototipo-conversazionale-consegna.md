# Prototipo conversazionale — consegna v1

17 settembre 2026. Prototipo interattivo della UX: le esecuzioni degli agenti, le integrazioni e le autorizzazioni restano simulate.

## Aprire la versione completa

[Apri il prototipo](http://127.0.0.1:4182/prototypes/conversations.html?work-demo=busy&edition=complete)

Il server locale deve essere in esecuzione. Questa edizione usa uno spazio di salvataggio separato dalle prove precedenti. Parte con 18 lavori, 3 progetti, 2 team, 6 materiali fittizi e 3 automazioni.

## Percorso di prova

1. Apri un lavoro da **Richiede te**: la conversazione mostra la richiesta e il punto in cui contribuire.
2. Apri un lavoro da **Risultati**: leggi il risultato, chiedi una revisione o approva con il responsabile previsto. Il selettore Vista demo permette di provare le diverse persone.
3. Crea una conversazione con Marta per preparare un catalogo. Allega un materiale, modifica il piano, assegna i passaggi e simula l'avanzamento.
4. Dal menu della conversazione prova rinomina, spostamento in un progetto, ricorrenza, archiviazione o eliminazione.
5. Apri le **Impostazioni** dall'icona nella barra superiore o vicino al profilo. Prova preferenze, archivio ed esportazione.

## Funzionalità disponibili

- Conversazioni con piano ordinato, responsabili, contributi richiesti, risultati, revisione e approvazione. Modifica manuale dei passaggi e comandi guidati in chat; creazione di un agente durante l'assegnazione.
- Compiti in elenco, Kanban e calendario; ricerca generale e notifiche che riportano al lavoro interessato.
- Progetti con conversazioni distinte, team e materiali. Gruppi rimandati.
- Collaboratori con avatar, curriculum, ruolo, specializzazioni e plugin; gestione dei team e rimozione degli agenti.
- Materiali con caricamento e trascinamento di file/cartelle, ricerca, filtri, selezione multipla, collegamenti e rimozione. Scelta dei collaboratori attraverso il componente con avatar e competenze.
- Catalogo plugin condiviso con ricerca, categorie e origini; assegnazione ai collaboratori.
- Automazioni con frequenze predefinite o regola descritta liberamente, pausa e simulazione manuale di una nuova esecuzione.
- Conversazioni rinominabili, archiviabili, ripristinabili ed eliminabili. L'eliminazione della conversazione conserva i materiali nella raccolta.
- Sidebar e pannello destro richiudibili; navigazione accessibile anche su schermi piccoli.

## Impostazioni

Spazio e profilo; dimensione del testo e animazioni; notifiche; preferenze indicative per modelli e budget; archivio; dati della demo; guida.

Le modifiche non salvate sono segnalate prima di chiudere. Modelli e budget descrivono la configurazione prevista: non attivano modelli, non richiedono chiavi e non producono spese.

## Dati locali

IndexedDB conserva conversazioni, piani, preferenze, raccolte e contenuto dei file caricati nello stesso browser e origine. L'interfaccia mostra lo stato del salvataggio e gli eventuali errori. Non esiste sincronizzazione tra dispositivi; cancellare i dati del browser elimina questa copia.

L'esportazione JSON è un riepilogo di dati e metadati: **non include il contenuto dei file e non è un backup ripristinabile**. Il ripristino della demo richiede di digitare RIPRISTINA e riguarda soltanto l'edizione aperta. Ripristinare una conversazione archiviata non riattiva automaticamente le sue automazioni.

## Verifiche eseguite

- Controllo TypeScript e build del prototipo completati. Lint senza errori, con un avviso preesistente sulle esportazioni React Refresh; build con avviso sulla dimensione dei bundle.
- Salvataggio e ricaricamento di preferenze, titolo e allegato; download del file conservato e controllo del contenuto.
- Archiviazione, recupero ed eliminazione di una conversazione; conservazione del suo materiale nella raccolta.
- Esportazione JSON e verifica dell'assenza dei byte dei file.
- Creazione di agente, team e progetto; assegnazione di un plugin tramite selettore condiviso.
- Avanzamento simulato del piano, approvazione riservata al revisore nella demo e nuova esecuzione di una regola personalizzata.
- Edizione completa e ripristino dei suoi dati iniziali; ricerca e apertura dei materiali.
- Controllo visivo desktop 1440×900 e mobile 390×844, senza overflow orizzontale della pagina; nessun errore di console rilevato nel percorso verificato.

## Confine della consegna

Il prototipo definisce interazioni e stati per costruire il motore. La chat riconosce scenari e comandi guidati, non interpreta qualsiasi richiesta. Restano da implementare nel prodotto reale: LLM e memoria, OAuth e connessioni esterne, esecuzione pianificata, autorizzazioni effettive e inviti, ricerca semantica, contabilizzazione dei costi e sincronizzazione. Le preferenze e i permessi della demo non costituiscono controlli di sicurezza reali.
