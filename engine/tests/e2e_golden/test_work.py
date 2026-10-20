"""Area B — lavori dalla chat: dalla richiesta operativa al documento approvato.

Percorso della UI: `engine-intake-creation.ts` (classifica → proposta intake),
`engine-intake-client.ts` (conferma), `engine-synthesis-client.ts` o
`engine-agent-run-client.ts` (esecuzione), `engine-work-review.ts` (revisione).
La scelta dell'esecutore segue la capability dell'accordo, come fa la UI.

B6, B8 e B9 misurano l'altra strada della richiesta di lavoro: non la coppia
classifica → proposta intake del primo messaggio (B1), ma
`conversation.post_message` (useEngineWorkspace.postMessage →
postEngineConversationMessage), che il motore risolve con il turno di ingresso
nativo a strumenti (`application/sessions/front_door`): il modello propone
(testo, chiarimento, accordo, modifica del piano), il motore decide. B7 misura
un lavoro eseguito con una connessione modello creata dalla persona con un nome
suo (Impostazioni → Modelli).
"""
from __future__ import annotations

from dataclasses import replace

import pytest

from .common import (RICHIESTA_NOTA, RINGRAZIAMENTO, WORKSPACE, GoldenError, ensure_accepted,
                     normalize_for_match, run_indices)
from .reporting import GoldenRun

pytestmark = pytest.mark.golden

COMMENTO_CORREZIONE = (
    "Aggiungi una sezione «Rischi» con le conseguenze di un ritardo oltre il 30 novembre."
)
DOMANDA_APERTURA = "Cosa sai fare?"
RICHIESTA_VAGA = "Crea una relazione sui fornitori 2027"

# La connessione che la persona crea con un nome suo (B7): id e nome scelti da
# lei, kind `openai_compatible`, stesso endpoint e modello del provider golden.
CONNESSIONE_PROPRIA_ID = "ufficio-di-fabio"
CONNESSIONE_PROPRIA_NOME = "Ufficio di Fabio"


def _execute_work(
    golden, work_id: str, expected_version: int, material_ids: list[str], run: GoldenRun
) -> dict:
    """Esegue il lavoro secondo la capability dell'accordo, come la UI.

    Restituisce l'artifact appena prodotto.
    """
    client = golden.client
    capability = _latest_intake_capability(client, work_id)
    if capability in {"general", "agent_run"}:
        run_view = client.prepare_agent_run(work_id, expected_version, material_ids)
        client.approve_agent_run(work_id, run_view)
        _wait_run_explained(golden, work_id, run_view["id"])
    else:
        proposal = client.prepare_synthesis(work_id, expected_version, material_ids)
        client.approve_synthesis(work_id, proposal)
        client.wait_synthesis(work_id, proposal["id"])
    row = client.work_row(work_id)
    artifact = (row or {}).get("latest_artifact") or {}
    assert artifact.get("content"), "esecuzione completata senza artifact leggibile"
    return artifact


def _wait_run_explained(golden, work_id: str, run_id: str) -> dict:
    """Attende il run; se termina male, la riga d'eccezione del motore entra nel motivo
    (l'API espone solo l'`error_code`)."""
    try:
        return golden.client.wait_agent_run(work_id, run_id)
    except GoldenError as exc:
        detail = golden.engine.last_exception()
        reason = f"{exc.reason}; motore: {detail}" if detail else exc.reason
        raise GoldenError(exc.code, reason, exc.excerpt) from exc


def _latest_intake_capability(client, work_id: str) -> str:
    items = client.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake").get("items") or []
    for item in reversed(items):
        if item.get("status") == "confirmed":
            return str(item.get("capability") or "synthesize")
    return "synthesize"


