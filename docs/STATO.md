# Stato verificato di Homun 2

Aggiornato il 20 settembre 2026 dopo la tranche «registro delle capacità»: fonte singola per le capacità del motore (vocabolario, versione tool, limiti, effetti), disponibilità interrogabile per attore, intake alimentato dal registro e profilo predefinito confermabile quando il roster è vuoto. Questo è il riferimento sintetico corrente; i rapporti in `research/` conservano prove e limiti delle singole tranche. I numeri sotto provengono dall'ultima verifica, non da esecuzioni ripetute durante l'aggiornamento documentale.

## Funziona nel perimetro verificato

- Motore Python persistente: comandi versionati, fingerprint/replay, transazioni, policy correnti, outbox e recovery DBOS.
- Sessione locale autenticata e legata all'identità del launcher; letture e replay filtrati secondo le policy implementate. Non equivale ad autenticazione multiutente esterna.
- Materiali gestiti con originali immutabili, ingestione e recupero; backup offline v2 di workspace, originali, DBOS e ricevute.
- Chat con storico persistito e contesto autorizzato; provider reale locale Qwen3.5:4b provato via API e nella GUI.
- **Distinzione domanda/lavoro:** il backend classifica senza stato (`POST /intake/classify`, solo persone) e il frontend instrada; una domanda viene risposta in chat senza creare lavori o collaboratori, una richiesta di risultato produce la proposta di accordo. Le precisazioni su una proposta in attesa restano lavoro; il default conservativo è lavoro; ogni errore di classificazione ricade sul percorso di proposta duraturo.
- Intake: richiesta conservata, titolo e obiettivo distinti, proposta di collaboratore reale o nuovo profilo, conferma prima dell'assegnazione. Creare un profilo non concede strumenti/accessi.
- **Accordo stabile nelle riformulazioni:** il modello dichiara i campi modificati (`changed_fields`) e il motore conserva strutturalmente gli altri dall'ultimo brief valido; cambiare solo il collaboratore non altera obiettivo, risultato, vincoli o capacità. Ogni proposta espone il diff calcolato dal backend (`changes`) e la scheda mostra «cosa cambia / cosa resta invariato».
- Scheda accordo e riepilogo coerenti: azioni offerte solo quando il backend le accetta (bozza senza piano/artifact), scheda storica marcata quando obiettivo o titolo divergono, nessuna sincronizzazione silenziosa.
- **Lettura non interrotta:** aggiornamenti e caricamenti non azzerano più lo storico; il transcript si ricarica solo a cambio lavoro o su richiesta esplicita, conservando il contenuto visibile.
- **Registro delle capacità:** fonte singola in `domain/capabilities.py` (id, tipo, versione tool, input/output, effetti, prerequisiti, limiti, timeout); il confronto CSV e la lettura attingono versione e limiti da lì; `GET /v1/workspaces/{ws}/capabilities` espone il catalogo con disponibilità reale per attore (materiali idonei leggibili); la sintesi dell'intake riceve il catalogo reale senza segnali di disponibilità; con roster vuoto o agente unico il motore applica un collaboratore confermabile deterministico.
- **Seconda capacità eseguibile — lettura materiale:** `read_material` (versionata `material-read-v1`) con proposta→approvazione→esecuzione DBOS→artifact di lettura (estratto limitato 8.000 caratteri, hash, provenienza) in revisione umana; fonte materiale condivisa con il confronto CSV (stessa verifica di identità/hash/permessi); cambio del materiale invalida l'approvazione; retry e riavvio non duplicano l'artifact. Scheda «Leggi un materiale» nella chat.
- **Confini della delega operativa (passo D completato):** l'approvazione dell'esecuzione di azioni concrete (confronto CSV, lettura materiale) richiede una persona, anche quando il proprietario del lavoro è l'agente delegato; i delegati hanno cap di budget propri (`BudgetAllocation`: limite e contatori per attore dentro la busta del lavoro, impostabili con `work.set_budget`, contatori spesi conservati) — un delegato esaurisce il proprio sub-cap senza toccare la busta degli altri; l'agente delegato con grant conduce turni di chat supervisionati sotto il proprio cap, le azioni restano approvazione umana.
- **Contesto autorizzato esteso (passo D):** quando la chat è legata a un lavoro, il contesto composto per il modello include un preambolo autorizzato e limitato — stato del lavoro, accordo confermato, riferimenti materiali (versione e hash, mai il contenuto) e memoria approvata pertinente — tracciato nel manifest (v2) e rivalidato prima di pubblicare effetti: un materiale che cambia versione invalida l'interpretazione in volo; i manifest legacy continuano a validare.
- **Budget per lavoro con riserve atomiche (passo D):** `WorkBudget` persistito (tentativi e token, cap predefinito 40 tentativi); riserva committe prima della chiamata al provider, riconciliazione con token reali o come incognito (mai zero), rilascio, recupero all'avvio dei pendini di processi morti; esaurimento tipizzato (`budget_exhausted`, HTTP 429), mai auto-risolto né auto-ritentato: si alza solo con `work.set_budget` esplicito. **Collegato a tutto il ciclo di modello del lavoro**: sintesi e classificazione dell'intake, interpretazione dei messaggi (tentativi di retry inclusi) ed estrazione del piano; le conversazioni senza lavoro restano fuori. `GET /works/{id}` espone i contatori.
- **Prompt esterni e multilingua:** i prompt vivono come file nel pacchetto (`engine/src/homun/prompts/`, it+en) caricati da uno store con fallback linguistico e sostituzione letterale dei segnaposto; la lingua del workspace è configurabile (`HOMUN_LANGUAGE`) e ogni richiesta può dichiararne una (`language` su intake); il classificatore domanda/lavoro rileva la lingua e il frontend la inoltra automaticamente alla proposta; i file prompt sono input di build e ricevuta del pacchetto desktop.
- Primo lavoro concreto: confronto deterministico di due listini CSV, approvazione dell'azione, report/CSV, revisione umana e recupero dopo riavvio senza duplicati.
- Riepilogo destro compatto, modifica esplicita, squadra reale nel percorso motore, diagnostica richiudibile.
- App Electron macOS arm64 con Python incorporato, archivio estratto e smoke autonomo verificati.

