# Compatibilità schema e ripristino — 19 settembre 2026

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

Audit circoscritto del codice corrente, con database temporanei. Nessun database
utente, GUI, servizio distribuito o cronologia Git modificati.

## Esito e correzione

L'apertura del repository SQLite già accetta esclusivamente `user_version` 0
(schema documentale legacy) e 1 (corrente). Una versione futura viene rifiutata
prima di modificare tabelle o impostare WAL. La migrazione legacy usa `BEGIN
IMMEDIATE`, commit unico e rollback anche per errori dopo l'aggiornamento della
versione. I test confermano che inserimenti parziali e incremento della versione
non sopravvivono a un errore.

Il ripristino completo v2 aveva invece un controllo mancante: un backup con
checksum corretti e schema workspace futuro superava la verifica, pur non
essendo poi apribile dal repository corrente. Due test con versioni 2 e 999
hanno riprodotto il problema (`DID NOT RAISE BackupError`).

La correzione estrae `validate_schema_version` in
`engine/src/homun/storage/schema.py`, riutilizzandola in inizializzazione e in
`engine/src/homun/storage/backup_inventory.py`. La verifica legge la versione
attraverso la connessione SQLite in sola lettura già esistente. La versione
incompatibile produce `BackupError` esplicito prima dello staging/ripristino.
Questo controllo vale anche per la creazione di nuovi backup completi, che usa
lo stesso inventario. Non introduce una migrazione o modifica al formato backup.

I backup legacy e correnti continuano a essere verificati senza modificarne i
byte e sono ripristinabili. Un backup rifiutato resta intatto e non viene
pubblicata alcuna destinazione.

La chiusura successiva estende lo stesso controllo anche al formato backup v1
in `engine/src/homun/storage/backup.py`: verifica in sola lettura dopo checksum
e dimensione, prima di creare la destinazione di ripristino. La creazione
verifica la copia SQLite prima di scrivere il manifest, entro il blocco di
cleanup esistente. Questo copre sia sorgenti su file sia connessioni live:
una copia con schema futuro viene eliminata e il database sorgente resta
intatto. Non sono stati aggiunti controlli nuovi sull'identità o sulla forma
documentale del formato v1. Quattro test rossi iniziali hanno riprodotto
l'accettazione indebita in verifica e creazione.

## Verifica

Nuovo file: `engine/tests/test_schema_compatibility.py`.

```sh
cd engine
.venv/bin/python -m pytest tests/test_schema_compatibility.py tests/test_storage_transactions.py tests/test_installation_backup.py tests/test_backup_f25.py -q
```

Risultato finale: **46 passed**, 1 deprecazione preesistente Starlette/AnyIO, 5,93 s.
Copertura nuova: futuro 2/999 rifiutato; backup supportati 0/1 preservati e
ripristinati; errore durante inserimento metadata; errore nella validazione
finale dopo il bump di versione; riapertura dopo eliminazione del guasto.
Per il formato v1: verifica/ripristino rifiutano 2/999 con checksum corretti,
creazione da file e da connessione live ripulisce copie future, e schema 0/1
continua a essere creato, verificato e ripristinato senza migrazioni implicite.
La suite adiacente include rifiuto futuro all'apertura, migrazione legacy,
transazioni, backup completo e backup workspace v1.

## Limiti e prossimo confine

- Il controllo riguarda la versione dichiarata dello schema workspace, non la
  compatibilità semantica di ogni documento JSON. Cambiamenti incompatibili
  devono incrementare quella versione. Non costituisce un framework generale
  di aggiornamento o downgrade.
- Il formato backup v1 ora verifica anche la versione workspace, mantenendo
  invariati gli altri controlli checksum/inventario e il comportamento legacy.
- DBOS è un confine separato. Nell'ambiente esaminato è installato DBOS 3.0.0.
  `dbos/_sys_db_sqlite.py::run_migrations` salta migrazioni già registrate senza
  rifiutare versioni superiori a quelle note. Anche
  `dbos/_sys_db.py::_assert_migration_version` rifiuta solo versioni inferiori:
  il commento dichiara esplicitamente la tolleranza di un peer più recente.
  Quindi il codice SDK consente una versione futura; questo audit non prova
  una successiva mutazione o compatibilità del runtime con uno schema reale
  futuro. La verifica del bundle Homun esegue soltanto `quick_check` per DBOS.
- La migrazione DBOS usa `engine.begin()`, ma questo audit non ha iniettato
  errori DDL nel driver SQLAlchemy/SQLite: non si estende a DBOS la garanzia
  dimostrata sui rollback del repository workspace.

Proposta circoscritta per DBOS: definire prima il contratto di compatibilità
runtime/SDK supportato, poi usare un unico controllo read-only condiviso fra
avvio e ripristino, con metadati derivati dalla dipendenza effettivamente
confezionata. Verificare prima della configurazione/lancio DBOS, conservando
supporto esplicito alle versioni migrabili. Non fissare un numero di migrazione
nel codice Homun e non dipendere silenziosamente da API private del pacchetto.
I test necessari dovranno includere schema più recente, aggiornamento supportato
e fallimento a metà migrazione, verificando file e destinazioni invariati.
