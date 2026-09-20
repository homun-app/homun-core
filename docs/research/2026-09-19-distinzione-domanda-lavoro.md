# Distinzione domanda/lavoro — consegna e verifica

**Data:** 19 settembre 2026, tranche successiva ad [accordo conversazionale stabile](2026-09-19-accordo-conversazionale-stabile.md).
**Perimetro:** completamento della priorità B della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md): una semplice domanda deve poter restare una domanda.
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## Design (prima del codice, come richiesto dal passaggio)

Due percorsi già esistenti e completi: la conversazione (`/commands/stream` → `conversation.post_message` → interpretazione → risposta persistita e mostrata in streaming) e l'intake (`propose` → brief → conferma). Il difetto era l'instradamento fisso: ogni primo messaggio di un lavoro senza accordo confermato diventava una proposta di lavoro, sia da `postMessage` sia dalla creazione stessa della conversazione (`createIntakeConversation` proponeva sempre).

Scelte fatte, per non creare una seconda pipeline:

1. **La classificazione è del backend, senza stato.** Nuovo endpoint `POST /works/{id}/intake/classify` (solo persone con accesso in scrittura): restituisce `work_request | question`. Non persiste nulla: il testo duraturo vive nel transcript del percorso scelto dal chiamante. Se esiste una proposta in attesa, il classificatore ne vede titolo e obiettivo per riconoscere le precisazioni come `work_request`. Prompt con default conservativo: nel dubbio `work_request` (una domanda può sempre essere risposta, un lavoro non deve dissolversi in chiacchierata).
2. **Il frontend instrada, non decide da solo.** `resolveFirstMessageRoute` (pura, testata) + `routeEngineFirstMessage`/`classifyFreshRequest`: accordo confermato o lavoro legacy → chat diretta; serve accordo → classifica; `question` → percorso conversazionale esistente con streaming; altrimenti → `propose` come prima. Ogni errore di classificazione ricade su `propose`, che espone i propri errori tipizzati duraturi. L'instradamento è stato collegato sia a `postMessage` sia alla creazione della conversazione (il gap trovato in verifica: la prima schermata forzava comunque la proposta).
3. **La scheda senza proposta è onesta.** Una conversazione con messaggi ma senza proposta mostra «Qui stiamo scambiando domande e risposte: nessun lavoro è stato avviato…» invece del fuorviante «La richiesta non è stata elaborata».

Nessun nuovo stato del contratto intake, nessuna generazione di risposte dentro il flusso intake, nessuna doppia persistenza del messaggio.

## Moduli

| Modulo | Ruolo |
| --- | --- |
| `engine/src/homun/models/intake.py` | `RequestClassification` + `classify_request` (prompt di routing) |
| `engine/src/homun/application/intake.py` | `classify_message`: gate persona/scrittura, contesto proposta in attesa, modello fuori transazione |
| `engine/src/homun/routes/intake.py`, `contracts/openapi/v1-engine.json` | `POST /intake/classify`, errori tipizzati 503 (`intake_invalid_response`, `provider_unavailable`) |
| `apps/web/src/lib/engine-first-message-routing.ts` | nuovo: decisione pura + instradamento con ricaduta sicura |
| `apps/web/src/lib/engine-intake-creation.ts` | la prima richiesta da nuova conversazione passa dal routing |
| `apps/web/src/lib/engine-intake-client.ts` | `classifyWorkIntake` + `resolveFirstMessageRoute` |
| `apps/web/src/hooks/useEngineWorkspace.ts` | `postMessage` classifica prima di forzare la proposta |
| `apps/web/src/components/builder/EngineWorkIntake.tsx` | scheda «solo conversazione» in assenza di proposta |

## Prove eseguite (distinte per tipo)

**Deterministiche motore** (381 passati, 1 saltato; 4 nuovi in `test_intake.py`): classificazione domanda non persiste nulla; classificazione lavoro e contesto `pending_brief` passati al modello; gate persona/agent e testi vuoti; risposta invalida → `intake_invalid_response`; contratto HTTP 200/503 stateless.

