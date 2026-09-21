"""F3.2 message interpretation tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.fake import FakeProvider
from homun.models.guardrails import apply_interpretation_guardrails
from homun.models.interpretation import (
    CommandProposal,
    MentionCandidate,
    MentionResolution,
    MessageInterpretation,
    RosterEntry,
)


def test_message_interpretation_roundtrip() -> None:
    raw = MessageInterpretation(
        kind="reply",
        text="Ciao",
        mentions=[],
    )
    assert MessageInterpretation.model_validate(raw.model_dump()).kind == "reply"


def test_guardrails_strip_unknown_candidate_ids() -> None:
    roster = [
        RosterEntry(id="person_fabio", display_name="Fabio", kind="person"),
        RosterEntry(id="agent_vera", display_name="Vera", kind="agent"),
    ]
    interp = MessageInterpretation(
        kind="command_proposal",
        text="Assegna a Vera",
        command=CommandProposal(
            type="work.assign",
            payload={"assignee_id": "agent_invented"},
            summary="Assegna a qualcuno",
        ),
        mentions=[
            MentionResolution(
                raw="@Vera",
                candidates=[
                    MentionCandidate(id="agent_vera", display_name="Vera", kind="agent"),
                    MentionCandidate(id="agent_ghost", display_name="Ghost", kind="agent"),
                ],
            )
        ],
    )
    fixed = apply_interpretation_guardrails(interp, roster)
    assert all(c.id != "agent_ghost" for m in fixed.mentions for c in m.candidates)
    assert fixed.mentions[0].candidates[0].id == "agent_vera"


def test_guardrails_ambiguous_mention_becomes_clarification() -> None:
    roster = [
        RosterEntry(id="a1", display_name="Alex", kind="person"),
        RosterEntry(id="a2", display_name="Alex", kind="agent"),
    ]
    interp = MessageInterpretation(
        kind="command_proposal",
        text="Chiedi ad Alex",
        command=CommandProposal(type="work.assign", payload={}, summary="Assegna"),
        mentions=[
            MentionResolution(
                raw="@Alex",
                candidates=[
                    MentionCandidate(id="a1", display_name="Alex", kind="person"),
                    MentionCandidate(id="a2", display_name="Alex", kind="agent"),
                ],
            )
        ],
    )
    fixed = apply_interpretation_guardrails(interp, roster)
    assert fixed.kind == "clarification"
    assert fixed.command is None
    assert len(fixed.mentions[0].candidates) == 2


def test_fake_interpret_is_structured_reply() -> None:
    provider = FakeProvider()
    roster = [RosterEntry(id="person_fabio", display_name="Fabio", kind="person")]
    result = provider.interpret("Prepara il catalogo", roster=roster)
    assert result.kind in ("reply", "clarification", "command_proposal")
    assert result.text
    mentioned = provider.interpret("Ciao @Fabio", roster=roster)
    assert any(m.raw == "@Fabio" and len(m.candidates) == 1 for m in mentioned.mentions)


def test_http_interpret_fake(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    with TestClient(app) as client:
        response = client.post(
            "/v1/models/interpret",
            json={
                "text": "Ciao @Fabio",
                "roster": [{"id": "person_fabio", "display_name": "Fabio", "kind": "person"}],
                "provider_id": "fake",
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["kind"] in ("reply", "clarification", "command_proposal")
        assert body["text"]


def test_post_message_includes_interpretation(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
    with TestClient(app) as client:
        created = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f32_create",
                "type": "conversation.create",
                "payload": {"title": "Interpret test"},
            },
        )
        assert created.status_code == 200, created.text
        conversation_id = created.json()["result"]["conversation_id"]
        posted = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f32_msg",
                "type": "conversation.post_message",
                "payload": {
                    "conversation_id": conversation_id,
                    "text": "Ciao @Fabio, prepara il catalogo",
                    "roster": [{"id": "person_fabio", "display_name": "Fabio", "kind": "person"}],
                },
            },
        )
        assert posted.status_code == 200, posted.text
        result = posted.json()["result"]
        assert "interpretation" in result
        assert result["interpretation"]["kind"] in ("reply", "clarification", "command_proposal")
        assert result.get("assistant_text")
        # Idempotent replay must not fail or double-create interpret side effects silently wrong
        replay = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f32_msg",
                "type": "conversation.post_message",
                "payload": {
                    "conversation_id": conversation_id,
                    "text": "Ciao @Fabio, prepara il catalogo",
                    "roster": [{"id": "person_fabio", "display_name": "Fabio", "kind": "person"}],
                },
            },
        )
        assert replay.status_code == 200
        assert replay.json()["result"].get("interpretation")


def test_interpret_agent_with_test_model() -> None:
    pytest.importorskip("pydantic_ai")
    from pydantic_ai import Agent
    from pydantic_ai.models.test import TestModel

    agent: Agent[None, MessageInterpretation] = Agent(
        TestModel(),
        output_type=MessageInterpretation,
        instructions="test",
    )
    out = agent.run_sync("hello").output
    assert isinstance(out, MessageInterpretation)


def test_interpret_retries_once_on_runtime_error(tmp_path: Path, monkeypatch) -> None:
    from homun.models import interpret as interpret_mod
    from homun.models.interpretation import MessageInterpretation, RosterEntry
    from homun.models.registry import build_default_registry

    calls = {"n": 0}

    def flaky(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("provider blip")
        return MessageInterpretation(kind="reply", text="ok")

    monkeypatch.setattr(interpret_mod, "run_interpret", flaky)
    registry = build_default_registry(tmp_path, for_tests=True)
    result = interpret_mod.run_interpret_with_retry(
        registry,
        "ciao",
        roster=[RosterEntry(id="person_fabio", display_name="Fabio", kind="person")],
        provider_id="openai_compatible",
        attempts=2,
    )
    assert result.text == "ok"
    assert calls["n"] == 2
    attempts = registry.list_attempts()
    assert len(attempts) == 2
    assert attempts[0].status == "error"
    assert attempts[1].status == "ok"


def test_interpret_parser_survives_thinking_model_prose() -> None:
    """Regression (21 Sep 2026): glm thinking output wrapped JSON in prose and a
    second block; the greedy brace regex swallowed it and every message in a
    confirmed work failed with provider_unavailable."""
    from homun.models.interpret import _extract_json_object

    text = (
        'Ecco la risposta in JSON.\n\n```json\n{"kind": "reply", "text": "4 aumenti"}\n```\n\n'
        'Nota: ho escluso gli SKU sotto i 5 euro {vincolo} e ho riportato solo le anomalie.\n\n'
        '{"second": "blocco ignorato"}'
    )
    parsed = _extract_json_object(text)
    assert parsed == {"kind": "reply", "text": "4 aumenti"}

    # The exact shape that failed live: object first, prose with braces after.
    trailing = '{"kind": "reply", "text": "ok"}\n\nSpiegazione {dettaglio} del metodo.'
    assert _extract_json_object(trailing) == {"kind": "reply", "text": "ok"}
