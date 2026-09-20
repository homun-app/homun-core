# SQLCipher feasibility spike — 19 settembre 2026

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

**Esito: fattibilità tecnica positiva su questo Mac arm64; nessuna adozione nel runtime.** Eseguito `tools/probe_sqlcipher.py` in un ambiente temporaneo isolato, senza importare Homun, aprire database esistenti, leggere credenziali o interrogare Keychain. Lo script crea chiavi casuali solo in memoria e database sintetici dentro `TemporaryDirectory`, rimossi al termine. Il processo è terminato con exit code 0 e DBOS ha confermato lo shutdown.

## Provenienza e ambiente

- Python CPython 3.13.12, macOS arm64.
- `sqlcipher3==0.6.2`, wheel `sqlcipher3-0.6.2-cp313-cp313-macosx_11_0_arm64.whl`.
- SHA-256 effettivamente verificato prima dell'installazione: `8e1ff6079603dfd955d57c26dad5eab14f6baacdc643d8753dd651913ba789cf`.
- URL del wheel e hash ottenuti dai [metadati ufficiali PyPI della release](https://pypi.org/pypi/sqlcipher3/0.6.2/json), poi confrontati con il contenuto scaricato tramite `hashlib.sha256`.
- Ambiente isolato creato da `uv venv --python engine/.venv/bin/python <directory-temporanea>/venv`; installato il wheel verificato insieme a `dbos==3.0.0`. Risoluzione effettiva SQLAlchemy 2.0.54, greenlet 3.5.6.
- `engine/.venv`, manifest e lock del runtime non modificati.

## Risultati osservati

| Verifica sintetica | Risultato |
| --- | --- |
| `PRAGMA cipher_version` | `4.12.0 community` |
| `PRAGMA journal_mode=WAL` | `wal` |
| WAL presente dopo commit | sì |
| Stringa del record in chiaro nel WAL | non trovata; controllo limitato, non audit crittografico |
| Riapertura con chiave corretta | record recuperato |
| SQLite standard senza chiave | lettura schema rifiutata |
| SQLCipher con chiave errata | lettura schema rifiutata |
| Backup tramite API nativa verso connessione già keyed | record recuperabile con chiave; SQLite standard rifiuta il backup |
| DBOS 3 con engine SQLAlchemy personalizzato | migrazioni completate, 12 tabelle create |
| Workflow DBOS sintetico | completato, risultato atteso |
| Database DBOS via SQLite standard / chiave errata | entrambe le letture rifiutate |

L'output JSON integrale contiene tutte le verifiche sopra come valori `true`, oltre a versione, modalità WAL e numero di tabelle. Il processo ha scritto log delle migrazioni fino alla versione 114 e `DBOS successfully shut down`.

## Collegamento DBOS verificato

Il sorgente installato di DBOS 3.0.0 espone `system_database_engine` in `_dbos_config.py`; `_sys_db.py` usa l'engine ricevuto anziché crearne un altro. È coerente con la [configurazione pubblica DBOS](https://docs.dbos.dev/python/reference/configuration).

Lo spike costruisce `sqlalchemy.create_engine('sqlite://', module=sqlcipher3, creator=...)`. Il creator apre una connessione SQLCipher e imposta la chiave **prima di restituirla all'engine**, quindi prima di ispezioni dello schema o migrazioni DBOS. DBOS riceve quell'engine e un URL SQLite sintetico. Non viene applicata una chiave dopo le migrazioni, né modificato globalmente il modulo `sqlite3`.

Per rieseguire: creare un nuovo ambiente temporaneo Python 3.13, verificare lo stesso wheel contro il digest PyPI, installare il wheel, `dbos==3.0.0` e `SQLAlchemy==2.0.54`, poi eseguire `python tools/probe_sqlcipher.py`. Non usare l'ambiente engine di produzione. Lo script non accetta percorsi di database esterni.

## Limiti e gate ancora aperti

- Verificata una creazione pulita e un workflow semplice; non verificati migrazione di dati Homun esistenti, recovery DBOS di workflow interrotti, concorrenza sostenuta o comportamento dopo crash/power loss.
- Il backup usa la stessa chiave sintetica. Non prova rotazione delle chiavi, recovery su altro dispositivo o portabilità delle impostazioni cipher.
- Non copre cifratura dei blob, metadati di filesystem, file temporanei, memoria/swap, log né l'intera installazione.
- Nessun test Keychain: sessione macOS bloccata. Nessuna credenziale o chiave reale letta. Restano aperti recupero, esportazione controllata e perdita della chiave.
- Nessuna verifica di firma/notarizzazione, licenza distributiva, embedding Python/Electron o compatibilità macOS x86_64.
- La disponibilità e il caricamento del wheel non bastano per dichiarare supporto SQLCipher di produzione da parte di DBOS. Questo risultato riduce l'incertezza di integrazione; non cambia il gate di rilascio.
