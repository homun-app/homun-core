# Stato verificato di Homun 2

Aggiornato il 23 settembre 2026, dopo il consolidamento del sorgente `0.2.1001`
a partire da `e5155baf`, integrato su `main` nel commit `8b7658b2`. Questo documento descrive lo stato corrente; lo
[stato precedente](STATO-2026-09-22.md) e i rapporti in `research/` conservano
le prove storiche. Una verifica del sorgente non aggiorna l'app installata.

## Capacità presenti

- Motore Python persistente con comandi versionati, autorizzazioni, materiali,
  artifact, piani, budget, outbox e workflow DBOS.
- Chat supervisionata: domanda oppure proposta di lavoro, accordo confermato,
  collaboratore assegnato, piano per fasi, approvazione degli effetti e revisione
  umana dei risultati. `general` indica preparazione, non esecuzione generica.
- Confronto CSV deterministico, lettura materiali e sintesi con il modello del
  collaboratore. Le fonti della sintesi vengono rivalidate all'approvazione,
  all'esecuzione e prima della pubblicazione.
- Materiali e Plugin dalla barra laterale usano ora le stesse API e gli stessi
  riferimenti delle impostazioni e degli strumenti. La libreria materiali offre
  ricerca, filtro progetto, upload file/cartella, lettura e archiviazione.
  Errori di accesso non conservano l'anteprima precedentemente aperta.
- Gestione collaboratori, team, progetti, piani, scadenze e budget nel percorso
  motore. Compiti modifica la scadenza persistente anche dal proprio dettaglio.
- Documenti approvati consultabili; routine cron che creano lavori supervisionati.
  La riconciliazione ripara anche divergenze di cron e fuso, conservando la pausa.
- Budget globale e allocazioni per collaboratore: la sintesi contabilizza
  l'assegnatario, mantenendo la persona come autorità dell'approvazione. Consumi
  parziali conservano i token noti e registrano il tentativo come incerto.
- Server MCP dichiarabili e strumenti ammessi esplicitamente. Shell Electron,
  pipeline di release e updater presenti; il controllo manuale offre un solo
  dialogo per l'evento di aggiornamento.

## Evidenze della tranche corrente

Le prove e i limiti sono descritti nel
[rapporto di consolidamento](research/2026-09-23-consolidamento-verifica.md).
I risultati di modelli reali e pacchetti delle tranche precedenti rimangono
nei rispettivi rapporti e non sono stati ripetuti automaticamente qui.

## Limiti ancora aperti

- MCP esegue fuori dal percorso DBOS/outbox dei tool locali: un effetto esterno
  e la sua registrazione richiedono un contratto dedicato per esiti incerti.
- Nessuna stima preventiva affidabile dei token: una chiamata già ammessa può
  superare il cap; le chiamate successive sono bloccate quando il limite noto è
  raggiunto. Consumo sconosciuto non significa consumo nullo.
- Identità locale legata al launcher e al profilo attuale; provisioning
  multiutente e collaborazione fra installazioni non certificati.
- Cifratura operativa dell'intero profilo, gestione/recupero chiavi e upgrade o
  rollback di dati e runtime richiedono prove dedicate. Il driver SQLCipher
  disponibile non dimostra da solo protezione completa di database e file.
- Firma, notarizzazione, aggiornamento fra due release e Mac pulito non
  riverificati in questa tranche. Il test dell'updater simula Electron e feed.
- Lint globale ancora non verde per debito preesistente; restano 35 avvisi
  architetturali di dimensione e avvisi build sui chunk. Nessuna formattazione
  massiva dei file legacy è stata inclusa.
- La qualità delle decisioni del modello e la comprensibilità del flusso non
  sono certificate dal numero di test. Restano da analizzare con scenari reali,
  inclusi errori, ripresa dopo giorni e materiali che cambiano.

## Prossimo passo: uso reale e UX

Ripercorrere primo avvio, domanda semplice, lavoro con materiali, collaborazione,
revisione e ricorrenza. Per ogni scenario esplicitare obiettivo dell'utente,
passaggi richiesti, decisioni da confermare, risultato atteso e recupero dagli
errori. Confrontare chat, Compiti, Materiali e Documenti sulla stessa attività;
poi proporre interventi piccoli e verificabili. L'obiettivo è capire come si
porta a termine un lavoro, prima di ridisegnare le schermate.

La [guida d'uso](USO-HOMUN.md), la [matrice requisiti](specifications/STATO-IMPLEMENTAZIONE.md)
e il [confronto con Hermes](research/2026-09-23-hermes-homun-utilizzo.md) preparano
la discussione UX. L'integrazione su main è stata riverificata: 201 test frontend,
11 desktop e 534 motore + inventario complessivi (1 saltato), build/typecheck,
OpenAPI e architettura allineati. I risultati originari della tranche restano
nel rapporto, distinti dalla verifica di merge.
