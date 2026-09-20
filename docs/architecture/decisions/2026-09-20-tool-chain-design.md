# Design: tool chain — primo loop multi-tool

**Data:** 20 settembre 2026. **Stato:** accettato per l'implementazione (slice engine; UI dedicata incremento successivo).

## Obiettivo e perimetro

Un turno di lavoro che **compone più invocazioni di capacità approvate**, con un'unica approvazione umana che enumera ogni effetto con digest e fonti, esecuzione durevole sequenziale e rivalidazione delle fonti a ogni passo. V1: catene di passaggi **della stessa capacità ammessa dall'intake confermato** (es. «leggi questi tre documenti» = 3 passaggi `read_material`; «confronta queste due coppie» = 2 passaggi `compare_csv`). Le catene miste e l'output di un passo come input del successivo restano fuori: le capacità attuali non hanno dipendenze reali di dati.

## Decisioni

1. **Nessuna seconda pipeline.** La catena orchestra le proposte-per-strumento esistenti: all'approvazione vengono creati i record `material_read.propose` / `price_comparison.propose` in stato `queued` (stesse strutture, stessi digest) e l'esecuzione riusa **i loro `execute()` invariati** — con la rivalidazione identità/fonti e la pubblicazione artifact già provate. Il workflow DBOS `tool_chain` li esegue in sequenza.
2. **Un piano, N passi.** L'approvazione della catena crea **un** `plan.propose` con un passo per azione (niente N revisioni di piano), poi `work.start` e workflow id stabile `chain:{ws}:{id}` (deduplicazione DBOS su riavvio).
3. **Approvazione che enumera ogni effetto.** La proposta di catena porta per ogni passo capability, fonti (id/titolo/hash/versione) e il tool_version; il digest copre l'intera sequenza. L'approvazione richiede **persona** (stesso gate delle azioni singole) e rivalida tutte le fonti: una fonte cambiata invalida l'intera approvazione prima dell'avvio.
4. **Fallimento per passo.** Un passo che fallisce mette il lavoro in `failed` con errore tipizzato sul suo record; i passi già completati **conservano i propri artifact** in revisione; i passi successivi restano `blocked` (`chain_step_failed`) e non vengono eseguiti. Il retry della catena è una nuova proposta esplicita.
5. **Ammissibilità.** Ogni passo deve soddisfare `require_confirmed_intake` per la propria capability: in V1 questo vincola tutti i passi alla capacità dell'intake confermato del lavoro. Budget: le esecuzioni sono deterministiche (nessun modello), quindi nessuna riserva; le chiamate di modello del turno restano quelle già coperte (intake/interpretazione/piano).

## Contratto (additivo)

`POST /works/{id}/tool-chains` `{command_id, steps:[{capability:'read_material'|'compare_csv', material_id | left_material_id+right_material_id}], expected_version}` → proposta `pending_confirmation` con passi descritti e digest. `GET /works/{id}/tool-chains`; `POST /works/{id}/tool-chains/{id}/approve` `{command_id, digest, expected_version}`.

## Accettazione

Catena di due letture → due artifact una sola volta (anche dopo riavvio); digest e cambio fonte invalidano l'approvazione; gate persona; fallimento al passo 2 conserva l'artifact del passo 1 e blocca il passo 3; ammissione rifiutata senza intake confermato o con capacità non ammessa; suite CSV/lettura intatte (i loro execute sono riusati, non modificati).
