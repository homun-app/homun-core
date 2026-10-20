"""F3.5 UsageAttempt ledger — every front-door model step is linked to its
command, with the tokens the provider reported and never invented ones."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.native_errors import NETWORK, NativeModelError
from homun.models.native_turn import NativeMessage, ToolCall

HEADERS = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}


def _context(tmp_path: Path):
    ctx = create_context(workspace_id="ws_local", db_path=tmp_path / "ws_local.sqlite3",
                         data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    return ctx


def _conversation(client: TestClient) -> str:
    created = client.post("/v1/workspaces/ws_local/commands", headers=HEADERS,
                          json={"command_id": "c_conv", "type": "conversation.create",
                                "payload": {"title": "Test"}})
    assert created.status_code == 200
    return created.json()["result"]["conversation_id"]


def _post(client: TestClient, conversation_id: str, text: str, command_id: str = "c_msg"):
    return client.post("/v1/workspaces/ws_local/commands", headers=HEADERS,
                       json={"command_id": command_id, "type": "conversation.post_message",
                             "payload": {"conversation_id": conversation_id, "text": text}})


def test_http_lists_front_door_usage_attempt(tmp_path: Path) -> None:
    _context(tmp_path)
    try:
        with TestClient(create_app()) as client:
            conversation_id = _conversation(client)
            posted = _post(client, conversation_id, "ciao Homun")
            assert posted.status_code == 200, posted.text

            listed = client.get("/v1/models/usage-attempts")
            assert listed.status_code == 200
            items = listed.json()["items"]
            assert items, "the front-door step must land in the ledger"
            last = items[-1]
            assert last["command_id"] == "c_msg"
            assert last["conversation_id"] == conversation_id
            assert last["actor_id"] == "person_fabio"
            assert last["purpose"] == "front_door"
            assert last["status"] == "ok"
            assert last["provider_id"] == "fake"
            assert last["attempt_index"] == 0
            assert last["input_tokens"] is None or isinstance(last["input_tokens"], int)
    finally:
        reset_context_for_tests(None)


def test_transport_failure_records_error_attempt_without_tokens(tmp_path: Path) -> None:
    ctx = _context(tmp_path)
    try:
        with TestClient(create_app()) as client:
            conversation_id = _conversation(client)
            ctx.models._fake.native_script = [NativeModelError(NETWORK, "provider unreachable")]
            posted = _post(client, conversation_id, "ciao Homun")
            assert posted.status_code == 503, posted.text
            attempt = ctx.models.list_attempts()[-1]
            assert attempt.command_id == "c_msg"
            assert attempt.purpose == "front_door"
            assert attempt.status == "error"
            assert attempt.error_code == NETWORK
            # A failed call reported no usage: the ledger must not claim zero tokens.
            assert attempt.input_tokens is None
            assert attempt.output_tokens is None
    finally:
        reset_context_for_tests(None)


def test_correction_rounds_are_separate_attempts_of_the_same_command(tmp_path: Path) -> None:
    ctx = _context(tmp_path)
    try:
        with TestClient(create_app()) as client:
            conversation_id = _conversation(client)
            work = {"title": "Nota", "objective": "Preparare la nota", "output": "Nota breve"}
            ctx.models._fake.native_script = [
                NativeMessage(role="assistant", content="", tool_calls=[
                    ToolCall(id="call_bad", name="propose_work", arguments={**work, "capability": "inesistente"})]),
                NativeMessage(role="assistant", content="", tool_calls=[
                    ToolCall(id="call_good", name="propose_work", arguments=work)]),
            ]
            posted = _post(client, conversation_id, "Prepara una nota.")
            assert posted.status_code == 200, posted.text
            attempts = [a for a in ctx.models.list_attempts() if a.command_id == "c_msg"]
            assert [a.attempt_index for a in attempts] == [0, 1]
            assert all(a.status == "ok" for a in attempts), "the provider answered: the arguments were wrong, not the call"
            assert all(a.purpose == "front_door" for a in attempts)
    finally:
        reset_context_for_tests(None)
