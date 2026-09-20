"""F3.5 UsageAttempt ledger — interpret attempts linked to commands, never invent tokens."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.interpretation import MessageInterpretation, RosterEntry
from homun.models.registry import build_default_registry
from homun.models.types import AttemptContext


def test_interpret_records_usage_attempt(tmp_path: Path) -> None:
    registry = build_default_registry(tmp_path, for_tests=True)
    roster = [RosterEntry(id="person_fabio", display_name="Fabio", kind="person")]
    ctx = AttemptContext(
        command_id="cmd_msg_1",
        conversation_id="conv_1",
        actor_id="person_fabio",
        purpose="interpret",
    )
    result = registry.interpret("ciao", roster=roster, context=ctx)
    assert result.kind == "reply"
    attempts = registry.list_attempts()
    assert len(attempts) == 1
    attempt = attempts[0]
    assert attempt.command_id == "cmd_msg_1"
    assert attempt.conversation_id == "conv_1"
    assert attempt.actor_id == "person_fabio"
    assert attempt.purpose == "interpret"
    assert attempt.attempt_index == 0
    assert attempt.status == "ok"
    assert attempt.provider_id == "fake"
    # Fake interpret does not invent token counts
    assert attempt.input_tokens is None
    assert attempt.output_tokens is None


def test_retry_records_failed_then_ok_attempt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from homun.models import interpret as interpret_mod

    registry = build_default_registry(tmp_path, for_tests=True)
    calls = {"n": 0}

    def flaky(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("provider blip")
        return MessageInterpretation(kind="reply", text="recovered")

    monkeypatch.setattr(interpret_mod, "run_interpret", flaky)
    roster = [RosterEntry(id="person_fabio", display_name="Fabio", kind="person")]
    ctx = AttemptContext(command_id="cmd_retry", actor_id="person_fabio", purpose="interpret")
    result = registry.interpret("ciao", roster=roster, provider_id="fake", context=ctx)
    assert result.text == "recovered"
    attempts = registry.list_attempts()
    assert len(attempts) == 2
    assert attempts[0].status == "error"
    assert attempts[0].attempt_index == 0
    assert attempts[0].error_code == "provider_error"
    assert attempts[1].status == "ok"
    assert attempts[1].attempt_index == 1
    # Failed attempt must not claim zero tokens
    assert attempts[0].input_tokens is None
    assert attempts[0].output_tokens is None


def test_http_lists_usage_attempts(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "c_conv",
                "type": "conversation.create",
                "payload": {"title": "Test"},
            },
        )
        assert created.status_code == 200
        conversation_id = created.json()["result"]["conversation_id"]

        posted = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "c_msg",
                "type": "conversation.post_message",
                "payload": {"conversation_id": conversation_id, "text": "ciao Homun"},
            },
        )
        assert posted.status_code == 200, posted.text

        listed = client.get("/v1/models/usage-attempts")
        assert listed.status_code == 200
        items = listed.json()["items"]
        assert len(items) >= 1
        last = items[-1]
        assert last["command_id"] == "c_msg"
        assert last["conversation_id"] == conversation_id
        assert last["purpose"] == "interpret"
        assert last["status"] == "ok"
        assert last["input_tokens"] is None or isinstance(last["input_tokens"], int)

    reset_context_for_tests(None)
