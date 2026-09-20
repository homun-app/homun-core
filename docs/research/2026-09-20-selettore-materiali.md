# Selettore materiali esistenti — consegna e verifica

**Data:** 20 settembre 2026, dopo il commit snapshot `5c0c065` e la chiusura del passo D. Primo incremento verso il loop multi-tool: le schede degli strumenti possono **riusare i materiali già presenti nel progetto** invece di chiedere sempre un nuovo caricamento.
**Branch:** `fabio/production-foundations`. Commit di riferimento per l'intero stato B–D: `5c0c065` (locale, non pubblicato).

## Cosa è stato costruito

1. **Helper di selezione puri** (`engine-material-selection.ts`): idoneità per lettura (formati leggibili, ≤2 MB, estratto riuscito, gestito e attivo) e per confronto (solo CSV attivi gestiti), etichetta con nome·versione·byte. Testati isolatamente.
2. **Picker condiviso** (`EngineMaterialPicker`): risolve il progetto della conversazione (creandolo se assente, riusando `ensureEngineProjectForConversation`), elenca i materiali e filtra per idoneità; testo onesto quando non ci sono materiali idonei.
3. **Client da-id senza caricamento**: `prepareComparisonFromMaterials` e `prepareReadFromMaterial` propongono direttamente dai `material_id` (con recupero della proposta duratura in caso di POST perso, come i percorsi di upload); nessun multipart, nessuna ingestione.
4. **Modalità nelle schede**: «Carica un file/due file» (comportamento precedente, invariato) o «Usa i materiali del progetto» in lettura e confronto; il pulsante di preparazione resta disabilitato finché la selezione non è valida (e, nel confronto, i due materiali sono distinti).

## Prove eseguite

**Deterministici frontend** (164 passati; 4 nuovi): idoneità lettura/confronto per formato, dimensione, stato estrazione e stato; etichette con versione e dimensione; **i percorsi da-id inviano esattamente i body attesi e non producono mai multipart** (le fonti esistenti si referenziano, non si ricaricano).

**GUI (browser su motore temporaneo):** lavoro con accordo confermato e due CSV già nel progetto → scheda confronto in modalità «Usa i materiali del progetto» → due combobox con «listino-marzo.csv · v1 · 53 B» e «listino-aprile.csv · v1 · 53 B» → selezione, preparazione (proposta con fonti riferite, nessun upload), **approvazione umana** → confronto completato («2 aumenti… Report pronto per la revisione umana. Fonte: motore») con download di report e CSV.

**Suite:** motore 421 passati / 1 saltato (invariato: nessuna modifica al motore), frontend 164, typecheck, build, architettura 0 errori/29 avvisi, `git diff --check` pulito.

## Perché serve al loop multi-tool

Comporre strumenti su un lavoro richiede di riferire fonti già registrate (leggi A, leggi B, confronta): senza selettore, ogni passo ricaricherebbe file, rompendo la provenienza e duplicando i materiali. Questo incremento introduce il riferimento come azione di prima classe nella UI, con versione e hash già visibili al momento della scelta.

## Limiti

- Il picker non mostra l'hash completo né il progetto di provenienza quando il lavoro ne attraversa più di uno (mostra i materiali del progetto della conversazione).
- Nessun refresh automatico della lista dopo un caricamento avvenuto in un'altra scheda (basta riaprire la modalità).
- Il loop multi-tool vero e proprio (composizione di capacità in un turno, con approvazione per effetto) resta da progettare: questo è il primo passo, non il loop.

## Riproduzione

Motore temporaneo + `npm run dev`: lavoro con intake `compare_csv` confermato e due CSV caricati nel progetto della conversazione → scheda «Confronta due listini» → «Usa i materiali del progetto» → selezionare i due CSV → Prepara → Approva → report in revisione.