**Frontend** (153 passati; nuovi: trasporto classify con errore tipizzato, matrice di routing — confermato→chat, nuova richiesta senza classificazione→propose, domanda→chat con o senza proposta in attesa, lavoro→propose, provider giù→ricade su propose, legacy→chat senza roundtrip extra; routing della prima richiesta di un lavoro appena creato). Typecheck, build web/prototipo, architettura 0 errori/29 avvisi (il hook `useEngineWorkspace` è stato tenuto sotto la soglia di revisione estraendo l'instradamento), `git diff --check` puliti, OpenAPI rigenerata e verificata.

**Modello reale via API** (profilo temporaneo, Qwen3.5:4b): «Quanto spendiamo di solito ogni mese per la cancelleria?» → `question`; «Ciao! Mi puoi aiutare?» → `question`; richiesta di confronto listini → `work_request`; con proposta in attesa, «Affidalo a Bruno invece del profilo nuovo» → `work_request` (precisazione) e «Ma il report sarà in italiano o in inglese?» → `question` (domanda laterale). Durante la prova una sintesi del brief è fallita con `intake_invalid_response` (JSON invalido dal modello piccolo): il flusso di recupero ha prodotto una proposta valida al tentativo successivo — comportamento previsto, nessuna assegnazione.

**GUI (browser su motore temporaneo):** domanda pura da nuova conversazione («Che differenza c'è tra un report e un riepilogo? Volevo solo capirlo, niente lavoro.») → risposta reale in chat, nessuna proposta, nessun collaboratore, scheda «qui stiamo scambiando domande e risposte», riepilogo coerente; richiesta di lavoro vera nella stessa conversazione → proposta di accordo con capacità CSV e collaboratore esistente, «Conferma e affida» disponibile, Q&A precedente conservato nello storico. Nota di metodo: in questa sessione del browser in-app il tasto Invio e alcuni click non venivano consegnati (artefatto dell'ambiente, riprodotto anche su flussi preesistenti); l'invio è stato eseguito con il submit nativo del form, che attraversa gli stessi gestori dell'applicazione.

**Pacchetto:** build desktop riuscita, **8/8 test** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-19T21-32-29-264Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-19T21-32-29-264Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `6183e614060d039600d85e4821e1fc669102249132215edcdf0f165a26ee7a2f`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Limiti rimasti

- La classificazione è un modello piccolo: può sbagliare. Entrambe le direzioni sono recuperabili (una domanda trattata come lavoro mostra una proposta non confermata; un lavoro trattato come domanda viene risposto e resta da ri-formulare), e il default conservativo è `work_request`. Qualità non certificata su corpus ampio.
- Le risposte alle domande usano la pipeline di interpretazione esistente: una risposta osservata ha mostrato in coda l'elenco dei «Candidati» del roster — formato preesistente, non introdotto da questa tranche, da raffinare quando si lavora sulla qualità delle risposte.
- Il contesto della classificazione include solo il testo e l'eventuale proposta in attesa, non lo storico della conversazione: dopo una domanda, la sintesi del brief della richiesta successiva non vede lo scambio precedente (contesto autorizzato = passo D).
- Costo: una chiamata di classificazione in più per i primi messaggi che richiedono un accordo; per le domande la risposta non è mostrata in streaming nel percorso di creazione.
- Il test del ciclo mount/unmount React resta aperto; l'upload file in GUI non è automatizzabile col browser in-app.

## Riproduzione della prova con modello reale

Come nella tranche precedente (provider locale Qwen3.5:4b, `HOMUN_DATA_DIR` temporaneo, `--dev-insecure`, `npm run dev`): nuova conversazione → domanda esplicita («…volevo solo capirlo, niente lavoro») → risposta in chat senza proposta; poi una richiesta di risultato nella stessa conversazione → proposta di accordo. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
