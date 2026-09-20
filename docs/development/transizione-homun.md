# Passaggio a Homun 2

## Decisione

React per l'interfaccia, Electron per gli installabili, Python per il motore tramite API. Il futuro Flutter utilizzerà le stesse API. Homun 2 dovrà sostituire il vecchio prodotto e la relativa pipeline, dopo le verifiche di compatibilità.

## Passaggi e criteri di uscita

1. **Base separata**: prototipo di riferimento, app React, documentazione e repository locale. Typecheck, test e due build ripetibili. La separazione è completata; oggi UI motore e simulazione restano distinte.
2. **Prova Electron/Python**: shell, processo Python incluso, handshake autenticato locale, arresto e ripartenza. Verifica su macchina macOS pulita senza strumenti di sviluppo.
3. **Primo lavoro reale**: API, persistenza, piano versionato, contributo umano, ripresa dopo riavvio e risultato approvabile. Esecuzione reale su fixture sintetiche dichiarate, senza risultati simulati spacciati per output del motore.
4. **Parità funzionale**: coprire la matrice di accettazione delle specifiche, inclusi settings, agenti, team, materiali, plugin, automazioni e memoria. Registrare differenze e limiti.
5. **Pipeline di distribuzione**: scegliere repository remoto e ramo; CI con installazione da lock, controlli, build React e test motore; job desktop per piattaforma. Credenziali di firma solo nel secret store CI. Firma/notarizzazione macOS, canale alpha e prova aggiornamento prima del canale stabile.
6. **Migrazione**: inventario del vecchio Homun in lettura, backup, migrazione versionata e verifica di quantità, riferimenti, file e permessi. Credenziali tramite portachiavi o nuovo collegamento. Mai sovrascrivere i dati originali durante la prova.
7. **Sostituzione**: pilot, installazione e aggiornamento su macchine pulite, ripristino da backup verificato, poi cambio del canale di release. Conservare vecchi artefatti e backup per rollback; non presumere che il vecchio client possa leggere il nuovo database.

## Limiti attuali

Esistono un candidato .app/ZIP autonomo e workflow CI/build nel repository; questo non attesta un rilascio remoto. Firma Developer ID, notarizzazione, installazione su Mac pulito, aggiornamento e migrazione dal vecchio prodotto restano aperti. Il primo confronto CSV reale e la GUI sono provati: vedi [stato corrente](../STATO.md). Il repository `../app` non viene modificato. Il lock npm è la fonte per nuove installazioni; il vecchio lock Bun è conservato nel riferimento storico. Gli avvisi sulle dimensioni dei bundle vanno affrontati prima della distribuzione desktop.

## Verifica storica del bootstrap — 17 settembre 2026

Le righe seguenti descrivono soltanto il bootstrap iniziale. Motore ed Electron sono stati implementati e verificati successivamente; i conteggi e l’audit qui riportati non sono risultati attuali.

- TypeScript, 83 test e build app/prototipo superati con le dipendenze locali presenti.
- Avvio della nuova app verificato nel browser su porta 4183.
- Lock npm generato; una installazione pulita su macchina nuova resta da verificare.
- Audit npm: tre segnalazioni high per brace-expansion, js-yaml e nanoid; da risolvere e ritestare prima della release.
- Electron e motore Python sono predisposti nella struttura e nelle specifiche, non ancora eseguibili.