def _story_b(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("B1.richiesta"):
        conversation_id = client.create_conversation("Nuova richiesta")
        created = client.create_work(conversation_id, "Nuova richiesta", RICHIESTA_NOTA)
        work_id = str(created["work_id"])
        version = int(created["version"])
        classified = client.classify_intake(work_id, RICHIESTA_NOTA)
        assert classified.get("kind") == "work_request", (
            f"la richiesta operativa è stata classificata come {classified.get('kind')!r}"
        )
    with run.step("B1.proposta"):
        proposal = client.propose_intake(work_id, RICHIESTA_NOTA, version)
        assert proposal.get("status") == "pending_confirmation", str(proposal.get("status"))
        assert str(proposal.get("title") or "").strip(), "proposta senza titolo"
        assert str(proposal.get("objective") or "").strip(), "proposta senza obiettivo"
    with run.step("B2.conferma"):
        confirmed = client.confirm_intake(work_id, proposal)
        assert confirmed.get("status") == "confirmed", str(
            confirmed.get("status") or confirmed.get("error_code")
        )
        version = int(client.work_detail(work_id)["work"]["version"])
    with run.step("B2.esecuzione"):
        first = _execute_work(golden, work_id, version, [], run)
        first_version = int(first["version"])
    with run.step("B3.fatti"):
        content = normalize_for_match(first["content"])
        for needle, label in [
            ("rossi", "il fornitore Rossi"),
            ("marco", "il responsabile legale Marco"),
            ("30novembre", "la scadenza 30 novembre"),
            ("12000", "il budget 12.000"),
        ]:
            assert needle in content, f"la nota non contiene {label}"
    with run.step("B4.correzione"):
        version = int(client.work_detail(work_id)["work"]["version"])
        client.review_work(
            work_id, version, first["id"], "request_changes", comment=COMMENTO_CORREZIONE
        )
        version = int(client.work_detail(work_id)["work"]["version"])
    with run.step("B4.nuova-versione"):
        second = _execute_work(golden, work_id, version, [], run)
        assert int(second["version"]) > first_version, (
            f"la correzione non ha prodotto una nuova versione ({second['version']} ≤ {first_version})"
        )
    with run.step("B5.approvazione"):
        version = int(client.work_detail(work_id)["work"]["version"])
        outcome = client.review_work(work_id, version, second["id"], "approve")
        assert outcome.get("status") == "completed", str(outcome.get("status"))
    with run.step("B5.elenchi"):
        row = client.work_row(work_id)
        assert row is not None, "il lavoro non è nell'elenco Compiti"
        assert row.get("status") == "completed", f"stato inatteso in Compiti: {row.get('status')}"
        documents = client.list_artifacts()
        assert any(item.get("id") == second["id"] for item in documents), (
            "il risultato approvato non è nell'elenco Documenti"
        )


@pytest.mark.parametrize("run_index", run_indices())
def test_b_lavoro_dalla_chat(golden, run_index: int) -> None:
    golden.run(["B1", "B2", "B3", "B4", "B5"], run_index, _story_b)


# -- B6: richiesta di lavoro come messaggio successivo -----------------------


def _work_request_outcome(result: dict) -> str:
    """Che cosa vede la persona dopo una richiesta di lavoro mandata in chat.

    «proposta»: una proposta di accordo in attesa di conferma (o una modifica
    del piano in anteprima); «chiarimento»: il motore chiede ciò che manca;
    «agente»: la risposta arriva dal run della chat con agente; altrimenti la
    richiesta è stata trattata come semplice conversazione.
    """
    if result.get("chat_agent"):
        return "agente"
    front_door = result.get("front_door") or {}
    kind = str(front_door.get("kind") or "?")
    if kind == "work_proposal":
        proposal = result.get("intake_proposal") or {}
        if proposal.get("status") == "pending_confirmation":
            return "proposta"
        return f"proposta non salvata (error_code={proposal.get('error_code')!r})"
    if kind == "plan_change":
        patch = result.get("patch_proposal") or {}
        return "chiarimento" if patch.get("missing_or_ambiguous") else "proposta"
    if kind == "clarification":
        return "chiarimento"
    return f"risposta semplice (kind={kind})"


def _pending_proposal(client, work_id: str) -> dict | None:
    """La proposta di accordo in attesa di conferma del lavoro, se c'è."""
    items = client.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake").get("items") or []
    return next((item for item in reversed(items) if item.get("status") == "pending_confirmation"), None)


def _assert_nothing_started(client, work_id: str) -> None:
    """Nessun lavoro parte sulla parola del modello: bozza, senza piano, nessun accordo confermato."""
    work = client.work_detail(work_id)["work"]
    assert work.get("status") == "draft", f"il lavoro è partito senza conferma: stato {work.get('status')!r}"
    assert int(work.get("current_plan_revision") or 0) == 0, "un piano è stato creato senza conferma"
    items = client.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake").get("items") or []
    assert not any(item.get("status") == "confirmed" for item in items), "un accordo risulta confermato"


def _story_b6(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("B6.domanda"):
        conversation_id, _work_id, _version = client.create_conversation_and_work()
        roster = client.ui_roster()
        result, error = client.post_message(conversation_id, DOMANDA_APERTURA, roster=roster)
        ensure_accepted(error, "domanda rifiutata")
        reply = client.resolve_reply(conversation_id, result, result.get("message_id"))
        assert reply.strip(), "nessuna risposta alla domanda"
    # Sonda: se la richiesta viene rifiutata, «grazie» si misura comunque.
    with run.probe("B6.richiesta"):
        result, error = client.post_message(conversation_id, RICHIESTA_NOTA, roster=roster)
        ensure_accepted(error, "richiesta di lavoro rifiutata")
        if result.get("chat_agent"):
            client.resolve_reply(conversation_id, result, result.get("message_id"))
        outcome = _work_request_outcome(result)
        run.recorder.note(f"B6 run {run.run_index}: esito della richiesta = {outcome}")
        assert outcome in {"proposta", "chiarimento", "agente"}, (
            f"la richiesta non ha prodotto né una proposta di lavoro né un chiarimento: {outcome}"
        )
    with run.step("B6.grazie"):
        accepted, error, rejections = client.post_message_when_free(
            conversation_id, RINGRAZIAMENTO, roster=roster
        )
        ensure_accepted(
            error, f"«{RINGRAZIAMENTO}» rifiutato (dopo {rejections} rifiuti command_in_progress)"
        )
        if rejections:
            run.recorder.note(
                f"B6 run {run.run_index}: «{RINGRAZIAMENTO}» accettato solo dopo {rejections} rifiuti "
                "command_in_progress (finestra di retry del turno fallito, come in A3)."
            )
        sent = str(accepted.get("message_id") or "")
        assert client.message_persisted(conversation_id, sent, RINGRAZIAMENTO), (
            f"«{RINGRAZIAMENTO}» accettato ma non in trascrizione"
        )


@pytest.mark.parametrize("run_index", run_indices())
def test_b6_richiesta_come_messaggio_successivo(golden, run_index: int) -> None:
    golden.run(["B6"], run_index, _story_b6)


# -- B8: richiesta vaga → chiarimento o proposta con informazioni mancanti ----


def _story_b8(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("B8.richiesta-vaga"):
        conversation_id, work_id, _version = client.create_conversation_and_work()
        roster = client.ui_roster()
        result, error = client.post_message(conversation_id, RICHIESTA_VAGA, roster=roster)
        ensure_accepted(error, "richiesta vaga rifiutata")
        if result.get("chat_agent"):
            client.resolve_reply(conversation_id, result, result.get("message_id"))
        outcome = _work_request_outcome(result)
        run.recorder.note(f"B8 run {run.run_index}: esito della richiesta vaga = {outcome}")
        if outcome == "proposta":
            proposal = result.get("intake_proposal") or {}
            missing = [item for item in (proposal.get("missing_information") or []) if str(item).strip()]
            assert missing, "la proposta su una richiesta vaga non dichiara nessuna informazione mancante"
        else:
            assert outcome in {"chiarimento", "agente"}, (
                f"la richiesta vaga non ha prodotto né un chiarimento né una proposta: {outcome}"
            )
    with run.step("B8.nessun-avvio"):
        _assert_nothing_started(client, work_id)


@pytest.mark.parametrize("run_index", run_indices())
def test_b8_richiesta_vaga(golden, run_index: int) -> None:
    golden.run(["B8"], run_index, _story_b8)


# -- B9: richiesta di lavoro come PRIMO messaggio via post_message -----------


def _story_b9(golden, run: GoldenRun) -> None:
    """La strada che la UI userà nella PR 2: niente classify/intake, solo post_message."""
    client = golden.client
    with run.step("B9.richiesta"):
        conversation_id, work_id, _version = client.create_conversation_and_work()
        roster = client.ui_roster()
        result, error = client.post_message(conversation_id, RICHIESTA_NOTA, roster=roster)
        ensure_accepted(error, "richiesta di lavoro rifiutata")
        if result.get("chat_agent"):
            client.resolve_reply(conversation_id, result, result.get("message_id"))
        outcome = _work_request_outcome(result)
        run.recorder.note(f"B9 run {run.run_index}: esito della richiesta = {outcome}")
        assert outcome == "proposta", f"il primo messaggio non ha prodotto una proposta di accordo: {outcome}"
    with run.step("B9.proposta"):
        proposal = _pending_proposal(client, work_id)
        assert proposal is not None, "nessuna proposta in attesa di conferma sul lavoro della conversazione"
        assert str(proposal.get("title") or "").strip(), "proposta senza titolo"
        assert str(proposal.get("objective") or "").strip(), "proposta senza obiettivo"
        assert str(proposal.get("output") or "").strip(), "proposta senza risultato atteso"
        _assert_nothing_started(client, work_id)


@pytest.mark.parametrize("run_index", run_indices())
def test_b9_richiesta_come_primo_messaggio(golden, run_index: int) -> None:
    golden.run(["B9"], run_index, _story_b9)


# -- B7: lavoro con una connessione creata dalla persona ----------------------


def _story_b7(golden, run: GoldenRun) -> None:
    client = golden.client
    config = replace(
        golden.provider, connection_id=CONNESSIONE_PROPRIA_ID, display_name=CONNESSIONE_PROPRIA_NOME
    )
    with run.step("B7.connessione"):
        # Impostazioni → Modelli: nuova connessione con nome proprio, attivata e verificata
        client.upsert_connection(config)
        client.set_active_connection(config.connection_id)
        active = str(client.get("/v1/models/connections").get("active_connection_id") or "")
        assert active == config.connection_id, f"connessione attiva: {active!r}"
        verified = client.verify_connection(config.connection_id)
        assert verified.get("ok"), f"verifica fallita: {verified.get('message')}"
    with run.step("B7.lavoro"):
        # Un agente dal costruttore squadra e un lavoro con un passo adattivo:
        # l'esecuzione passa dal run agente, come i lavori «general» della UI.
        agent_id = client.create_agent("Homun di prova", "Operatore del percorso d'oro")
        conversation_id = client.create_conversation("Lavoro con la connessione propria")
        created = client.create_work(conversation_id, "Nota operativa", RICHIESTA_NOTA)
        work_id, version = str(created["work_id"]), int(created["version"])
        client.propose_plan(
            work_id,
            version,
            [
                {
                    "title": "Nota operativa",
                    "assignee_id": agent_id,
                    "capability": "agent_run",
                    "output_expected": "Nota operativa breve",
                }
            ],
        )
        version = int(client.work_detail(work_id)["work"]["version"])
        client.accept_plan(work_id, version)
        version = int(client.work_detail(work_id)["work"]["version"])
    # Sonde: lavoro e chat si misurano entrambi anche se uno dei due fallisce.
    with run.probe("B7.esecuzione"):
        run_view = client.prepare_agent_run(work_id, version, [])
        assert run_view.get("connection_id") == config.connection_id, (
            f"il run non usa la connessione propria: {run_view.get('connection_id')!r}"
        )
        client.approve_agent_run(work_id, run_view)
        _wait_run_explained(golden, work_id, run_view["id"])
        artifact = (client.work_row(work_id) or {}).get("latest_artifact") or {}
        assert artifact.get("content"), "run completato senza risultato leggibile"
    with run.probe("B7.chat"):
        # Con un agente attivo ogni messaggio in chat diventa un run con la
        # connessione scelta nel composer (chat_agent.start_chat_turn).
        chat_id = client.create_conversation("Chat con la connessione propria")
        result, error = client.post_message(
            chat_id, "Rispondi in una riga: cosa sai fare?",
            connection_id=config.connection_id, roster=client.ui_roster(),
        )
        ensure_accepted(error, "messaggio in chat rifiutato")
        run_id = str(result.get("agent_run_id") or "")
        assert run_id, f"il messaggio non è passato dal run della chat: {result!r}"
        chat_work = client.chat_run_work(chat_id, run_id)
        assert chat_work, "lavoro «Chat agente» del turno non trovato"
        try:
            _wait_run_explained(golden, chat_work, run_id)
        except GoldenError as exc:
            spoken = [m for m in client.messages(chat_id) if m.get("author_id") == "homun_engine"]
            if not spoken:
                raise GoldenError(
                    exc.code, f"{exc.reason}; la chat resta muta: nessun messaggio d'errore in trascrizione",
                    exc.excerpt,
                ) from exc
            raise
        reply = client.wait_chat_reply(chat_id, 0, timeout=90, expect_command=result.get("command_id"))
        assert str(reply.get("text") or "").strip(), "run completato ma nessuna risposta in chat"


@pytest.mark.parametrize("run_index", run_indices())
def test_b7_connessione_con_nome_proprio(golden_solo, run_index: int) -> None:
    golden_solo.run(["B7"], run_index, _story_b7)
