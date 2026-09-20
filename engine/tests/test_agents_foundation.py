"""Agents foundation slice A — profile fields, update, roster, HTTP."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.errors import ValidationError
from homun.domain.models import Actor, AgentProfile
from homun.domain.roster import build_workspace_roster
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore


@pytest.fixture
def service_with_connections() -> tuple[DomainService, Actor]:
    store = WorkspaceStore("ws_test")
    service = DomainService(
        store,
        known_connection_ids=lambda: {"fake", "openai_compatible"},
    )
    actor = Actor(id="person_fabio", workspace_id="ws_test", display_name="Fabio")
    return service, actor


def test_agent_create_with_instructions_and_connection(
    service_with_connections: tuple[DomainService, Actor],
) -> None:
    service, actor = service_with_connections
    result = service.apply(
        actor,
        "cmd_create_1",
        "agent.create",
        {
            "name": "Vera",
            "role": "prezzi",
            "instructions": "Rispondi in italiano, breve.",
            "preferred_connection_id": "fake",
            "status": "draft",
        },
    )
    agent = service.get_agent(str(result["agent_id"]))
    assert agent.instructions == "Rispondi in italiano, breve."
    assert agent.preferred_connection_id == "fake"
    assert agent.status == "draft"
    assert agent.role == "prezzi"


def test_agent_create_rejects_unknown_connection(
    service_with_connections: tuple[DomainService, Actor],
) -> None:
    service, actor = service_with_connections
    with pytest.raises(ValidationError, match="Unknown model connection"):
        service.apply(
            actor,
            "cmd_bad_conn",
            "agent.create",
            {"name": "Ghost", "preferred_connection_id": "not-a-connection"},
        )


def test_agent_update_bumps_revision(
    service_with_connections: tuple[DomainService, Actor],
) -> None:
    service, actor = service_with_connections
    created = service.apply(actor, "cmd_c", "agent.create", {"name": "Vera"})
    agent_id = str(created["agent_id"])
    updated = service.apply(
        actor,
        "cmd_u",
        "agent.update",
        {
            "agent_id": agent_id,
            "expected_version": 1,
            "instructions": "Nuove istruzioni",
            "preferred_connection_id": "openai_compatible",
            "status": "paused",
        },
    )
    assert updated["revision"] == 2
    agent = service.get_agent(agent_id)
    assert agent.instructions == "Nuove istruzioni"
    assert agent.preferred_connection_id == "openai_compatible"
    assert agent.status == "paused"


def test_build_workspace_roster_includes_active_and_draft_only() -> None:
    actor = Actor(id="person_fabio", workspace_id="ws", display_name="Fabio")
    agents = [
        AgentProfile(id="agent_a", workspace_id="ws", name="Active", status="active"),
        AgentProfile(id="agent_d", workspace_id="ws", name="Draft", status="draft"),
        AgentProfile(id="agent_p", workspace_id="ws", name="Paused", status="paused"),
        AgentProfile(id="agent_r", workspace_id="ws", name="Retired", status="retired"),
    ]
    roster = build_workspace_roster(actor=actor, agents=agents)
    ids = {e.id for e in roster}
    assert "person_fabio" in ids
    assert "agent_a" in ids
    assert "agent_d" in ids
    assert "agent_p" not in ids
    assert "agent_r" not in ids
    kinds = {e.id: e.kind for e in roster}
    assert kinds["agent_a"] == "agent"
    assert kinds["person_fabio"] == "person"


def test_http_agents_list_get_create_update(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    app = create_app()
    headers = {
        "X-Homun-Actor-Id": "person_fabio",
        "X-Homun-Actor-Name": "Fabio",
    }
    with TestClient(app) as client:
        created = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_agent_create",
                "type": "agent.create",
                "payload": {
                    "name": "Vera",
                    "instructions": "Sii breve",
                    "preferred_connection_id": "fake",
                },
            },
        )
        assert created.status_code == 200, created.text
        agent_id = created.json()["result"]["agent_id"]

        listed = client.get("/v1/workspaces/ws_local/agents")
        assert listed.status_code == 200
        assert any(item["id"] == agent_id for item in listed.json()["items"])

        got = client.get(f"/v1/workspaces/ws_local/agents/{agent_id}")
        assert got.status_code == 200
        assert got.json()["instructions"] == "Sii breve"
        assert got.json()["preferred_connection_id"] == "fake"

        updated = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "cmd_agent_update",
                "type": "agent.update",
                "payload": {
                    "agent_id": agent_id,
                    "expected_version": 1,
                    "role": "catalogo",
                    "status": "active",
                },
            },
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["result"]["revision"] == 2
        assert updated.json()["result"]["role"] == "catalogo"

        missing = client.get("/v1/workspaces/ws_local/agents/agent_missing")
        assert missing.status_code == 404

    reset_context_for_tests(None)
