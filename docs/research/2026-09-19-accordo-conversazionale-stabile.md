# Accordo conversazionale stabile — consegna e verifica

**Data:** 19 settembre 2026 (tranche successiva a `2026-09-19-conversational-intake-ux-verification.md`).
**Perimetro:** priorità B della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md): rendere stabile l'accordo conversazionale.
**Branch:** `fabio/production-foundations`, working tree con l'implementazione precedente intatta più questa tranche.

## Cosa cambia, prima e dopo

1. **Cambiare collaboratore non altera più l'accordo.**
   - Prima: la conservazione di titolo/obiettivo/risultato/vincoli/capacità durante una precisazione sul collaboratore dipendeva solo dalle istruzioni del prompt; se il modello riscriveva l'obiettivo, il motore lo accettava.
   - Dopo: il modello dichiara `changed_fields` (campi che la precisazione modifica esplicitamente fra `title, objective, output, constraints, capability, staffing`); **il motore** conserva i campi non dichiarati dall'ultimo brief valido (ancoraggio all'ultima proposta con obiettivo non vuoto). Anche se il modello restituisce testo diverso per i campi non dichiarati, quel testo viene scartato. Nessuna keyword hardcoded del caso cancelleria: è un contratto generico per campo.
2. **Diff esplicito calcolato dal backend.** Ogni proposta espone `changes` (elenco `{field, from_value, to_value}` rispetto al brief precedente, vuoto alla prima proposta). La scheda in chat mostra «Cosa cambia rispetto alla proposta precedente» e l'elenco dei campi che restano invariati. La verità è il diff calcolato dal motore, non l'autodichiarazione del modello (un campo dichiarato ma identico non compare nel diff).
3. **Scheda accordo e riepilogo coerenti.**
   - «Rivedi l'accordo» ora rispetta il vincolo backend (bozza senza piano e senza artifact): il bridge legge `current_plan_revision`/`current_artifact_version` dall'API lavori. Quando il lavoro è avviato, la scheda lo dice invece di offrire un'azione che il backend rifiuterebbe.
   - Se obiettivo o titolo sono stati modificati dopo la conferma, la scheda accordo è marcata come storica («il riepilogo a destra mostra la versione aggiornata»); nessuna sincronizzazione silenziosa.
4. **Caricamenti e aggiornamenti non interrompono la lettura.**
   - Prima: ogni refresh dell'inventario (dopo un messaggio, un caricamento, una conferma) azzerava lo storico visibile finché il GET del transcript non tornava (chat vuota, composer disabilitato, scroll azzero, doppio ciclo per il toggle `busy`).
   - Dopo: il transcript si ricarica solo a cambio lavoro/conversazione o su sequenza esplicita; durante il ricaricamento dello stesso lavoro il contenuto precedente resta visibile. La politica è un modulo puro (`engine-transcript-lifecycle.ts`) con test dedicati. Il segnaposto «Homun sta elaborando…» non resta mai appeso nel percorso intake.

Invariati: proposta → conferma prima dell'assegnazione; approvazione separata dell'azione concreta; richiesta originale e cronologia conservate; `Fonte: motore` esplicito; nessun nuovo orchestratore (Pydantic AI + DBOS invariati).

## Moduli

| Modulo | Ruolo |
| --- | --- |
| `engine/src/homun/models/intake.py` | `IntakeBrief.changed_fields` (Literal) + prompt aggiornato |
| `engine/src/homun/application/intake_brief.py` | nuovo: carry-over engine-side, conservazione staffing azionabile, diff |
| `engine/src/homun/application/intake.py` | stabilizzazione in `propose`, `changes` nella proposta |
| `engine/src/homun/routes/intake.py`, `contracts/openapi/v1-engine.json` | contratto esteso con default retrocompatibili (proposte vecchie senza i campi restano valide) |
| `apps/web/src/lib/engine-intake-display.ts` | nuovo: presentazione italiana del diff + gate «accordo rivedibile» |
| `apps/web/src/components/builder/EngineWorkIntake.tsx` | «Cosa cambia», gate azioni, marcatura storica |
| `apps/web/src/lib/conversation-engine-bridge.ts`, `conversation-types.ts` | esposizione `enginePlanRevision`/`engineArtifactVersion` |
| `apps/web/src/lib/engine-transcript-lifecycle.ts` | nuovo: politica pura di ricaricamento del transcript |
| `apps/web/src/hooks/useEngineTranscript.ts` | ricarica per valore (non per identità array), contenuto conservato, overlay eliminato solo a stream concluso |
| `apps/web/src/hooks/useEngineWorkspace.ts` | sequenza di reload esplicita dopo `refresh`; rimozione segnaposto parziale nel percorso intake |

## Prove eseguite (distinte per tipo)

**Test deterministici motore** (`engine/tests/test_intake.py`, 28 passanti di cui 5 nuovi):
cambio solo collaboratore con modello che riscrive tutto (i campi vengono comunque conservati, conferma assegna il nuovo agente e preserva reviewer/obiettivo/titolo); cambio obiettivo esplicito (solo i campi dichiarati cambiano, il diff elenca esattamente quelli); `changed_fields` con valore sconosciuto → `intake_invalid_response`; prima proposta senza ancoraggio (`changes` vuoto); precisazione senza collaboratore su lavoro CSV → staffing dell'accordo conservato e confermabile.
Suite motore completa: **377 passati, 1 saltato** (baseline 372 + 5).