## Prove di riferimento

| Verifica | Ultima evidenza |
| --- | --- |
| Motore | 421 test passati, 1 saltato; warning Starlette/AnyIO |
| Frontend | 160 passati (routing domanda/lavoro con lingua, lifecycle transcript, diff intake, client lettura), typecheck e build web/prototipo riusciti |
| Desktop | 8 passati con motore incorporato |
| Architettura | 0 errori, 29 avvisi di dimensione legacy |
| Contratto API | OpenAPI allineata (intake con `changed_fields`/`changes`/`classify`+`language` e vocabolario `read_material`; catalogo capacità; route `material-reads`) |
| Modello reale | Qwen3.5:4b via API e GUI: domande → risposta in chat senza proposta; CSV → `compare_csv`; lettura documento → `read_material` con collaboratore; coordinamento → `general` (matrice 3/3); flusso lettura completo fino all'artifact in revisione; inglese esteso → brief in inglese; italiano → italiano; cambio solo collaboratore (brief identico, diff solo staffing); budget con token reali su intake (2303/203) e chat (440/114), esaurimento duraturo e 429, ripristino esplicito; risposta in chat ancorata a stato lavoro, riferimento materiale e accordo dal preambolo autorizzato |
| GUI | Browser su motore temporaneo: domanda pura → risposta e scheda «solo conversazione»; richiesta di lavoro → proposta; conferma, diff, storico integro; scheda «Leggi un materiale» con artifact pronto ed estratto |
| Pacchetto | Build desktop riuscita con prompt e nuovi moduli incorporati, CRC ZIP verificato, 8/8 test |

Build di riferimento: `dist/desktop/2026-09-20T12-09-11-805Z/Homun-darwin-arm64/Homun.app`.
ZIP: `dist/desktop/2026-09-20T12-09-11-805Z/Homun-0.1.0-macos-arm64.zip`.
SHA-256: `b1b75c3f8a9e7ab75269f9cb3409f5e855b0d71a646cbba3e974d19083c1543f`.

Vedi [prove complete e limiti della tranche confini della delega](research/2026-09-20-confini-delega.md), la [tranche contesto autorizzato](research/2026-09-20-contesto-autorizzato.md), la [tranche budget](research/2026-09-20-budget-lavoro.md), la [tranche lettura materiale](research/2026-09-20-lettura-materiale.md) e la [ricognizione Hermes e altri sistemi](research/2026-09-20-ricognizione-hermes-altri.md). Le build precedenti restano in `dist/desktop/` come prove storiche.

