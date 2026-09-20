# Verifica GUI nativa e recupero dello storico

> **Rapporto storico / ricerca datata.** Le prove, i conteggi, gli artefatti e i limiti descritti sono riferiti a questa tranche, non allo stato finale della giornata. Per implementazione e problemi ancora aperti consultare lo [stato verificato corrente](../STATO.md); per riprendere il lavoro usare la [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md). Le proposte qui contenute non sono automaticamente tutte implementate.

19 settembre 2026. Verifica svolta nella finestra Electron reale con i controlli
nativi del Mac, dopo lo sblocco del desktop. Nessun commit, push o distribuzione.
La conversazione sintetica «Verifica GUI: il colore scelto…» resta visibile nel
profilo locale per consentire di ripetere la prova. Il provider già configurato
era Ollama locale, `qwen3.5:4b`; non è stato sostituito con il fake.

## Inventario e risultati osservati

| Controllo | Esito |
|---|---|
| Avvio del bundle, finestra iniziale, stato motore | Finestra aperta, motore pronto, composer e navigazione visibili |
| Impostazioni → Modelli → Verifica connessione | Connessione locale confermata; dialogo scorrevole con chiusura accessibile |
| Primo messaggio di prova sul colore blu | Risposta reale: «Conferma: il colore scelto per il catalogo di prova è blu.» |
| Domanda successiva senza ripetere il colore | Risposta reale: «Blu.» |
| Chiusura completa e riapertura, prima della correzione | Lavoro presente, storico non caricato: appariva un riepilogo tecnico |
| Riapertura del pacchetto corretto | Messaggi originali ripristinati in ordine; nessun riepilogo artificiale |
| Nuova domanda dopo riapertura | Risposta reale: «Blu.»; continuità del contesto osservata |
| Due ricariche consecutive | Nessun duplicato o perdita dei sei messaggi |
| Seconda chiusura completa e riapertura | Conversazione selezionata e sei messaggi ripristinati automaticamente |
| Elenco, Kanban, calendario | Il lavoro di prova è presente; calendario lo elenca senza scadenza |
| Ricerca senza corrispondenze | Stato vuoto esplicito |
| Pannello dettagli | Chiusura e riapertura funzionanti |
| Raccolta materiali vuota | Navigazione e stato vuoto visibili; ingestione non esercitata in questa prova |
| Provenienza chat | «Fonte: motore · archivio locale», identità «Sessione locale · Fabio» |

Le schermate sono state ispezionate tramite acquisizione nativa, alla dimensione
iniziale della finestra; non sono prove di accettazione su altre risoluzioni.
La cronologia e il pannello dettagli hanno scroll interno, mentre composer e
controlli principali restano raggiungibili. L'app corretta viene lasciata aperta.

## Difetti corretti

Il frontend conservava i turni solo in un overlay React. Al riavvio recuperava il
lavoro, ma non i messaggi dal motore, sostituendoli con una risposta tecnica fittizia.

La nuova route `/v1/workspaces/{workspace_id}/conversations/{conversation_id}/messages`
legge il transcript persistito in ordine canonico, con paginazione, controllo della
conversazione e di tutti i lavori collegati, filtro delle fonti autorizzate,
soppressione dei duplicati e controlli workspace/conversazione. Anche una pagina
senza righe visibili avanza il cursore. OpenAPI aggiornato: 43 percorsi.

Il client carica soltanto la conversazione selezionata. Gli errori sono espliciti,
le richieste obsolete vengono annullate e una ricarica negata elimina i dati
precedentemente mostrati. Durante il caricamento il composer è disabilitato; lo
stato di attesa non è un messaggio della cronologia. La selezione iniziale aspetta
il caricamento dell'elenco prima di verificare l'esistenza del lavoro.

I metadati UI di memoria salvata e proposta risolta sono mantenuti separatamente
per ID del messaggio e riapplicati soltanto alle righe ancora autorizzate. Le azioni
su proposte con versione superata sono nascoste, mantenendo il testo storico.
Questi metadati UI non costituiscono un nuovo registro durevole delle approvazioni:
la loro persistenza fra processi resta fuori da questa correzione.

Sono corretti anche il footer erroneamente etichettato «Demo» nella chat motore,
il selettore di persona demo mostrato nella sessione reale e la race per cui il
finally di una richiesta vecchia poteva segnare inattiva una richiesta nuova.

La logica di inventario e caricamento è in due hook dedicati. `useEngineWorkspace`
scende da 527 a 513 righe; `ConversationWorkspace` resta a 1459. Il budget
architetturale è stato abbassato, senza allargare le soglie.

## Verifiche tecniche e artefatto

- Motore: **340 passati, 1 Mem0 live saltato**, una deprecazione preesistente.
- Frontend: **127 passati**, typecheck e build web/prototipo riusciti.
- Desktop: **8 passati** usando il nuovo binario incorporato.
- Architettura: **0 errori, 30 avvisi preesistenti**; OpenAPI senza drift;
  `git diff --check` pulito.
- ZIP estratto: smoke autonomo riuscito, hash/CRC, inventario del motore e quattro
  moduli shell verificati. Questo smoke usa fake esplicito in un profilo temporaneo,
  distinto dalla prova GUI con Qwen reale descritta sopra.

Pacchetto:
`dist/desktop/2026-09-19T11-24-26-143Z/Homun-0.1.0-macos-arm64.zip`

181.740.730 byte; SHA-256
`62d515fcce1a355d50e969db53f596ec0912135a434324957110caefe56d1c03`.

Ricevuta motore SHA-256:
`e25e7f03beec33440035cefd9a806b87d0d324dc80e7531b5f03edc50a61b5e4`.

Sostituisce il candidato 11-06 per questa correzione. Il candidato intermedio
11-23 non include l'ultima correzione dei metadati UI e non è quello consegnato.
Log locali `/tmp/homun-gui-{engine,web,desktop,package,archive}.log`.

## Limiti della verifica

È passata la prova GUI del percorso chat e delle viste elencate, non l'accettazione
di ogni funzione del prodotto. Firma, notarizzazione, installazione su Mac pulito,
Keychain e provider cloud restano da verificare. La prova Qwen attesta questo caso
conversazionale, non una valutazione generale della qualità del modello.

Gli aspetti UX allora osservati (titolo derivato dalla richiesta, pannello denso e diagnostica invasiva) sono stati affrontati nella [consegna intake successiva](2026-09-19-conversational-intake-ux-verification.md), che ne documenta anche i limiti residui.
Materiali, automazioni, plugin e altre superfici del prototipo richiedono verifiche
specifiche del collegamento al motore prima di considerarli funzionalità complete.