**Test frontend** (149 passanti, 12 nuovi): politica del transcript (`tests/engine-transcript-lifecycle.test.ts`: refresh inventario ≠ reload; reload stesso lavoro conserva contenuto; cambio lavoro pulisce prima di caricare; sequenze duplicate non ciclano; overlay eliminato solo senza turni parziali), presentazione del diff e gate rivedibilità (`tests/engine-intake-display.test.ts`), parsing revisioni piano/artifact nel bridge. Typecheck, build web e prototipo, controllo architettura (0 errori, 29 avvisi legacy invariati) e `git diff --check` puliti. OpenAPI rigenerata e verificata con `--check`.

**Modello reale via API** (profilo temporaneo, provider locale Qwen3.5:4b su `127.0.0.1:11434`):
prima proposta valida (titolo/obiettivo/output/vincoli/capacità coerenti, `changes` vuoto); conferma; precisazione «Affida il lavoro a Ada invece di Bruno, per il resto va bene così» → proposta con titolo/obiettivo/output/vincoli/capacità **identici** all'accordo confermato e `changes` esattamente `staffing: Bruno → Ada`; precisazione esplicita sul risultato («solo il CSV, senza report») → obiettivo e output aggiornati, titolo/vincoli/capacità invariati, diff esatto; conferma finale con owner Ada, reviewer Fabio conservato, lavoro ancora bozza senza piano.

**GUI (browser sull'app web, motore temporaneo):** lavoro confermato mostrato con scheda ACCORDO DI LAVORO e riepilogo destro allineati (stesso titolo/obiettivo/responsabile); nuova conversazione con richiesta reale → proposta; «Modifica la proposta» con sola richiesta di cambio collaboratore → sezione «Cosa cambia rispetto alla proposta precedente: Collaboratore: Bruno → Ada» con «Restano invariati: Titolo, Obiettivo, Risultato atteso, Vincoli, Attività»; conferma → assegnazione ad Ada, titolo aggiornato nella lista, storico chat integro (entrambi i messaggi utente, nessun segnaposto appeso, nessun azzeramento dopo i refresh).

**Pacchetto:** `npm run desktop:build` riuscito; **8 test desktop passati** col motore incorporato (`HOMUN_TEST_ENGINE=dist/engine/homun-engine`); CRC ZIP verificato.

## Build di riferimento

- App: `dist/desktop/2026-09-19T14-06-25-720Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-19T14-06-25-720Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `6719feca86bd4997010462e9ac6d679f59a4e8272ea81b7b4b42fa7c72ae6df1`
- Non firmato Developer ID e non notarizzato: candidato locale, non una release.

La build precedente in `dist/desktop/2026-09-19T12-50-30-931Z/` resta come prova storica della tranche precedente.

## Limiti rimasti

- La classificazione `changed_fields` dipende dal modello; la garanzia strutturale (conservazione engine-side) è deterministica, ma una precisazione male interpretata può conservare troppo (recupero: nuova precisazione) o — se il modello dichiara un campo che la persona non intendeva cambiare — mostrare il cambiamento nel diff prima della conferma, mai applicarlo in silenzio. Qualità semantica non certificata su corpus ampio.
- La distinzione domanda/clarimento/nuovo lavoro (evitare che un saluto diventi una bozza di lavoro) resta aperta: richiede il piccolo design previsto dal passaggio e non è stata compressa in questa tranche.
- Il carry-over dell'ancoraggio usa l'ultima proposta con obiettivo non vuoto (anche superata): per la catena di precisazioni è il comportamento voluto, ma non c'è ancora una nozione esplicita di «versione del brief» numerata esposta all'utente.
- L'upload di file nella GUI non è automatizzabile col browser in-app usato (file chooser non supportato): la continuità di lettura durante i caricamenti è coperta dallo stesso percorso di refresh provato dopo messaggi/conferme e dai test di politica, non da una prova diretta di upload.
- La posizione di scroll non è misurata automaticamente; i meccanismi che la azzzeravano (svuotamento dello storico) sono stati rimossi e osservati assenti in GUI.
- I limiti strutturali precedenti restano: budget aggregati, registro capacità generale, cifratura, firma/notarizzazione, identità multiutente, parità UI/prototipo.

## Riproduzione della prova con modello reale

1. Avviare il provider locale (Ollama con `qwen3.5:4b`).
2. `HOMUN_DATA_DIR=<dir temporanea> engine/.venv/bin/python -m homun serve --host 127.0.0.1 --port 8765 --dev-insecure`.
3. `npm run dev` e aprire l'URL proposto.
4. Nuova conversazione → richiesta di confronto listini → «Modifica la proposta» → «Affidalo a <altro agente>…» → verificare la sezione «Cosa cambia» → confermare.

Il profilo temporaneo usato nella verifica (`/tmp/homun-b1-verify`) è effimero: i valori salienti sono riportati sopra. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