## Ancora aperto

- Il loop multi-tool generico (agente che compone più capacità in un turno) e le skill portabili restano da fare; le allocazioni di budget si impostano solo via comando/API (nessuna UI); un delegato senza allocazione esplicita spende dalla busta comune.
- Il budget copre il ciclo di modello del lavoro (intake, interpretazione, piano); restano fuori lo stream presentazionale e le chiamate senza lavoro. I ritardi di retry possono superare la stima prenotata di un'unità (documentato); nessuna stima preventiva di token; niente cap propri per delegati (arrivano con la delega operativa); il budget non è ancora nel riepilogo UI (solo via API).
- La scheda lettura carica un nuovo file; non seleziona materiali già presenti nel progetto (catalogo materiali nella UI da fare). La selezione della capacità da parte del 4B dipende dalle righe di esempio nel prompt: nuove capacità richiederanno esempi e riverifica della matrice.
- **Multilingua:** la UI resta italiana (i18n delle stringhe non richiesto); il contenuto del registro capacità è in italiano; con il modello locale 4B richieste molto brevi in altra lingua ricadono sulla lingua del template (limite del modello, non dell'infrastruttura); template oltre it/en da aggiungere con il fallback a protezione.
- Budget aggregati con riserve atomiche e loop operativo multi-tool (passo D): la lettura e il confronto sono due capacità isolate, non ancora una catena; la disponibilità del registro non è ancora consumata dalla UI.
- Qualità semantica della classificazione domanda/lavoro non certificata su corpus ampio; entrambi gli errori sono recuperabili e il default è conservativo (lavoro). Le risposte alle domande usano la pipeline di interpretazione esistente: una risposta osservata mostrava i «Candidati» del roster in coda (formato preesistente da raffinare).
- La classificazione e la sintesi del brief non vedono lo storico conversazionale precedente (contesto autorizzato = passo D); una chiamata di classificazione in più per i primi messaggi che richiedono un accordo.
- Qualità semantica della classificazione `changed_fields` non certificata su corpus ampio: la garanzia strutturale è engine-side, ma una precisazione male interpretata può conservare troppo (recupero con nuova precisazione) o mostrare nel diff un campo non inteso (mai applicato senza conferma). I valori sconosciuti sono scartati senza audit dell'eco del modello.
- Il ciclo di refresh ha test automatici di politica (modulo puro) e verifica GUI, ma non un test mount/unmount React dedicato; l'upload file in GUI non è automatizzabile col browser in-app (file chooser non supportato).
- Loop operativo multi-tool, budget aggregati atomici, delega estesa e skill portabili. `general` indica preparazione; `compare_csv` è la capacità concreta provata.
- Parità completa fra superfici UI e motore: restano funzioni del prototipo e debito strutturale.
- Cifratura operativa e recupero chiavi, Keychain, identità multiutente/peer, contratto di upgrade/rollback DBOS.
- Firma Developer ID, notarizzazione, aggiornamenti/rollback, Mac pulito e altre piattaforme. Il candidato locale non è una release certificata.

## Da dove continuare

La [specifica di passaggio](handoff/2026-09-19-ripresa-sviluppo-homun.md) resta la mappa: priorità B e C completate; **passo D completato** (budget con riserve atomiche su tutto il ciclo di modello, cap per delegati, contesto autorizzato esteso con rivalidazione identità, delega operativa delimitata con approvazioni umane). Prossimo passo naturale: il loop multi-tool generico (composizione di capacità in un turno con approvazione per effetto) e le skill portabili. La [ricognizione aggiornata di Hermes e degli altri sistemi](research/2026-09-20-ricognizione-hermes-altri.md) (snapshot `6882320d5909`) raffina il design del passo D (contatori granulari inclusi token di cache, cap propri per delegati, riconciliazione delta/cumulativa, fallire-in-chiuso sulle approvazioni configurabili) e conferma: transcript canonico immutabile, memoria come versioni con diff, proposta-prima-di-esecuzione. L'architettura Pydantic AI + DBOS non è cambiata.

I rapporti precedenti sono fotografie storiche: i conteggi di test, gli hash dei pacchetti e i problemi allora aperti non vanno letti come stato corrente. Non cancellare queste prove né sostituirne i risultati con numeri di altre esecuzioni.

