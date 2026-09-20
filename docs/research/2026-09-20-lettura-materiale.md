# Seconda capacità: lettura autorizzata di un materiale — consegna e verifica

**Data:** 20 settembre 2026, tranche successiva a [prompt esterni e multilingua](2026-09-20-prompt-esterni-multilingua.md).
**Perimetro:** slice C2 della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md): aggiungere un solo caso locale limitato — lettura autorizzata di un materiale e produzione di un artifact — riusando policy, digest, fonti immutabili, esecuzione DBOS e ricevute del confronto CSV, senza creare una seconda pipeline.
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## Cosa è stato costruito

1. **Capacità `read_material` nel registro** (`domain/capabilities.py`): eseguibile, `tool_version 'material-read-v1'`, input (un materiale attivo gestito: testo, CSV o PDF), output (artifact di lettura), effetti espliciti (artifact in revisione umana; nessun invio esterno; il materiale non viene modificato), prerequisiti (intake confermato con questa capability; lettura del progetto del materiale), limiti (2 MiB, 8.000 caratteri di estratto, 3 tentativi), timeout. Il vocabolario intake l'ammette (`compare_csv | read_material | general`) con test di sincronizzazione registro↔trasporto.
2. **Fonte condivisa** (`materials/source.py`): la verifica materiale (attivo, gestito, entro i limiti, hash del blob verificato, lettura del progetto autorizzata) è uscita da `price_comparison_policy` ed è ora un modulo unico riusato dal confronto CSV e dalla lettura: la stessa decisione, un solo posto.
3. **Percorso speculare al CSV**: `application/material_reads.py` (proposta transazionale con digest su `{id, work, versione, tool, materiale{id,titolo,sha256,versione}, limiti, azione}`, approvazione esplicita di owner/reviewer con rivincita del binding, una sola lettura attiva per lavoro), `application/material_read_execution.py` (esecuzione deterministica: rilegge il blob, riverifica l'hash, estrae il testo con l'estrattore esistente, pubblica l'artifact con provenienza — file, formato, byte, SHA-256, versione, estratto limitato — e messaggio in conversazione; budget tentativi e fallimenti bloccati/failed come il CSV), `runtime/workflows/material_read.py` (workflow DBOS con id stabile `read:{ws}:{id}`, step con retry, recovery all'avvio nel lifecycle e nella pompa del dispatcher).
4. **Fallback collaboratore esteso**: capacità eseguibile senza collaboratore proposto dal modello → roster vuoto ⇒ profilo predefinito del registro (già in C1); **esattamente un agente attivo ⇒ quell'agente** (nessuna raccomandazione da inventare); più agenti ⇒ la proposta fallisce in modo recuperabile come prima. La conferma umana resta sempre obbligatoria.
5. **Riga di esempio nel prompt** (it+en): la richiesta di leggere/estrarre/riportare il contenuto di un documento mappa all'attività eseguibile di lettura. Necessaria perché il 4B seguiva l'esempio CSV e declassava le letture a `general`; aggiunta con riverifica completa della matrice (sotto).
6. **UI**: scheda «Leggi un materiale» accanto a quella del confronto (stesso contratto: caricamento file → proposta → approvazione → esecuzione → estratto), etichetta della capacità nell'accordo e nel diff, nota post-conferma dedicata.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (400 passati, 1 saltato; 7 nuovi in `test_material_reads.py` e 1 in `test_intake.py`): flusso confermato → approvato → eseguito con un artifact e replay DBOS senza duplicati; intake con capability diversa rifiuta la lettura; digest errato e doppia approvazione idempotenti; **nuova versione del materiale invalida l'approvazione**; attore senza accesso non legge (elenco e approvazione negati); materiale non estraibile rifiutato alla proposta; capacità eseguibile senza collaboratore con roster vuoto/singolo/multiplo (profilo del registro / agente unico / errore recuperabile).

