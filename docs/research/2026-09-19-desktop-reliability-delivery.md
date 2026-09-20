# Affidabilità desktop e backup — 19 settembre 2026

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

> Candidato successivo: [autorizzazione lavori/runtime](2026-09-19-work-authorization-delivery.md).

Prosecuzione autonoma delle basi di produzione. Tre difetti riprodotti prima della
correzione: due race nell'avvio del motore e visibilità di backup non pubblicati.
Nessun dato reale, credenziale, commit o push utilizzato.

## Correzioni

1. Annullamento durante la lettura HTTP della risposta health: startEngine restituiva
   comunque il processo come pronto. Il segnale ora interrompe anche il probe e la
   disponibilità viene ricontrollata dopo la lettura del corpo.
2. Timeout globale scaduto durante il probe: risposta tardiva accettata. Il probe ora
   usa il budget residuo e non può pubblicare readiness dopo la scadenza.
3. SIGKILL dopo scrittura del manifest, prima di fsync/rename: list_backups includeva
   `.pending-*` tra i backup completati. Le directory temporanee nascoste sono escluse;
   restano sul disco per eventuale ispezione esplicita, senza cancellazione automatica.

Il proprietario del processo resta in engine-process.cjs e il catalogo backup in
storage/backup.py. Nessuna espansione di main.cjs, nessuna dipendenza aggiunta.

## Verifica

I due test desktop usano un vero processo Node e socket HTTP, con corpo della risposta
rilasciato dopo annullamento/scadenza; entrambi fallivano prima della correzione.
Verificano anche che il figlio sia terminato prima del rifiuto della promessa.
Il test backup uccide un processo Python con SIGKILL al confine pre-pubblicazione;
falliva esponendo la cartella temporanea, ora verifica esclusione e rilascio del lease.

- Suite desktop: 8 test riusciti.
- Recovery mirato: 15 test riusciti, inclusi errori ENOSPC durante copia SQLite,
  copia materiali e fsync, più errore fsync durante restore. I backup precedenti e gli
  originali restano integri; i tentativi successivi riescono.
- Suite backend finale: **223 passati, 1 Mem0 live saltato**, in 59,29 s; un warning
  preesistente Starlette/AnyIO. Log: `/tmp/homun-reliability-engine-final.log`.
- Architettura: zero errori, 30 avvisi di dimensione preesistenti.
- Build autonoma completa riuscita; Python/hash/input verificati dal builder.
- Test lifecycle anche con il motore incorporato nel pacchetto: 3 riusciti, più i
  2 test race sulla shell corrente verificata identica a quella inclusa.
- Archivio estratto in directory temporanea: checksum ZIP, inventario del motore,
  corrispondenza dei quattro moduli shell ai sorgenti e smoke runtime riusciti.
  Lo smoke include autenticazione, riavvio durevole, replay con una ricevuta e shutdown,
  da directory temporanea con PATH=/nonexistent e senza PYTHONPATH.
- CI aggiornata per includere i nuovi test race; esecuzione remota non effettuata.

Le prove ENOSPC iniettano errori ai confini I/O: non simulano un guasto fisico del disco
né certificano la resistenza alla perdita di alimentazione. Il SIGKILL è reale, su
processi di test e dati sintetici. Il crash lascia staging non pubblicato; non viene
implementata una cancellazione automatica delle cartelle residue.

## Candidato aggiornato

Archivio: `dist/desktop/2026-09-19T08-50-30-886Z/Homun-0.1.0-macos-arm64.zip`

Dimensione: 181701456 byte. SHA-256: `b4de68191d6aaef9c246dccc14292eb50ccaf392326046b2ecfd5170b55b9617`.

Sostituisce il candidato 08-40 per queste correzioni. Stessi limiti di distribuzione:
nessuna firma Developer ID/notarizzazione; verifica grafica nativa e Mac pulito ancora
aperte. In questa tranche non è stata ripetuta l'interazione con la sessione Mac.

## Lavoro ulteriore indipendente dalla GUI

Restano affrontabili per tranche: audit dell'autorizzazione sulle API e nei job
recuperati; prove di compatibilità fra versioni di schema e comportamento di rollback;
gestione degli errori dopo la pubblicazione atomica e prima della conferma fsync.
Questi punti non sono bloccati dalla sessione grafica e non sono dichiarati completati.
Firma, notarizzazione e prova dell'identità Keychain richiedono invece il contesto di
firma e la verifica nativa descritti nei gate di distribuzione.
