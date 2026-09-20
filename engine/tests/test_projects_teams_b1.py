"""Projects + Teams foundation B1 tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.errors import ValidationError
from homun.domain.models import Actor
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore


@pytest.fixture
def service() -> tuple[DomainService, Actor]:
    store = WorkspaceStore("ws_test")
    svc = DomainService(store)
    actor = Actor(id="person_fabio", workspace_id="ws_test", display_name="Fabio")
    return svc, actor


def test_team_create_and_project_attach(service: tuple[DomainService, Actor]) -> None:
    svc, actor = service
    agent = svc.apply(actor, "cmd_a", "agent.create", {"name": "Vera"})
    agent_id = str(agent["agent_id"])
    team = svc.apply(
        actor,
        "cmd_t",
        "team.create",
        {
            "name": "Catalogo",
            "member_ids": [actor.id, agent_id],
            "coordinator_id": actor.id,
        },
    )
    team_id = str(team["team_id"])
    project = svc.apply(
        actor,
        "cmd_p",
        "project.create",
        {
            "name": "Acme 2026",
            "description": "Listini",
            "member_ids": [actor.id],
            "team_ids": [team_id],
        },
    )
    proj = svc.get_project(str(project["project_id"]))
    assert proj.description == "Listini"
    assert team_id in proj.team_ids
    assert actor.id in proj.member_ids
    assert svc.get_team(team_id).coordinator_id == actor.id


def test_team_rejects_coordinator_not_in_members(service: tuple[DomainService, Actor]) -> None:
    svc, actor = service
    with pytest.raises(ValidationError, match="coordinator_id"):
        svc.apply(
            actor,
            "cmd_bad",
            "team.create",
            {"name": "Solo", "member_ids": [actor.id], "coordinator_id": "person_ghost"},
        )


def test_team_rejects_unknown_agent_member(service: tuple[DomainService, Actor]) -> None:
    svc, actor = service
    with pytest.raises(ValidationError, match="Unknown agent"):
        svc.apply(
            actor,
            "cmd_bad_agent",
            "team.create",
            {"name": "X", "member_ids": ["agent_missing"]},
        )


def test_project_archive_bumps_version(service: tuple[DomainService, Actor]) -> None:
    svc, actor = service
    created = svc.apply(actor, "cmd_p1", "project.create", {"name": "P1"})
    archived = svc.apply(
        actor,
        "cmd_arch",
        "project.archive",
        {"project_id": created["project_id"], "expected_version": 1},
    )
    assert archived["version"] == 2
    assert archived["status"] == "archived"


def test_http_projects_and_teams(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
    app = create_app()
    with TestClient(app) as client:
        agent = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={"command_id": "c_agent", "type": "agent.create", "payload": {"name": "Vera"}},
        )
        assert agent.status_code == 200
        agent_id = agent.json()["result"]["agent_id"]

        team = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "c_team",
                "type": "team.create",
                "payload": {
                    "name": "Squadra",
                    "member_ids": ["person_fabio", agent_id],
                    "coordinator_id": "person_fabio",
                },
            },
        )
        assert team.status_code == 200, team.text
        team_id = team.json()["result"]["team_id"]

        project = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "c_proj",
                "type": "project.create",
                "payload": {"name": "Progetto", "team_ids": [team_id]},
            },
        )
        assert project.status_code == 200, project.text
        project_id = project.json()["result"]["project_id"]

        listed_p = client.get("/v1/workspaces/ws_local/projects", headers=headers)
        assert listed_p.status_code == 200
        assert any(item["id"] == project_id for item in listed_p.json()["items"])

        got_p = client.get(f"/v1/workspaces/ws_local/projects/{project_id}", headers=headers)
        assert got_p.status_code == 200
        assert team_id in got_p.json()["team_ids"]

        listed_t = client.get("/v1/workspaces/ws_local/teams")
        assert listed_t.status_code == 200
        assert any(item["id"] == team_id for item in listed_t.json()["items"])

        got_t = client.get(f"/v1/workspaces/ws_local/teams/{team_id}")
        assert got_t.status_code == 200
        assert got_t.json()["coordinator_id"] == "person_fabio"

    reset_context_for_tests(None)
