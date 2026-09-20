# Demo reale: confronto listini locali

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

## Materiali e comportamento

Dati interamente sintetici in `demo/price-comparison`: 16 righe in agosto, 15 in settembre. L’oracolo `expected-results.json` è specificato indipendentemente dal motore. Nessun documento di clienti e nessun invio dei CSV a servizi esterni.

La chat crea il lavoro. La scheda dedicata acquisisce due CSV attraverso l’ingestione gestita dei materiali e propone una singola azione. L’utente conferma una proposta legata a revisione del lavoro, versione dello strumento, SHA-256 e versioni dei materiali. DBOS esegue il confronto deterministico; pubblicazione di artifact, messaggio e risultato nella stessa transazione. Stato finale `review`, non accettazione umana automatica.

Moduli separati: calcolo CSV; policy su fonti e autorizzazioni; proposta/approvazione; esecuzione/pubblicazione; workflow DBOS; route HTTP; client, hook e scheda React. Riutilizzati dominio Work/Plan/Artifact, CommandRecord, ingestione, repository e transcript.

## Prova nella finestra nativa

Il 19 settembre 2026 la build nativa è stata aperta usando il profilo locale esistente. Creata la conversazione “Demo confronto listini agosto-settembre…”, caricati entrambi i CSV con il selettore nativo, premuto “Prepara il confronto”.

L’app è stata chiusa mentre la proposta attendeva approvazione. Alla riapertura i due file e il pulsante “Approva ed esegui confronto” erano ancora presenti: nessuna esecuzione anticipata. Dopo approvazione sono comparsi il messaggio Homun, il report leggibile e lo stato `review`.

Risultato: **4 aumenti, 3 ribassi, 2 invariati, 3 nuovi, 3 rimossi, 3 SKU esclusi; 4 segnalazioni di anomalia**. Verificati prezzo zero con percentuale non calcolabile, SKU distinti per maiuscole/minuscole, duplicati, prezzo mancante e valuta EUR/USD senza conversione.

Scaricati dalla GUI `confronto-listini.md` e `confronto-listini.csv` direttamente nella cartella demo. I file scaricati coincidono con il risultato persistito dal motore. Verificato il CSV contro l’oracolo: tutti gli SKU, stati, prezzi, delta e percentuali corrispondono.

Identificatori della prova locale: work `work_yhkl-mtjhGzqaw`, proposta `502f9db9-9089-4201-8b0b-185ff124ae18`, artifact `art_1yjHU0x1-7R2jg`. Prima della seconda riapertura: un tentativo, un artifact, un messaggio di risultato.

## Difetti corretti durante la verifica

- Proposta obsoleta bloccava la sostituzione: una nuova proposta rende obsoleta quella precedente, senza riusarne l’approvazione.
- CSV invalido lasciava il lavoro in esecuzione: fallimento e stato lavoro/step vengono aggiornati insieme; un nuovo input può essere proposto.
- Pubblicazione tardiva: verificati stato e numero del tentativo oltre alla revisione e ai permessi correnti.
- Lettura blob: limite di 2 MiB applicato prima del calcolo e della verifica hash.
- Risposta POST persa: il client recupera la proposta persistita con lo stesso ID prima di ricaricare una nuova revisione.
- Autore del messaggio di risultato esplicitamente `homun_engine`.
- GUI: progetti del motore proiettati nella navigazione; pannello lavoro del motore separato dai comandi di simulazione.

## Limiti concreti

Questa è una capacità esplicita locale, non selezione automatica di strumenti da parte del modello. CSV UTF-8 con colonne `sku,name,price,currency`, virgola o punto e virgola, prezzi con punto decimale. Limiti: 2 MiB per file, 10.000 righe combinate e 3 tentativi. Sono limiti operativi, non un budget monetario universale. Il confronto non chiama un modello; la chat iniziale usa il provider configurato.

Il report rimane da revisionare. La build macOS è locale non firmata per distribuzione pubblica. La verifica di questa capacità non costituisce accettazione delle altre sezioni ancora derivate dal prototipo.

## Verifica finale e build

Seconda riapertura con la build finale: progetto “Confronto listini” visibile nella sidebar, collegamento progetto → lavoro funzionante, messaggio/report recuperati, pannello destro con fonte motore e stato `review`, nessuna azione di simulazione. Lettura indipendente del database dopo il riavvio: ancora un tentativo, un artifact e un messaggio di risultato.

- Motore: 348 passati, 1 integrazione opzionale saltata; un avviso di deprecazione Starlette/AnyIO.
- Frontend: typecheck e 133 test passati; build web e prototipo riuscite. Avviso Vite sui bundle grandi ancora presente.
- Strumento CSV: 22 test passati.
- Desktop: 8 test passati con il binario confezionato.
- Architettura: 0 errori, 30 avvisi dimensionali preesistenti. Nessun aumento delle soglie (Workspace 1459 righe, useEngineWorkspace 513).
- OpenAPI allineata; git diff --check pulito.
- Archivio finale estratto e verificato: CRC ZIP, SHA-256, inventario motore, byte dei moduli shell e smoke del motore isolato senza Python esterno.

Build locale: `dist/desktop/2026-09-19T12-00-46-318Z/Homun-0.1.0-macos-arm64.zip`, 184929388 byte.
SHA-256: `ceb5b3db7e9a16810442171a5638e84015892208a912e5d2d3d8bff2b15d57d5`.
Ricevuta input motore: `863453bf533224e82fb50e3d50a4595c53eae7ac6d3c0dad41a6c66cadaca380`.

Nessun commit, push o pubblicazione effettuato. L’app è stata lasciata aperta sulla conversazione della demo.
