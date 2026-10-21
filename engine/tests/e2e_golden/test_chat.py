"""Area A — chat e domande.

Percorso della UI: «apri una conversazione e fai una domanda»
(`engine-domain-client.ts` → POST /commands; la risposta sta nel corpo della
risposta oppure arriva in trascrizione quando il turno passa dall'agente).
Ogni scenario gira N volte: vale il tasso, non il singolo esito.
"""
from __future__ import annotations

import pytest

from .common import (CHAT_WORK_TITLE, RICHIESTA_NOTA, RINGRAZIAMENTO, WORKSPACE, describe,
                     ensure_accepted, run_indices)
from .fixtures.empty_model import EMPTY_MODEL_ID, EmptyModelServer
from .reporting import GoldenRun

pytestmark = pytest.mark.golden

DOMANDA_SEMPLICE = "Ciao! Cosa sai fare per aiutarmi nel lavoro di ogni giorno?"


def _reply(golden, conversation_id: str, result: dict) -> str:
    return golden.client.resolve_reply(conversation_id, result, result.get("message_id"))


def _story_a1(golden, run: GoldenRun) -> None:
    client = golden.client
    with run.step("A1.domanda"):
        conversation_id = client.create_conversation("Domanda semplice")
        before = {item["id"] for item in client.list_works()}
    with run.step("A1.risposta"):
        result, error = client.post_message(conversation_id, DOMANDA_SEMPLICE)
        ensure_accepted(error, "invio rifiutato")
        reply = _reply(golden, conversation_id, result)
        assert len(reply.strip()) >= 30, f"risposta troppo povera: {reply!r}"
    with run.step("A1.nessun-lavoro"):
        new = [item for item in client.list_works() if item["id"] not in before]
        # il lavoro interno dei turni chat con agente non è un lavoro operativo
        operational = [item for item in new if item.get("title") != CHAT_WORK_TITLE]
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
            ensure_accepted(error, f"messaggio {index} rifiutato")
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
        testo = "Adesso riprovo con la connessione normale"
        accepted, error, rejections = client.post_message_when_free(
            conversation_id, f"{testo}: rispondi in una riga."
        )
        if error is not None and error.code != "command_in_progress":
            ensure_accepted(error, "ripresa rifiutata senza blocco")
        ensure_accepted(error, f"conversazione ancora bloccata dopo {rejections} tentativi")
        # «Accettato» per la UI vuol dire: il messaggio della persona è
        # persistito nella trascrizione (il message_id può mancare quando la
        # risposta arriva dal percorso asincrono).
        sent = str(accepted.get("message_id") or "")
        if not client.message_persisted(conversation_id, sent, testo):
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
        ensure_accepted(error, "invio rifiutato")
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
        ensure_accepted(error, "messaggio dopo riavvio rifiutato")
        assert _reply(golden, conversation_id, result).strip()


def _intake_items(client, work_id: str) -> list[dict]:
    return client.get(f"/v1/workspaces/{WORKSPACE}/works/{work_id}/intake").get("items") or []


def _story_a5(golden, run: GoldenRun) -> None:
    """Dopo una proposta, «grazie» è conversazione: testo, nessuna proposta nuova."""
    client = golden.client
    with run.step("A5.proposta"):
        conversation_id, work_id, _version = client.create_conversation_and_work()
        roster = client.ui_roster()
        result, error = client.post_message(conversation_id, RICHIESTA_NOTA, roster=roster)
        ensure_accepted(error, "richiesta di lavoro rifiutata")
        if result.get("chat_agent"):
            client.resolve_reply(conversation_id, result, result.get("message_id"))
        kind = str((result.get("front_door") or {}).get("kind") or "?")
        run.recorder.note(f"A5 run {run.run_index}: esito della richiesta = {kind}")
        before = _intake_items(client, work_id)
    with run.step("A5.grazie"):
        result, error = client.post_message(conversation_id, RINGRAZIAMENTO, roster=roster)
        ensure_accepted(error, f"«{RINGRAZIAMENTO}» rifiutato")
        reply = _reply(golden, conversation_id, result)
        assert reply.strip(), f"nessuna risposta a «{RINGRAZIAMENTO}»"
        kind = str((result.get("front_door") or {}).get("kind") or ("agente" if result.get("chat_agent") else "?"))
        assert kind in {"text", "agente"}, f"«{RINGRAZIAMENTO}» non ha ricevuto una risposta testuale: {kind}"
    with run.step("A5.nessuna-proposta-nuova"):
        after = _intake_items(client, work_id)
        assert [item.get("id") for item in after] == [item.get("id") for item in before], (
            "«grazie» ha creato una nuova proposta di accordo"
        )
        assert [item.get("status") for item in after] == [item.get("status") for item in before], (
            "«grazie» ha cambiato lo stato delle proposte esistenti"
        )


def _story_a6(golden, run: GoldenRun) -> None:
    """Una risposta vuota del modello è un errore tipizzato e chiaro, non un blocco:
    il messaggio successivo è accettato SUBITO, senza aspettare la finestra dei tentativi."""
    client = golden.client
    connection = "golden_vuota"
    with EmptyModelServer() as empty:
        with run.step("A6.preparazione"):
            conversation_id = client.create_conversation("Risposta vuota del modello")
            client.post(
                "/v1/models/connections",
                {
                    "connection_id": connection,
                    "kind": "openai_compatible",
                    "display_name": "Sempre vuoto (golden)",
                    "model_id": EMPTY_MODEL_ID,
                    "base_url": empty.base_url,
                    "api_key": "golden",
                    "max_output_tokens": 512,
                },
            )
        with run.step("A6.risposta-vuota"):
            result, error = client.post_message(
                conversation_id, "Dimmi qualcosa di utile.", connection_id=connection
            )
            assert error is not None, f"il modello vuoto ha prodotto una risposta: {result!r}"
            assert error.code in {"model.empty_response", "model.output_invalid"}, describe(error)
            # Una risposta vuota riceve un promemoria e UN nuovo tentativo, poi basta.
            assert len(empty.requests) == 2, f"chiamate al modello vuoto: {len(empty.requests)} (attese 2)"
    with run.step("A6.subito-dopo"):
        # Nessuna attesa: il messaggio nuovo è accettato al primo colpo.
        testo = "Adesso rispondi con la connessione normale"
        result, error = client.post_message(conversation_id, f"{testo}: una riga.")
        ensure_accepted(error, "messaggio successivo rifiutato subito dopo l'errore del modello")
        assert _reply(golden, conversation_id, result).strip(), "nessuna risposta dopo l'errore"
    with run.step("A6.messaggio-conservato"):
        messages = client.messages(conversation_id)
        assert any("Dimmi qualcosa di utile." in (m.get("text") or "") for m in messages), (
            "il messaggio della risposta vuota non è rimasto in trascrizione"
        )
        followups = (client.conversation(conversation_id) or {}).get("followups") or []
        scheduled = [f for f in followups if f.get("status") == "retry_scheduled"]
        assert not scheduled, f"restano tentativi automatici programmati: {scheduled!r}"


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


@pytest.mark.parametrize("run_index", run_indices())
def test_a5_grazie_dopo_una_proposta(golden, run_index: int) -> None:
    golden.run(["A5"], run_index, _story_a5)


@pytest.mark.parametrize("run_index", run_indices())
def test_a6_risposta_vuota_poi_messaggio_accettato(golden, run_index: int) -> None:
    golden.run(["A6"], run_index, _story_a6)
