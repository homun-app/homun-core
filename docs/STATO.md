# Stato verificato di Homun 2

Aggiornato il 23 settembre 2026 con la tranche operativa successiva ad
`a2d420c8`. Lo stato precedente e i rapporti datati conservano le prove storiche.
Una verifica del sorgente non aggiorna l'app installata.

## Capacità presenti

- Motore Python persistente con comandi versionati, autorizzazioni, materiali,
  artifact, piani, budget, outbox e workflow DBOS.
- Chat supervisionata: domanda oppure proposta di lavoro, accordo confermato,
  Homun diretto o collaboratore scelto, piano per fasi, approvazione degli effetti e revisione
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

- Uso diretto senza creazione obbligatoria di bot; `agent_run` esegue un ciclo
  adattivo su materiali autorizzati, con osservazioni persistite e chiarimenti.
- Onboarding aziendale opzionale, proposta di squadra confermata, contesto usato
  nelle richieste successive e consultazioni dei collaboratori nel lavoro.
- Destinatari nominativi e portale temporaneo per contributi testuali; una risposta
  può far riprendere il ciclo adattivo. Identità dichiarata, non account verificato.

## Evidenze della tranche corrente

Il [rapporto operativo](research/2026-09-23-homun-operativo-verifica.md) distingue
prove automatiche, modello locale reale e limiti. Suite: 608 motore passati e 1
saltato, 211 web, 11 desktop; typecheck/build web e prototipo, OpenAPI e architettura
allineati (0 errori, 35 avvisi). La prova browser usa un profilo sintetico separato.
Il [consolidamento precedente](research/2026-09-23-consolidamento-verifica.md)
resta una fotografia distinta.

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

I due ingressi — richiesta diretta e squadra aziendale — sono presenti nel
perimetro del rapporto operativo. Il ciclo resta limitato ai materiali selezionati:
web, shell, MCP generici, agenti pronti e collaborazione distribuita sono aperti.
Il confronto listini è una fixture tecnica, non il posizionamento.

La [guida](USO-HOMUN.md), la [matrice requisiti](specifications/STATO-IMPLEMENTAZIONE.md)
e gli scenari del [rapporto](research/2026-09-23-homun-operativo-verifica.md)
preparano l'analisi UX: ridurre passaggi, chiarire responsabilità e rendere semplice
riprendere il lavoro. La qualità va misurata con utenti del target, non dedotta
dai test. Il [confronto Hermes](research/2026-09-23-hermes-homun-utilizzo.md)
conserva lo snapshot di ricerca e rinvia alle implementazioni successive.
