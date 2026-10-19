"""Area A — chat e domande.

Percorso della UI: «apri una conversazione e fai una domanda»
(`engine-domain-client.ts` → POST /commands; la risposta sta nel corpo della
risposta oppure arriva in trascrizione quando il turno passa dall'agente).
Ogni scenario gira N volte: vale il tasso, non il singolo esito.
"""
from __future__ import annotations

import time

import pytest

from .harness import RECOVERY_WINDOW_TIMEOUT, describe, run_indices
from .reporting import GoldenRun

pytestmark = pytest.mark.golden

DOMANDA_SEMPLICE = "Ciao! Cosa sai fare per aiutarmi nel lavoro di ogni giorno?"


def _reply(golden, conversation_id: str, result: dict) -> str:
    return golden.client.resolve_reply(conversation_id, result, result.get("message_id"))


def wait_for_message(client, conversation_id: str, message_id: str, text_part: str) -> bool:
    """Il messaggio della persona è nella trascrizione (per id o per testo)."""
    for _ in range(10):
        messages = client.messages(conversation_id)
        if message_id and any(m.get("id") == message_id for m in messages):
            return True
        if any(text_part in (m.get("text") or "") for m in messages):
            return True
        time.sleep(3)
    return False


def _story_a1(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("A1.domanda"):
        conversation_id = client.create_conversation("Domanda semplice")
        before = {item["id"] for item in client.list_works()}
    with run.step("A1.risposta"):
        result, error = client.post_message(conversation_id, DOMANDA_SEMPLICE)
        assert error is None, f"invio rifiutato: {describe(error)}"
        reply = _reply(golden, conversation_id, result)
        assert len(reply.strip()) >= 30, f"risposta troppo povera: {reply!r}"
    with run.step("A1.nessun-lavoro"):
        new = [item for item in client.list_works() if item["id"] not in before]
        # «Chat agente» è il lavoro interno dei turni chat, non un lavoro operativo
        operational = [item for item in new if item.get("title") != "Chat agente"]
        assert not operational, f"la domanda ha creato lavori: {[i['title'] for i in operational]}"


def _story_a2(golden, run: GoldenRun) -> None:
    client = golden.client
    texts = [
        "Che cosa puoi fare per me?",
        "Dammi un esempio di richiesta operativa che puoi gestire.",
        "Riassumi in una riga cosa hai appena detto.",
    ]
    with run.step("A2.conversazione"):
        conversation_id = client.create_conversation("Tre messaggi di fila")
    sent_ids: list[str] = []
    for index, text in enumerate(texts, start=1):
        with run.step(f"A2.messaggio-{index}"):
            result, error = client.post_message(conversation_id, text)
            assert error is None, f"messaggio {index} rifiutato: {describe(error)}"
            sent_ids.append(str(result.get("message_id") or ""))
            reply = _reply(golden, conversation_id, result)
            assert reply.strip(), f"nessuna risposta al messaggio {index}"
    with run.step("A2.ordine"):
        messages = client.messages(conversation_id)
        positions = [
            next((m["sequence"] for m in messages if m.get("id") == message_id), None)
            for message_id in sent_ids
        ]
        assert all(p is not None for p in positions), "un messaggio inviato non è in trascrizione"
        assert positions == sorted(positions), f"ordine sbagliato: {positions}"
        for position in positions:  # ogni messaggio è seguito da una risposta del motore
            following = [
                m
                for m in messages
                if m.get("author_id") == "homun_engine" and (m.get("sequence") or 0) > position
            ]
            assert following, "nessuna risposta del motore dopo un messaggio"


def _story_a3(golden, run: GoldenRun) -> None:
    client = golden.client
    broken = "golden_rotta"
    with run.step("A3.preparazione"):
        conversation_id = client.create_conversation("Ripresa dopo errore")
        # Una connessione verso un endpoint morto, come un'impostazione rotta
        client.post(
            "/v1/models/connections",
            {
                "connection_id": broken,
                "kind": "openai_compatible",
                "display_name": "Rotta (golden)",
                "model_id": "qm",
                "base_url": "http://127.0.0.1:9/v1",
                "max_output_tokens": 8192,
            },
        )
    with run.step("A3.errore"):
        result, error = client.post_message(
            conversation_id, "Prova con la connessione rotta.", connection_id=broken
        )
        assert error is not None, "risposta arrivata nonostante la connessione rotta"
        assert error.code in {"provider_unavailable", "http_500", "http_503"}, describe(error)
    with run.step("A3.ripresa"):
        # Dopo l'errore la conversazione può restare occupata per la finestra
        # di retry (~40-60s): si riprova finché un messaggio non è accettato.
        deadline = time.monotonic() + RECOVERY_WINDOW_TIMEOUT
        accepted: dict | None = None
        last_error = None
        while time.monotonic() < deadline and accepted is None:
            result, error = client.post_message(
                conversation_id,
                "Adesso riprovo con la connessione normale: rispondi in una riga.",
            )
            if error is not None:
                last_error = error
                if error.code != "command_in_progress":
                    raise AssertionError(f"ripresa rifiutata senza blocco: {describe(error)}")
                time.sleep(5)
            else:
                accepted = result
        assert accepted is not None, f"conversazione ancora bloccata: {describe(last_error)}"
        # «Accettato» per la UI vuol dire: il messaggio della persona è
        # persistito nella trascrizione (il message_id può mancare quando la
        # risposta arriva dal percorso asincrono).
        sent = str(accepted.get("message_id") or "")
        testo = "Adesso riprovo con la connessione normale"
        in_trascrizione = wait_for_message(client, conversation_id, sent, testo)
        if not in_trascrizione:
            conversation = client.conversation(conversation_id) or {}
            raise AssertionError(
                "messaggio accettato ma non in trascrizione; "
                f"risultato: {accepted!r}; followup: {conversation.get('followups')!r}"
            )


def _story_a4(golden, run: GoldenRun) -> None:
    with run.step("A4.prima"):
        client = golden.client
        conversation_id = client.create_conversation("Ritrovo dopo riavvio")
        result, error = client.post_message(conversation_id, "Ricordati questo numero d'ordine: 4711.")
        assert error is None, f"invio rifiutato: {describe(error)}"
        assert _reply(golden, conversation_id, result).strip()
    with run.step("A4.riavvio"):
        golden.engine.restart()
    with run.step("A4.ritrovo"):
        client = golden.client
        assert client.conversation(conversation_id) is not None, "conversazione assente dopo il riavvio"
        messages = client.messages(conversation_id)
        assert len(messages) >= 2, "trascrizione vuota dopo il riavvio"
        assert any("4711" in (m.get("text") or "") for m in messages), "il messaggio inviato è perso"
    with run.step("A4.continua"):
        result, error = golden.client.post_message(conversation_id, "Che numero ti ho detto prima?")
        assert error is None, f"messaggio dopo riavvio rifiutato: {describe(error)}"
        assert _reply(golden, conversation_id, result).strip()


@pytest.mark.parametrize("run_index", run_indices())
def test_a1_domanda_semplice(golden, run_index: int) -> None:
    golden.run(["A1"], run_index, _story_a1)


@pytest.mark.parametrize("run_index", run_indices())
def test_a2_tre_messaggi(golden, run_index: int) -> None:
    golden.run(["A2"], run_index, _story_a2)


@pytest.mark.parametrize("run_index", run_indices())
def test_a3_ripresa_dopo_errore(golden, run_index: int) -> None:
    golden.run(["A3"], run_index, _story_a3)


@pytest.mark.parametrize("run_index", run_indices())
def test_a4_ritrovo_dopo_riavvio(golden_solo, run_index: int) -> None:
    golden_solo.run(["A4"], run_index, _story_a4)
