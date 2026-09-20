# Consegna: materiali, recovery e confine desktop

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

> Prosecuzione successiva: creato e verificato il motore incorporato nel bundle macOS. [Artefatto e prove aggiornate](2026-09-19-desktop-bundle-delivery.md). Questo documento conserva la fotografia precedente.

19 settembre 2026. Proseguimento autonomo autorizzato dei cinque punti, sul branch
`fabio/production-foundations`. Lavoro locale, senza commit, push, deploy o migrazioni
dei dati dell'utente. Baseline preservata in
`/Users/fabio/.codex/backups/homun2-recovery-20260919-093804/working-tree.tar.gz`.

## Materiali affidabili

L'ingestione è un caso d'uso applicativo: estrazione fuori dal dominio, originali
immutabili indirizzati da SHA-256 e registrazione transazionale. La chiave
`X-Homun-Command-Id` permette retry della medesima richiesta senza duplicare il
materiale; il client accetta un `commandId` da riusare. L'identità comprende attore,
contenuto e metadati originali, non il risultato variabile dell'estrattore.

Limite upload 25 MiB; namespace senza symlink; pubblicazione atomica e fsync della
catena di directory, anche dopo un precedente tentativo di sync fallito. Il recupero
all'avvio raccoglie soltanto originali gestiti non referenziati e scritture temporanee,
conservando riferimenti condivisi e file legacy. Download con hash incoerente fallisce
esplicitamente. Errori filesystem e SQLite restituiscono `storage_unavailable` senza
percorsi interni. Rimosse entrambe le eccezioni architetturali di I/O nel dominio.

## Backup che riprende il lavoro

Formato v2 **offline** con lease esclusiva acquisita prima dell'apertura dei database.
Inventario: workspace SQLite, originali referenziati, DBOS e ricevute. Verifica percorsi,
symlink, hash, integrità SQLite e riferimenti obbligatori. Creazione e restore scrivono
in staging, verificano e pubblicano atomicamente. La destinazione v2 deve essere
completamente vuota, anche rispetto a `.DS_Store`; non viene cancellato contenuto.

```sh
# Arrestare il motore proprietario della directory prima della copia completa.
npm run engine:backup -- --full --data-dir /percorso/dati --out /percorso/backup
npm run engine:backup:verify -- /percorso/backup/ID
npm run engine:backup:restore -- /percorso/backup/ID --to /percorso/vuoto
```

Il formato v1 rimane leggibile e il backup HTTP rimane v1. V2 esclude credenziali,
configurazione provider e indici ricostruibili: dopo restore occorre riconfigurare i
provider. Non è cifrato né autenticato; gli hash rilevano incoerenze, non un avversario
che modifichi insieme archivio e manifest. Prova completata: arresto di un lavoro
DBOS in attesa, backup, restore altrove, riapertura dell'originale, contributo e
completamento con una sola ricevuta; il retry restituisce lo stesso risultato.

## Risposte recuperabili dopo arresto

Ogni messaggio persistito conserva input e attore del follow-up, claim con scadenza,
numero di tentativi e prossimo retry. Il worker applicativo recupera automaticamente
le claim scadute: massimo tre tentativi, backoff 5/10 secondi. Non reinserisce il
messaggio utente e non assegna agenti automaticamente. La generazione rimane fuori
dalla transazione; autorità e token sono ricontrollati prima del commit.

La conversazione resta occupata anche durante scadenza/backoff: un nuovo messaggio
non può superare una risposta pendente. Una lease scaduta non può finalizzare e resta
recuperabile entro il budget. Input legacy mancante o permesso revocato falliscono
esplicitamente. Il read model espone soltanto stato, codice errore, tentativi e ID;
input/attore persistiti restano interni. Il banner mostra recupero programmato o
fallimento terminale dopo refresh. Retry esplicito della medesima richiesta è
supportato dall'API; non è ancora un pulsante dedicato della chat.

## Moduli UI e prova browser

`ConversationWorkspace`: 1672 → 1459 righe. Progressione simulata e routine sono in
`conversation-simulation-actions.ts`; `useEngineWorkspace`: 539 → 527, riutilizzando
il bridge per il mapping. Budget architetturali abbassati, nessuna nuova eccezione.

La prova reale ha rilevato e corretto una scelta fonte non condivisa fra hook:
`useSyncExternalStore` ora mantiene selettore e workspace coerenti. Verificati nel
browser su localhost:4184, profilo di prova: passaggio simulato a revisione, nuova
routine con conversazione e sotto-lavori, passaggio a motore spento senza reload e
senza mostrare i lavori simulati come lavori del motore. Nessun redesign applicato.

## Desktop e limiti verificati

[Shell e istruzioni](../../apps/desktop/README.md): Electron fissato a 44.4.3,
renderer isolato, origine fissa, proxy ristretto, token effimero, porta dinamica,
proprietà del processo e arresto anche dopo scomparsa del genitore. I cinque test
Node includono motore Python reale, richieste non autenticate rifiutate,
cancellazione startup, morte del proprietario e contenimento del protocollo.

Lo smoke Electron nativo non è completato: il Mac risultava bloccato e il comando
ha raggiunto il timeout. Nessun processo desktop/motore di prova è rimasto attivo.
Non è stato prodotto un installer né verificato safeStorage/Keychain in una sessione
grafica. Restano bundle Python autonomo, firma/notarizzazione, upgrade/rollback e
Mac pulito. Autenticazione locale non equivale a identità multiutente e permessi
uniformi. Cifratura e recupero delle chiavi restano gate separati.

## Cifratura: prova di fattibilità isolata

[SQLCipher e DBOS](2026-09-19-crypto-spike.md): wheel ufficiale verificato per hash,
virtualenv temporaneo separato, SQLCipher 4.12.0 community. WAL, riapertura, backup
cifrato e rifiuto di SQLite ordinario/chiave errata verificati. DBOS con engine
SQLAlchemy personalizzato ha creato 12 tabelle ed eseguito un workflow sintetico,
applicando la chiave prima delle migrazioni. Ambiente temporaneo rimosso e runtime
Homun invariato. Non prova migrazione dei dati, recovery cifrato dopo crash, blob,
Keychain o perdita delle chiavi.

## Evidenza finale

- Backend: suite completa **218 passati, 1 saltato**, 58,52 secondi; il test saltato richiede Mem0 live.
- Frontend: `npm run check`, 121 test, typecheck e entrambe le build riusciti.
- Desktop boundary: 5 test Node con processi reali e directory temporanee.
- Architettura: **0 errori**, 30 avvisi sui file legacy; budget ridotti e nessuna eccezione dominio-materiali.
- Dipendenze npm: aggiornamenti mirati di transitive compatibili; `npm audit` zero vulnerabilità segnalate.
- Deprecazione Starlette/AnyIO e avviso dimensione chunk frontend ancora presenti.
- Mem0 live non eseguito; nessuna prova con credenziali/provider reali in questa tranche.

Review indipendenti hanno individuato e fatto correggere acquisizione tardiva della
lease, identità legata all'estrattore, fsync incompleto, errori I/O non tipizzati,
ordine delle risposte scadute e cleanup desktop durante startup. Le correzioni
rilevanti hanno regressioni dedicate. Le prove locali non equivalgono a CI remota
né a certificazione della distribuzione desktop.
