# UX della catena e materiali nel riepilogo — consegna e verifica

**Data:** 20 settembre 2026, dopo la [tool chain](2026-09-20-tool-chain.md). Allineata alla direzione UX approvata ([spec](../superpowers/specs/2026-09-19-conversational-intake-ux-design.md)) e al template editoriale del prototipo (il CSS dell'app ne è già un sovrainsieme; i gap veri erano funzionali, non di skin).
**Branch:** `fabio/production-foundations`. Commit precedenti: `5c0c065`, `303ebb4`, `26e1e82`.

## Cosa è stato costruito

1. **Scheda «Leggi più materiali in una volta»** (`EngineToolChain`): quando l'accordo confermato è `read_material`, la chat offre la catena accanto alla lettura singola. Selezione multipla (2–8) dei materiali idonei già registrati (checkbox con nome·versione·byte), proposta con l'elenco esatto dei documenti (titolo, versione, prefisso hash per passo), **una sola approvazione** che dichiara di coprire esattamente quelle versioni, avanzamento in tempo reale e chiusura con segno di spunta per documento; stato di fallimento onesto (i già ultimati restano, gli altri no).
2. **Client e hook** (`engine-tool-chain-client.ts`, `useToolChain`): trasporto tipizzato (proposta con un passo `read_material` per materiale e revisione corrente; approvazione con digest) e polling mentre la catena è in coda/in corso.
3. **Materiali nel riepilogo destro** (spec: «riepilogo compatto: … materiali e consegna»): sezione «Materiali del lavoro» con i primi 5 riferimenti attivi (nome·versione, hash in tooltip) e il conteggio degli altri — stesso dato del preambolo autorizzato, senza contenuti.

## Prove eseguite

**Deterministici frontend** (166 passati; 2 nuovi): la proposta invia un passo per materiale con la revisione corrente e nessun caricamento; l'approvazione lega digest e revisione; tipi allineati. Typecheck, build, architettura 0 errori/29 avvisi, `git diff --check` pulito.

**GUI (browser su motore temporaneo con GLM 5.3 Flash):** lavoro con intake `read_material` confermato e tre contratti nel progetto → riepilogo destro con «Materiali del lavoro» (3 riferimenti con hash) → scheda catena: tre checkbox selezionate («3 scelti») → «Prepara le letture (3)» → «Propongo 3 letture» con l'elenco delle versioni → **«Approva le 3 letture»** → esecuzione con i tre messaggi in chat («Lettura completata: contratto-N.txt … Fonte: motore») → **«3 letture completate»** con ✓ per documento e artifact in revisione umana. Screenshot della scheda e del riepilogo verificato per coerenza col template.

**Suite motore** (427 passati / 1 saltato): nessuna modifica al motore in questa tranche.

## Limiti rimasti

- La UI della catena copre le letture multiple; le catene `compare_csv` (coppie di materiali per passo) restano via API.
- Il riepilogo mostra i materiali del progetto della conversazione (fino a 5 + conteggio): nessun link al pannello materiali né selezione.
- La sezione materiali del riepilogo carica all'apertura del lavoro (nessun refresh automatico dopo un caricamento avvenuto altrove).

## Riproduzione

Motore temporaneo con `glm-5.3-flash:cloud` + `npm run dev`: richiesta di lettura documenti → conferma accordo → caricare 3 `.txt` → scheda «Leggi più materiali in una volta» → selezionare i tre → Prepara → Approva → tre artifact in revisione. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
