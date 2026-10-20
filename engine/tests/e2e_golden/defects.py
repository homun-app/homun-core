"""Difetti del motore dietro i fallimenti del percorso d'oro.

Regola della suite: un fallimento con un modello locale è un difetto del
motore da correggere, non una debolezza del modello. Qui ogni fallimento
registrato viene ricondotto al punto del codice coinvolto, quando lo si
conosce; altrimenti il rapporto dice onestamente che è da individuare.

I pattern si applicano a «passo codice: motivo» del fallimento (per i run
interrotti prima, al motivo del passo che ha interrotto la storia).
"""
from __future__ import annotations

import re

DA_INDIVIDUARE = "punto del codice da individuare (vedi i fallimenti sotto)"

# (espressione regolare sul fallimento, descrizione con il punto del codice)
ENGINE_DEFECTS: list[tuple[str, str]] = [
    (
        r"Input should be a valid list.*input_value=None|patch_changes\s+Input should be a valid list",
        "interpretazione del messaggio: il JSON del modello porta `null` nei campi lista "
        "(`patch_changes`, `mentions[].candidates`) e `MessageInterpretation.model_validate` lo "
        "rifiuta invece di normalizzarlo a `[]` — `engine/src/homun/models/interpretation.py:42` "
        "(`patch_changes`) e `:21` (`MentionResolution.candidates`), chiamato da "
        "`engine/src/homun/models/interpret.py:66` (`_interpret_via_json_completion`); il turno "
        "finisce in `provider_unavailable` (`command_delivery.complete`, riga 186).",
    ),
    (
        r"kind\s+Field required",
        "interpretazione del messaggio: davanti a una richiesta di lavoro il modello risponde con "
        "la struttura del lavoro (titolo, assegnatario) invece dell'involucro "
        "`MessageInterpretation` (manca `kind`), e il secondo tentativo ripete lo stesso prompt "
        "senza il feedback dello schema — `engine/src/homun/models/interpret.py:53-66` "
        "(`_interpret_via_json_completion`, prompt `interpret/schema_hint`) e `:151-224` "
        "(`run_interpret_with_retry`); il turno finisce in `provider_unavailable`.",
    ),
    (
        r"(Local model|Model) interpret failed(?!.*(Input should be a valid list|Field required))",
        "interpretazione del messaggio fallita nel percorso JSON-in-prompt — "
        "`engine/src/homun/models/interpret.py:131-148` (`run_interpret`): ogni eccezione del "
        "parsing diventa `RuntimeError` → `provider_unavailable`, senza riparare il JSON.",
    ),
    (
        r"Selected model transport differs",
        "run adattivo bloccato con una connessione dal nome proprio: `bound_provider` confronta "
        "`expected['kind']` (= `connection.kind`, fissato da `runtime_selection.resolve`) con "
        "`provider.provider_id`, che per una connessione creata dalla persona il registro imposta "
        "al nome della connessione — `engine/src/homun/models/runtime_binding.py:14-19`, "
        "`engine/src/homun/models/registry.py:118` (`provider_id=base_pid`), "
        "`engine/src/homun/application/agent/runtime_selection.py:67`; l'esenzione copre solo gli "
        "id composti `base:modello`.",
    ),
    (
        r"run_agente_(blocked|failed)(?!.*Selected model transport differs)",
        "run adattivo terminato male: l'`error_code` e l'eccezione del motore sono nel motivo — "
        "`engine/src/homun/application/agent/runs/run_failures.py:12` (`fail`) e "
        "`engine/src/homun/application/agent/runs/run_execution.py`.",
    ),
    (
        r"la chat resta muta",
        "la chat non riferisce il run bloccato: `deliver_chat_answers` consegna in trascrizione "
        "solo `failed`, `completed` e `waiting_input` — "
        "`engine/src/homun/application/agent/chat_agent.py:335-366`.",
    ),
    (
        r"prossima occorrenza non è lunedì alle 9",
        "anteprima delle prossime esecuzioni: `croniter(cron, now, second_at_beginning=True)."
        "get_next(datetime)` attraversa il cambio d'ora (25/10/2026) senza rinormalizzare "
        "l'offset del fuso e slitta di un'ora — `engine/src/homun/routes/routines.py:124` "
        "(`preview_cron`); stesso calcolo in "
        "`engine/src/homun/application/automation/routines.py:57` (`next_occurrence`).",
    ),
    (
        r"non cita nessun contenuto del (pdf|file markdown)|presenta meno di due punti chiave",
        "ancoraggio ai materiali: il blocco materiali non vincola il risultato a citare ogni "
        "file selezionato e con modelli piccoli il secondo file viene ignorato — "
        "`engine/src/homun/application/work/synthesis_execution.py:106` (`_materials_block`, "
        "per-materiale `max_context_characters // n`), e per i run adattivi "
        "`engine/src/homun/application/agent/runs/runs.py:248` (`available_materials` in "
        "`_objective`).",
    ),
    (
        r"command_in_progress",
        "la conversazione resta occupata dopo un turno fallito per la finestra di retry del "
        "followup — `engine/src/homun/application/sessions/command_delivery.py:104` "
        "(`conversation_busy`) e `:200-203` (backoff 5·2^n s, 3 tentativi).",
    ),
    (
        r"la nota non contiene",
        "il risultato non riporta tutti i fatti dati: il prompt della sintesi non vincola i "
        "fatti della richiesta — `engine/src/homun/application/work/synthesis_execution.py` "
        "(`compose`).",
    ),
    (
        r"risposta troppo povera|nessuna risposta",
        "turno di chat senza risposta utile — `engine/src/homun/application/sessions/"
        "command_delivery.py:115` (`complete`) e `engine/src/homun/application/agent/"
        "chat_agent.py:324` (`deliver_chat_answers`).",
    ),
]


def engine_defects_for(failures: list[dict]) -> list[str]:
    """Le righe «difetto del motore» di uno scenario: i difetti distinti riconosciuti
    nei suoi fallimenti, nell'ordine in cui compaiono; se nessuno è noto, lo dice."""
    found: list[str] = []
    for failure in failures:
        haystack = f"{failure.get('step', '')} {failure.get('code', '')}: {failure.get('reason', '')}"
        for pattern, description in ENGINE_DEFECTS:
            if description not in found and re.search(pattern, haystack, flags=re.IGNORECASE | re.DOTALL):
                found.append(description)
    if failures and not found:
        return [DA_INDIVIDUARE]
    return found