**Frontend** (160 passati; 2 nuovi): approvazione con digest e revisione; file illeggibili o oversized mai inviati al motore. Typecheck, build web/prototipo, architettura 0 errori/29 avvisi, `git diff --check` puliti, OpenAPI rigenerata e verificata (nuove route `material-reads`, vocabolario intake esteso).

**Modello reale (Qwen3.5:4b, profilo temporaneo)**: matrice a temperatura 0 dopo la riga di esempio — richiesta CSV → `compare_csv` + collaboratore; richiesta di lettura → **`read_material`** + collaboratore; richiesta di coordinamento → `general` (3/3 ciascuna dove ripetuto). Flusso completo su server: intake con `read_material` e Bruno proposto → conferma → ingest `nota-prova.txt` → proposta di lettura → approvazione → workflow DBOS → **completato con artifact** (estratto con file, formato, byte, SHA-256, versione) → lavoro in revisione umana. Durante il tuning: il 4B con il solo catalogo a 3 voci contraddiceva sé stesso (rationale citava `compare_csv`, campo `general`) — risolto con la riga di esempio, non con modifiche al motore.

**Recupero:** riavvio reale del motore dopo l'esecuzione → proposta `completed`, un solo artifact, stesso id (nessun duplicato).

**GUI (browser su motore temporaneo):** lavoro di lettura aperto dalla lista → scheda accordo con «Attività prevista: Lettura autorizzata di un materiale», responsabile Bruno, progetto collegato; scheda «Leggi un materiale» con «Artifact di lettura pronto per la tua verifica» ed estratto espandibile; messaggio del motore in conversazione; riepilogo coerente con prossimo passo di revisione umana.

**Pacchetto:** bundle motore ricostruito (include i nuovi moduli e i prompt aggiornati), **8/8 test desktop** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-20T10-49-46-368Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T10-49-46-368Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `8e16f5708df39d5d30bb2b88c70779ff75a636aa50fdd0b3a21d39e135275c38`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Accettazione della slice (dal passaggio) e stato

- «Tool assente/negato non viene proposto come eseguibile»: il registro è la fonte; capacità non registrate rifiutate; attore senza accesso non vede né approva letture (test).
- «Cambi di fonti invalidano approvazioni»: il digest lega id+hash+versione del materiale; una nuova versione invalida l'approvazione (test).
- «Retry/restart non duplicano effetti»: replay DBOS e riavvio reale verificati, un artifact.
- «Output e contesto limitati»: estratto limitato a 8.000 caratteri, dimensione file 2 MiB, budget 3 tentativi, nessun modello nell'esecuzione.
- Test e demo CSV conservati (la fonte condivisa non ne cambia il comportamento; suite CSV intatta).

## Limiti rimasti

- La scheda lettura carica un nuovo file (come quella del confronto); non offre la scelta di materiali già presenti nel progetto — il catalogo materiali nella UI è il passo naturale successivo.
- La selezione della capacità da parte del 4B dipende dalle righe di esempio nel prompt: nuove capacità eseguibili future richiederanno esempi e riverifica della matrice a temperatura 0.
- Il fallback «agente unico» sceglie deterministicamente quell'agente: con più agenti la proposta senza collaboratore resta fallita in modo recuperabile.
- Restano i limiti storici: budget aggregati con riserve atomiche (passo D), loop multi-tool, disponibilità del registro non consumata dalla UI, i18n UI, cifratura, firma/notarizzazione, identità multiutente, test mount/unmount React.

## Riproduzione della prova con modello reale

Ollama `qwen3.5:4b`, `HOMUN_DATA_DIR` temporaneo, `--dev-insecure`: nuova conversazione con «Leggi il documento che caricherò e prepara un artifact con il suo contenuto e la provenienza…» → proposta con `read_material` → conferma → caricare un `.txt` nella scheda «Leggi un materiale» → approvare → artifact con estratto e provenienza in revisione; riavviare il motore e verificare che nulla si duplichi. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
