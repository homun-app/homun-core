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


def test_project_agent_overrides_and_agent_fallback(service: tuple[DomainService, Actor]) -> None:
    svc, actor = service
    agent = svc.apply(
        actor,
        "cmd_a1",
        "agent.create",
        {
            "name": "Elio Pro",
            "preferred_connection_id": "conn_fast",
            "fallback_connection_id": "conn_backup",
        },
    )
    agent_id = str(agent["agent_id"])
    prof = svc.get_agent(agent_id)
    assert prof.preferred_connection_id == "conn_fast"
    assert prof.fallback_connection_id == "conn_backup"

    # Update agent fallback connection
    svc.apply(
        actor,
        "cmd_a2",
        "agent.update",
        {
            "agent_id": agent_id,
            "expected_version": prof.revision,
            "fallback_connection_id": "conn_backup_v2",
        },
    )
    assert svc.get_agent(agent_id).fallback_connection_id == "conn_backup_v2"

    # Create project with agent overrides
    proj_res = svc.apply(
        actor,
        "cmd_p1",
        "project.create",
        {
            "name": "Progetto Override",
            "agent_model_overrides": {agent_id: "conn_heavy_reasoning"},
            "agent_tool_overrides": {agent_id: ["web_search", "document_read"]},
        },
    )
    project_id = str(proj_res["project_id"])
    proj = svc.get_project(project_id)
    assert proj.agent_model_overrides == {agent_id: "conn_heavy_reasoning"}
    assert proj.agent_tool_overrides == {agent_id: ["web_search", "document_read"]}

    # Update project overrides
    svc.apply(
        actor,
        "cmd_p2",
        "project.update",
        {
            "project_id": project_id,
            "expected_version": proj.version,
            "agent_model_overrides": {agent_id: "conn_super_claude"},
        },
    )
    proj_updated = svc.get_project(project_id)
    assert proj_updated.agent_model_overrides == {agent_id: "conn_super_claude"}
    # Verify tool overrides were preserved if not updated
    assert proj_updated.agent_tool_overrides == {agent_id: ["web_search", "document_read"]}


def test_work_set_project(service: tuple[DomainService, Actor]) -> None:
    svc, actor = service
    conv = svc.apply(actor, "cmd_c1", "conversation.create", {"title": "Conversazione Lavoro"})
    conv_id = str(conv["conversation_id"])

    work = svc.apply(
        actor,
        "cmd_w1",
        "work.create",
        {
            "conversation_id": conv_id,
            "title": "Analisi Listini",
            "objective": "Verifica prezzi",
        },
    )
    work_id = str(work["work_id"])
    w_entity = svc.get_work(work_id)
    assert w_entity.project_id is None

    proj = svc.apply(actor, "cmd_pr1", "project.create", {"name": "Progetto Retail"})
    proj_id = str(proj["project_id"])

    # Move work to project
    res = svc.apply(
        actor,
        "cmd_w2",
        "work.set_project",
        {
            "work_id": work_id,
            "expected_version": w_entity.version,
            "project_id": proj_id,
        },
    )
    assert res["project_id"] == proj_id
    assert svc.get_work(work_id).project_id == proj_id

    # Detach work from project
    res_detached = svc.apply(
        actor,
        "cmd_w3",
        "work.set_project",
        {
            "work_id": work_id,
            "expected_version": svc.get_work(work_id).version,
            "project_id": None,
        },
    )
    assert res_detached["project_id"] is None
    assert svc.get_work(work_id).project_id is None


