# Homun: decisioni necessarie prima della distribuzione desktop

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

> Stato successivo: [bundle autonomo](2026-09-19-desktop-bundle-delivery.md) e [correzioni di affidabilità](2026-09-19-desktop-reliability-delivery.md). Le valutazioni sottostanti sono storiche.

> Aggiornamento successivo della stessa giornata: completati backup offline v2 e recovery materiali/chat; implementata shell Electron di sviluppo con sessione locale. La tabella sotto conserva la fotografia precedente. Stato corrente e prove in [consegna recovery/desktop](2026-09-19-recovery-desktop-delivery.md). Installer, Mac pulito, cifratura operativa e Keychain restano aperti.

## Aggiornamento dei gate

La tabella di fattibilità seguente è storica. Sono ora completati il bundle autonomo macOS arm64, la verifica GUI del flusso intake/confronto, la sessione locale del launcher, il backup offline v2 e la ripresa dei materiali/follow-up. Non riproporre questi elementi come assenti.

Restano gate di distribuzione: Mac pulito, firma Developer ID/notarizzazione, aggiornamento/rollback, cifratura operativa di tutti gli archivi e recupero chiavi, Keychain, identità esterne e compatibilità DBOS. Le prove locali non chiudono questi gate. Riferimento: [stato corrente](../STATO.md).

## Analisi di fattibilità originaria

19 settembre 2026. Verifica di fattibilità delle fasi A/C; **nessuna scelta crittografica adottata e nessuna migrazione eseguita**. Sono stati letti sorgenti, metadati dei pacchetti e documentazione primaria. Nessun valore di credenziale, database utente o elemento Keychain è stato letto. Le modifiche concorrenti a lifecycle/outbox appartengono alla tranche applicativa e richiedono le proprie prove.

## Evidenza locale riproducibile

| Area | Fatto verificato | Conseguenza per la release |
|---|---|---|
| Desktop | `apps/desktop/README.md` conferma Electron, ma la directory contiene soltanto il README | Nessuna prova di installer, Python incluso, firma, notarizzazione o aggiornamento |
| Dipendenze | `package-lock.json` e ora `engine/requirements.lock` presenti; nessun `uv.lock`; i minimi di `pyproject.toml` restano compatibili | Installazione CI vincolata agli hash e alle versioni verificate; extra `memory` escluso dal profilo |
| Ambiente verificato | Darwin arm64; Python 3.13.12; SQLite 3.50.4; DBOS 3.0.0; SQLAlchemy 2.0.54; Pydantic AI 2.44.0 | È un ambiente di sviluppo, non una matrice desktop certificata |
| Cifratura | `PRAGMA cipher_version` su database **in memoria** restituisce `None`; `sqlcipher3`/`pysqlcipher3` non installati | Il driver attuale non prova alcuna cifratura SQLCipher |
| Segreti | `models/secrets.py`: JSON plaintext con `chmod(0600)` best-effort; esiste già il protocollo `SecretStore` | La sostituzione può restare dietro una porta; non confondere permessi e cifratura |
| Backup | `storage/backup.py`: copia online del solo workspace SQLite, hash SHA-256 e restore in directory vuota | Blob, checkpoint DBOS, ricevute runtime e recupero chiavi non sono coperti |

Comandi eseguiti dalla radice del repository, senza aprire dati persistiti:

```sh
uname -sm
uv --version
engine/.venv/bin/python - <<'PY'
import importlib.metadata as metadata
import sqlite3, sys
print(sys.version.split()[0], sqlite3.sqlite_version)
for name in ('dbos', 'SQLAlchemy', 'pydantic-ai', 'keyring'):
    print(name, metadata.version(name))
with sqlite3.connect(':memory:') as conn:
    print('cipher_version', conn.execute('PRAGMA cipher_version').fetchone())
PY
uv lock --project engine --dry-run --python engine/.venv/bin/python --no-config
```

`uv 0.10.0`: dry-run riuscito, **132 pacchetti risolti**, nessun lock scritto e nessun pacchetto installato da quel comando. La risoluzione propone Pydantic AI **2.46.0**, diverso dal **2.44.0** installato; DBOS resta 3.0.0. Include anche le dipendenze opzionali nel grafo (Mem0 2.1.0, Qdrant client 1.19.1), senza installarle. `/usr/bin/security` e `/usr/bin/codesign` esistono; questo non verifica identità di firma, entitlement o accesso ai segreti. `sqlcipher` non è nel PATH.

