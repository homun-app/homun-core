"""F3.3 plan draft extraction and validation tests."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.models.interpretation import RosterEntry
from homun.planning.draft import PlanDraft, PlanStepDraft, validate_plan_draft
from homun.planning.extract import extract_plan_draft_fake


def test_validate_plan_draft_asks_for_missing_objective() -> None:
    draft = validate_plan_draft(
        PlanDraft(objective="", expected_result="X", steps=[]),
        allowed_assignee_ids={"person_fabio"},
    )
    assert "objective" in draft.missing_fields
    assert draft.questions


def test_validate_rejects_unknown_assignee() -> None:
    draft = validate_plan_draft(
        PlanDraft(
            objective="Catalogo",
            expected_result="PDF",
            steps=[PlanStepDraft(title="Scrivi", assignee_id="ghost")],
        ),
        allowed_assignee_ids={"person_fabio"},
    )
    assert draft.missing_fields
    assert any("roster" in q.lower() or "assegnatario" in q.lower() for q in draft.questions)


def test_fake_extract_complete_for_long_request() -> None:
    roster = [RosterEntry(id="person_fabio", display_name="Fabio", kind="person")]
    draft = extract_plan_draft_fake("Prepara il catalogo prodotti autunno", roster=roster)
    assert not draft.missing_fields
    assert len(draft.steps) >= 1
    assert draft.steps[0].assignee_id == "person_fabio"


def test_post_message_proposes_plan_when_work_exists(tmp_path: Path) -> None:
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
                "command_id": "cmd_f33_create",
                "type": "conversation.create",
                "payload": {"title": "Catalogo"},
            },
        )
        assert created.status_code == 200, created.text
        conversation_id = created.json()["result"]["conversation_id"]
        work = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f33_work",
                "type": "work.create",
                "payload": {
                    "conversation_id": conversation_id,
                    "title": "Catalogo",
                    "objective": "Preparare catalogo",
                },
            },
        )
        assert work.status_code == 200, work.text
        posted = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f33_msg",
                "type": "conversation.post_message",
                "payload": {
                    "conversation_id": conversation_id,
                    "text": "Prepara il catalogo prodotti per il cliente",
                    "roster": [{"id": "person_fabio", "display_name": "Fabio", "kind": "person"}],
                },
            },
        )
        assert posted.status_code == 200, posted.text
        result = posted.json()["result"]
        assert result["interpretation"]["kind"] == "command_proposal"
        assert result.get("plan_draft")
        assert result.get("plan_proposed")
        assert result["plan_proposed"]["plan_revision"] == 1
        assert "Bozza piano creata" in result["assistant_text"]


def test_short_message_asks_clarification_not_plan(tmp_path: Path) -> None:
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
                "command_id": "cmd_f33_short_c",
                "type": "conversation.create",
                "payload": {"title": "Ciao"},
            },
        )
        conversation_id = created.json()["result"]["conversation_id"]
        posted = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_f33_short_m",
                "type": "conversation.post_message",
                "payload": {"conversation_id": conversation_id, "text": "ok"},
            },
        )
        assert posted.status_code == 200, posted.text
        result = posted.json()["result"]
        assert result["interpretation"]["kind"] == "reply"
        assert "plan_proposed" not in result
