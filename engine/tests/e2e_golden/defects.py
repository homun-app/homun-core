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
        r"model\.output_invalid",
        "turno di ingresso: gli argomenti dello strumento sono restati invalidi anche dopo le due "
        "correzioni rimandate al modello — `engine/src/homun/application/sessions/front_door/turn.py` "
        "(`_decide`, `MAX_ARGUMENT_CORRECTIONS`) e `front_door/outcomes.py` (`outcome_from_call`); "
        "il turno finisce in `model.output_invalid`, non ripetibile in automatico: il messaggio resta "
        "salvato e la persona può rimandarlo.",
    ),
    (
        r"model\.empty_response",
        "turno di ingresso: il modello ha risposto vuoto anche dopo il promemoria — "
        "`engine/src/homun/application/sessions/front_door/turn.py` (`_decide`, `MAX_EMPTY_RETRIES`); "
        "il turno finisce in `model.empty_response`, non ripetibile in automatico.",
    ),
    (
        r"risposta semplice \(kind=text\)|non ha prodotto una proposta di accordo: risposta semplice",
        "turno di ingresso: davanti a una richiesta di lavoro il modello ha risposto con testo invece "
        "di chiamare `propose_work` o `ask_clarification` — istruzioni "
        "`engine/src/homun/prompts/front_door/instructions.{it,en}.txt` e descrizioni degli strumenti "
        "`tool.propose_work.*.txt`; con il ripiego strutturato, `structured_union_schema` in "
        "`front_door/turn.py`.",
    ),
    (
        r"non dichiara nessuna informazione mancante",
        "turno di ingresso: su una richiesta vaga il modello ha proposto l'accordo senza "
        "`missing_information` — regola «richiesta vaga» in "
        "`engine/src/homun/prompts/front_door/instructions.{it,en}.txt`.",
    ),
    (
        r"proposta non salvata",
        "turno di ingresso: la proposta è passata la validazione nel turno ma non si è salvata al "
        "commit — `engine/src/homun/application/work/intake.py` (`commit_front_door_proposal`, "
        "`effective_values` contro lo stato fresco).",
    ),
    (
        r"è partito senza conferma|piano è stato creato senza conferma|accordo risulta confermato",
        "INVARIANTE VIOLATO «il modello propone, il motore decide»: qualcosa ha avviato o confermato "
        "il lavoro sulla parola del modello — `engine/src/homun/application/sessions/front_door/"
        "outcomes.py` e `turn.py` (`finalize_front_door`), `application/work/intake.py`.",
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
        "la conversazione risulta occupata: con la porta d'ingresso un messaggio nuovo è rifiutato "
        "SOLO se un turno è davvero in corso (processing con lease valida) — "
        "`engine/src/homun/application/sessions/command_delivery.py` (`turn_in_flight`, "
        "`cancel_superseded_turns`); i tentativi automatici del messaggio precedente si annullano.",
    ),
    (
        r"la nota non contiene",
        "il risultato non riporta tutti i fatti dati: il prompt della sintesi non vincola i "
        "fatti della richiesta — `engine/src/homun/application/work/synthesis_execution.py` "
        "(`compose`).",
    ),
    (
        r"risposta troppo povera|nessuna risposta",
        "turno di chat senza risposta utile — `engine/src/homun/application/sessions/front_door/"
        "turn.py` (`_decide`, `finalize_front_door`) e `engine/src/homun/application/agent/"
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
