# Tool chain — primo loop multi-tool, consegna e verifica

**Data:** 20 settembre 2026, dopo il [selettore materiali](2026-09-20-selettore-materiali.md). Design accettato: [2026-09-20-tool-chain-design.md](../architecture/decisions/2026-09-20-tool-chain-design.md).
**Branch:** `fabio/production-foundations`. Commit precedenti: `5c0c065` (B–D), `303ebb4` (selettore).

## Cosa è stato costruito

Un turno di lavoro che compone **più invocazioni di capacità approvate** con un'unica approvazione umana che enumera ogni effetto:

1. **Proposta di catena** (`application/tool_chains.py`): passi 2–8, ciascuno con capability (`read_material`/`compare_csv`) e fonti; ammissione per capacità confermata dall'intake; fonti verificate (identità/hash/permessi) alla proposta; digest sull'intera sequenza.
2. **Approvazione che enumera ogni effetto**: solo persona (stesso gate delle azioni singole), rivalidazione di tutte le fonti prima dell'avvio; un solo `plan.propose` con un passo per azione, `work.start`, workflow id stabile `chain:{ws}:{id}`.
3. **Esecuzione durevole sequenziale** (`runtime/workflows/tool_chain.py`): i passi diventano proposte-per-strumento `queued` (stessi digest e strutture — **gli execute() esistenti girano invariati**); tra i passi la catena fa la continuazione meccanica REVIEW→READY→RUNNING (eventi `work.chain_continued` registrati, ribind delle versioni) perché ogni strumento singolo porta il lavoro in revisione; l'ultimo passo lascia il lavoro in revisione umana.
4. **Fallimento per passo**: il passo fallito conserva gli artifact dei passi precedenti e blocca i successivi (`chain_step_failed`); la catena va `failed` con errore tipizzato.
5. **Ownership del dispatch**: i passi marcati `_chain_id` sono ignorati dai delivery singoli (confronto/lettura) — la catena è il solo dispatcher, ciascun passo con id proprio sotto l'id della catena. Corretto dopo aver osservato in verifica viva una corsa reale: passi con l'id catena venivano spediti come workflow singoli e DBOS deduplicava via la catena intera.

### Fix emancipati dalla verifica con GLM 5.3 Flash

Il passaggio a un modello reasoning ha rotto due ipotesi del 4B, entrambe corrette nel motore:

- **Parser JSON tollerante** (`_extract_json_payload`): i modelli thinking emettono prosa prima/dopo il JSON; il parser ora estrae l'oggetto JSON (fence oParentesi), restando severo sulla validità.
- **`num_predict` 8192** (era 1024): il ragionamento consumava il budget prima del JSON e troncava l'output a metà oggetto.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (427 passati, 1 saltato; 6 nuovi in `test_tool_chains.py`): catena di due letture → due artifact una volta; digest errato e fonte cambiata invalidano l'approvazione; solo persona approva; ammissione (min 2 passi, capacità confermata); fallimento al passo 2 conserva l'artifact del passo 1 e blocca il passo 3; dispatch sopravvive a riavvio con id stabile.

**Modello reale (GLM 5.3 Flash via Ollama, profilo temporaneo):** intake `read_material` valido al primo colpo (il 4B falliva ripetutamente); catena di 2 letture approvata dalla persona → `queued` → **`completed`** con entrambi i passi completati, 2 artifact, lavoro in revisione; **riavvio reale del motore → catena `completed`, passi `completed`, 2 artifact, nessun duplicato**.

**Frontend** (164 passati): nessuna regressione. Typecheck, build web/prototipo, architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI rigenerata e verificata (nuove route `tool-chains`).

**Pacchetto:** bundle ricostruito, **8/8 test desktop**.

## Build di riferimento

- App: `dist/desktop/2026-09-20T18-29-10-443Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T18-29-10-443Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `de1975d68b1dc71b45e8dc56b38096d023334fd7a64061d003046f8d9a5b9a19`
- Non firmata e non notarizzata: candidato locale. Le build precedenti restano come prove storiche.

## Limiti rimasti

- **Nessuna UI dedicata alla catena**: si propone via API (`POST /works/{id}/tool-chains`). La scheda naturale («esegui più letture/confronti») è l'incremento successivo.
- Catene **monocapacità** (tutti i passi della capacità dell'intake confermato); niente dati in pipelina fra passi (le capacità attuali non lo richiedono); niente catene miste.
- La continuazione fra i passi è contabilità del motore (eventi registrati), non una decisione umana: la persona ha approvato l'intera enumerazione in una volta.
- Il routing domanda/lavoro e la sintesi con modelli thinking ora funzionano (parser tollerante + budget generazione), ma la matrice di capacità non è stata rieseguita su GLM oltre l'intake `read_material`.

## Riproduzione della prova

Motore temporaneo con `models.json` → `glm-5.3-flash:cloud`: richiesta «Leggi i documenti che caricherò…» → intake `read_material` confermato → due `.txt` nel progetto della conversazione → `POST /works/{id}/tool-chains` con due passi → approvazione persona → catena `completed` con 2 artifact in revisione; riavvio del motore e verifica dell'assenza di duplicati. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