## Decisione 1: quale profilo DBOS distribuire

**Fatto.** Homun configura `sqlite:///.../dbos.sqlite` in `runtime/dbos_app.py`. DBOS 3.0.0 installato implementa SQLite e PostgreSQL e raccomanda PostgreSQL per produzione nel sorgente `_sys_db.py`. La documentazione ufficiale conferma SQLite come default, ma lega il consiglio PostgreSQL alla distribuzione su più server. Il supporto SQLite non equivale a una garanzia di idoneità per il desktop Homun. [Database DBOS](https://docs.dbos.dev/python/tutorials/database-connection).

**Proposta da validare.** Conservare un candidato desktop locale con un solo proprietario DBOS per directory; registrare esplicitamente il contrasto con la raccomandazione upstream. Prima della decisione finale servono kill/restart durante enqueue e attesa, recupero contributi, contesa, disco pieno, upgrade schema e chiusura pulita nel pacchetto. L'alternativa PostgreSQL richiede una decisione reale su servizio incluso o remoto, installazione, credenziali e recovery; non basta cambiare la URL. Nessun cambio di database è stato eseguito.

**Blocco.** Non dichiarare il profilo SQLite pronto alla distribuzione prima di queste prove e di una decisione documentata sul supporto operativo. L'outbox applicativa non risolve da sola packaging, cifratura o backup del database DBOS.

## Decisione 2: driver cifrato e custodia delle chiavi

**Fatti.** Il progetto upstream `sqlcipher3` dichiara wheel autosufficienti dalla 0.6.2. Il 19 settembre l'API ufficiale [PyPI sqlcipher3](https://pypi.org/pypi/sqlcipher3/json) elenca wheel `cp313` per macOS arm64, x86_64 e universal2. Il wheel arm64 è `sqlcipher3-0.6.2-cp313-cp313-macosx_11_0_arm64.whl`, SHA-256 `8e1ff6079603dfd955d57c26dad5eab14f6baacdc643d8753dd651913ba789cf`. È evidenza di disponibilità, non una prova di caricamento, notarizzazione o interoperabilità. [Upstream Python](https://github.com/coleifer/sqlcipher3).

Zetetic offre inoltre binari commerciali Apple arm64/x86_64; l'integrazione Xcode non dimostra automaticamente il funzionamento nel processo Python incluso. [Distribuzione Apple](https://www.zetetic.net/sqlcipher/sqlcipher-apple/). SQLAlchemy supporta un DBAPI SQLCipher, preferendo `sqlcipher3`; DBOS accetta `system_database_engine`. Questa combinazione è una **possibilità di integrazione**, non supporto SQLCipher verificato per DBOS. [SQLAlchemy](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html#pysqlcipher), [configurazione DBOS](https://docs.dbos.dev/python/reference/configuration).

**Proposta da validare.** Uno spike su dati sintetici deve aprire workspace e checkpoint DBOS tramite il driver candidato, applicare la chiave prima di qualunque lettura/migrazione, verificare `cipher_version`, rifiuto della chiave errata, WAL, restart, backup cifrato e conversione di una copia plaintext. Vietato accettare silenziosamente SQLite ordinario quando il driver cifrato manca. Il driver non cifra automaticamente blob, ricevute JSON o indici esterni: ciascuno va incluso nella decisione dei dati protetti.

Apple Keychain è il candidato per credenziali provider e chiavi locali. Il protocollo `SecretStore` evita di legare il dominio alla libreria. `keyring` 25.7.0 è già installato transitivamente, ma la sua documentazione avverte che script eseguiti dallo stesso interprete possono accedere agli stessi segreti senza un nuovo prompt. Occorre provare il proprietario firmato del segreto: helper/processo incluso con identità stabile e accesso ristretto, oppure broker nativo della shell. La disponibilità del modulo non decide questa architettura. [Apple Keychain](https://developer.apple.com/documentation/Security/keychain-services), [limiti macOS di keyring](https://keyring.readthedocs.io/en/latest/#security-considerations).

**Blocco.** Definire prima il comportamento con portachiavi bloccato, consenso negato, reinstallazione, cambio macchina e perdita chiave. Provare i casi con credenziali fittizie nel pacchetto firmato; nessuna migrazione automatica dei segreti reali durante lo spike. Non è stata verificata né selezionata una soluzione di recupero delle chiavi.

## Decisione 3: backup che ripristina davvero un'installazione

**Proposta.** Introdurre un formato successivo al backup v1 con inventario versionato di workspace, blob immutabili, checkpoint DBOS e ricevute richieste dal recovery. La prima implementazione può richiedere una quiescenza coordinata di scrittori e runtime: una copia separata di due database non è una fotografia atomica dell'installazione. Specificare quali indici sono ricostruibili e quali impostazioni vanno esportate. Le credenziali devono avere una procedura esplicita di reinserimento o recupero; non copiare il JSON plaintext nel backup come soluzione.

**Correzione consegnata nella tranche applicativa.** Il formato v1 limita il manifest all'unico file workspace atteso e rifiuta traversal, percorsi assoluti e symlink; i test della tranche applicativa ne verificano il contenimento. Questo chiude il difetto osservato durante la prima lettura, ma non estende il backup ai blob o a DBOS. SHA-256 rileva incongruenze, ma non autentica un manifest alterato insieme ai file. La prova di accettazione deve ripristinare in una directory vuota, riaprire documenti originali per hash e riprendere un lavoro in attesa senza duplicare gli effetti. La strategia cifrata del backup dipende dalla decisione di recupero chiavi.

## Decisione 4: build riproducibile prima della prova su Mac pulito

**Realizzato nel presente lavoro.** `engine/requirements.lock` è stato generato con uv 0.10.0, hash e risoluzione universale Python 3.13, vincolando tutte le **113 dipendenze installate** alle versioni già verificate. Nessuna di esse è stata aggiornata. Le **125 voci** del lock aggiungono cinque strumenti di build (Hatchling 1.32.3, editables 0.6, pathspec 1.1.1, tomlkit 0.15.1, trove-classifiers 2026.6.1.19) e sette dipendenze condizionali per altre piattaforme. L'extra opzionale `memory` richiede un lock dedicato prima di abilitarlo in release. La risoluzione iniziale senza vincoli resta la prova del drift che questo lock evita.

Installazione in **due virtualenv temporanei nuovi**, Python 3.13.12 macOS arm64: sincronizzazione con `--require-hashes` riuscita e ripetuta con `--only-binary :all:`; 118 dipendenze più il progetto editable; `uv pip check` verifica 119 pacchetti compatibili. La prima build senza isolamento ha individuato `editables` come dipendenza dinamica di Hatchling: ora compare esplicitamente in `requirements-build.in` e nel lock. La CI usa Python 3.13.12, `pip install --only-binary=:all: --require-hashes`, poi `--no-deps --no-build-isolation` e `pip check`. Nessuna modifica al virtualenv di lavoro dell'utente.

La suite finale dopo l'integrazione, nel virtualenv nuovo con soli wheel e hash verificati, registra **181 passati, uno saltato, un warning di deprecazione Starlette/AnyIO in 54,43 s**. Il processo termina naturalmente con codice 0 (59,0 s inclusa chiusura); nessun processo rimane nel suo gruppo. Il test saltato richiede lo stack Mem0 live. La suite include il test HTTP su processo reale e riavvio aggiunto nella tranche applicativa. Il precedente fallimento architetturale dovuto agli import SQLite dalle route è stato corretto, senza ampliare le eccezioni. L'installazione e l'esecuzione Linux/Intel non sono state provate localmente. Versioni, hash e istruzioni di rigenerazione sono in [engine/README.md](../../engine/README.md). Le opzioni utilizzate sono descritte dall'[interfaccia pip di uv](https://docs.astral.sh/uv/pip/compile/).

**Prossimo incremento verificabile.** Il prossimo incremento resta la shell Electron minima con Python incluso, avvio/arresto e porte controllate; infine driver cifrato/Keychain sul medesimo artefatto firmato. Gate finale: Mac pulito senza Python/Node globali, installazione, import sintetico, arresto forzato, riavvio, upgrade, restore e rollback dell'app senza perdita di fonti. Le attuali CI Linux e prove da virtualenv sono necessarie, ma non chiudono questo gate.
