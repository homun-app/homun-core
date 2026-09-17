# Dati locali, distribuzione selettiva e cifratura

17 settembre 2026. Indirizzo espresso da Fabio: dati locali, trasferimento soltanto di ciò che serve; desiderio di cifrarli, con blockchain citata come possibile mezzo. La località e la minimizzazione sono requisiti; blockchain e schema delle chiavi non sono scelte approvate.

## 1. Regola proposta

Ogni oggetto ha un nodo responsabile e copie autorizzate, nessuna replica indiscriminata dell'azienda. Per la prima versione, stato di piano, permessi e budget di uno spazio hanno una sola autorità. File privati possono restare su altri dispositivi: il piano conserva un riferimento e deve mostrare quando la fonte è offline. Questo distingue chi conserva il file da chi coordina il lavoro.

| Dato | Distribuzione proposta |
|---|---|
| File personali non collegati | Restano sul dispositivo d'origine |
| File collegato al lavoro | Trasferire versione selezionata o estratto verificabile al nodo esecutore autorizzato |
| Chat e piano condivisi | Copia degli eventi necessari ai partecipanti autorizzati; niente sincronizzazione di tutte le chat |
| Risultato | Torna al nodo del lavoro; disponibile ai destinatari previsti |
| Memoria agente/progetto | Solo voci pertinenti e consentite, con provenienza; non intero archivio |
| Credenziali | Restano nel secret store del nodo; delegare la capacità invece della chiave |
| Backup | Copia cifrata su destinazione scelta, separata dalla normale condivisione |

Un estratto può essere insufficiente: l'agente chiede un ulteriore accesso motivato; non trasferisce automaticamente tutto il file. Registro leggibile: cosa è stato condiviso, versione, con chi, per quale lavoro. Una retention può richiedere la cancellazione della copia, senza promettere che un destinatario ostile non l'abbia duplicata.

## 2. Protezioni distinte

1. **A riposo:** database, file, indici di ricerca, anteprime e backup cifrati. Se si cifra soltanto il PDF ma restano testo estratto e nomi in chiaro, il requisito non è soddisfatto.
2. **In transito:** connessione autenticata e cifrata tra i dispositivi; un eventuale relay non possiede le chiavi dei contenuti. Metadati di rete possono comunque essere visibili.
3. **Durante l'uso:** l'agente/processo autorizzato deve accedere al testo in chiaro per elaborarlo. La cifratura normale non protegge da un dispositivo compromesso mentre è sbloccato.
4. **Verso un modello remoto:** inviare contesto a un provider cloud è una nuova condivisione. La cifratura del collegamento non impedisce al provider di elaborare il contenuto. Modalità solo-locale e policy per materiali sensibili devono essere applicate anche a riassunti ed embedding.

## 3. Chiavi e recupero

Proposta da formalizzare nello spike crittografico:

- Identità crittografica distinta per dispositivo; nessuna unica chiave privata copiata a tutti i membri.
- Chiave casuale per oggetto/versione, protetta per i destinatari autorizzati attraverso primitive e protocolli esistenti. Non inventare algoritmi o protocolli di scambio.
- Chiavi del database/archivio protette dal portachiavi del sistema; chiavi dei file separabili per condivisione selettiva. Password di login, identità del device e chiavi del contenuto sono concetti diversi.
- Rotazione e revoca per gli accessi futuri; revocare un utente non rende illeggibile una copia che ha già decifrato o una chiave che ha conservato.
- Backup cifrato con meccanismo di recupero esplicito sotto controllo del proprietario: prova reale di ripristino su nuovo dispositivo. Senza chiave o recupero, dati persi; non promettere reset password capace di ricostruire chiavi inesistenti.
- Per automazioni a dispositivo bloccato definire quando il servizio può sbloccare l'archivio: richiedere sempre intervento umano all'avvio e consentire esecuzione non presidiata sono politiche diverse.

Candidati: database con cifratura supportata e librerie di cifratura autenticata per file (es. libsodium). La scelta definitiva richiede compatibilità Python/desktop, migrazioni, distribuzione, licenza e review del protocollo. Non chiamare sicuro il sistema sulla sola base del nome dell'algoritmo.

## 4. Blockchain

La blockchain non fornisce automaticamente riservatezza: serve a mantenere un registro condiviso e un meccanismo di accordo. Per Homun i partecipanti aziendali sono identificati; la prima esigenza è controllare accessi, chiavi e trasferimenti, non raggiungere consenso pubblico tra sconosciuti.

Proposta: nessuna blockchain nella prima versione. Conservare eventi e ricevute firmati, con catena di hash se utile a rilevare alterazioni. Non descrivere questo registro locale come immutabile: chi controlla archivio e chiavi può alterarne la storia; copie/testimoni indipendenti e checkpoint sono necessari per garanzie maggiori.

Se in futuro emerge un requisito preciso di attestazione tra aziende che non si fidano reciprocamente, valutare notarizzazione di impegni crittografici, senza documenti o dati personali on-chain. Anche hash e metadati possono rivelare informazioni: valutazione separata, non un'aggiunta automatica.

## 5. Prove obbligatorie da aggiungere al piano

- Disco/database/blob/indice/preview ispezionati a riposo: nessuna copia inattesa in chiaro, inclusi file temporanei e log.
- File cifrato corrotto, troncato o sostituito rifiutato; errore visibile senza produrre risultato falso.
- Peer non autorizzato non riceve chiave o contenuto; relay non decifra il payload.
- Revoca impedisce nuove condivisioni e nuove versioni; limite sulle copie già scaricate dichiarato.
- Recupero dopo perdita del dispositivo e rotazione chiavi, verificando anche i backup.
- Modalità solo-locale misurata tramite traffico di rete: nessun dato ai provider esterni.
- Nodo fonte offline: file non disponibile segnalato; niente completamento sulla base di contenuto inventato.
- Revisione indipendente di protocollo, gestione chiavi e confini prima della beta con dati sensibili.

## Fonti

- [Libsodium: cifratura di file e stream](https://doc.libsodium.org/secret-key_cryptography/secretstream): primitive disponibili per cifratura autenticata e rilevamento alterazioni. Non risolve da sola distribuzione delle chiavi o permessi.
- [iroh: relay](https://docs.iroh.computer/iroh-services/relays/public): distinzione tra contenuto cifrato e metadati della connessione.
