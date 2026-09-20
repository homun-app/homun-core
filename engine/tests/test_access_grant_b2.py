"""AccessGrant B2: deny-by-default project reads/writes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.errors import PermissionDeniedError
from homun.domain.models import Actor
from homun.domain.service import DomainService
from homun.domain.store import WorkspaceStore
from homun.policy import has_project_capability, list_readable_project_ids


@pytest.fixture
def service() -> tuple[DomainService, Actor, Actor]:
    store = WorkspaceStore("ws_test")
    svc = DomainService(store)
    owner = Actor(id="person_fabio", workspace_id="ws_test", display_name="Fabio")
    other = Actor(id="person_other", workspace_id="ws_test", display_name="Other")
    return svc, owner, other


def test_create_project_issues_admin_grant(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    created = svc.apply(owner, "cmd_p", "project.create", {"name": "Acme"})
    project_id = str(created["project_id"])
    assert created.get("admin_grant_id")
    assert has_project_capability(svc.store, owner.id, project_id, "admin")
    assert not has_project_capability(svc.store, other.id, project_id, "read")
    assert project_id in list_readable_project_ids(svc.store, owner.id)
    assert project_id not in list_readable_project_ids(svc.store, other.id)


def test_membership_does_not_grant_access(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    created = svc.apply(
        owner,
        "cmd_p",
        "project.create",
        {"name": "Acme", "member_ids": [owner.id, other.id]},
    )
    project_id = str(created["project_id"])
    assert other.id in svc.get_project(project_id).member_ids
    with pytest.raises(PermissionDeniedError):
        svc.apply(
            other,
            "cmd_upd",
            "project.update",
            {"project_id": project_id, "expected_version": 1, "description": "nope"},
        )


def test_issue_read_then_revoke(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    project_id = str(svc.apply(owner, "cmd_p", "project.create", {"name": "P"})["project_id"])
    issued = svc.apply(
        owner,
        "cmd_g",
        "grant.issue",
        {"project_id": project_id, "subject_id": other.id, "capability": "read"},
    )
    grant_id = str(issued["grant_id"])
    assert has_project_capability(svc.store, other.id, project_id, "read")
    assert not has_project_capability(svc.store, other.id, project_id, "write")

    svc.apply(owner, "cmd_rev", "grant.revoke", {"grant_id": grant_id})
    assert not has_project_capability(svc.store, other.id, project_id, "read")


def test_write_requires_write_grant(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    project_id = str(svc.apply(owner, "cmd_p", "project.create", {"name": "P"})["project_id"])
    svc.apply(
        owner,
        "cmd_g",
        "grant.issue",
        {"project_id": project_id, "subject_id": other.id, "capability": "read"},
    )
    with pytest.raises(PermissionDeniedError):
        svc.apply(
            other,
            "cmd_upd",
            "project.update",
            {"project_id": project_id, "expected_version": 1, "name": "Hack"},
        )
    svc.apply(
        owner,
        "cmd_gw",
        "grant.issue",
        {"project_id": project_id, "subject_id": other.id, "capability": "write"},
    )
    updated = svc.apply(
        other,
        "cmd_ok",
        "project.update",
        {"project_id": project_id, "expected_version": 1, "name": "Ok"},
    )
    assert updated["name"] == "Ok"


def test_admin_ladder_implies_write(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    project_id = str(svc.apply(owner, "cmd_p", "project.create", {"name": "P"})["project_id"])
    svc.apply(
        owner,
        "cmd_g",
        "grant.issue",
        {"project_id": project_id, "subject_id": other.id, "capability": "admin"},
    )
    assert has_project_capability(svc.store, other.id, project_id, "write")
    assert has_project_capability(svc.store, other.id, project_id, "read")


def test_grant_issue_requires_admin(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    project_id = str(svc.apply(owner, "cmd_p", "project.create", {"name": "P"})["project_id"])
    with pytest.raises(PermissionDeniedError):
        svc.apply(
            other,
            "cmd_bad",
            "grant.issue",
            {"project_id": project_id, "subject_id": other.id, "capability": "read"},
        )


def test_http_grants_filter_and_403(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    reset_context_for_tests(
        create_context(workspace_id="ws_local", db_path=db_path, data_dir=tmp_path, for_tests=True)
    )
    owner_h = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
    other_h = {"X-Homun-Actor-Id": "person_other", "X-Homun-Actor-Name": "Other"}
    app = create_app()
    with TestClient(app) as client:
        project = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=owner_h,
            json={
                "command_id": "c_proj",
                "type": "project.create",
                "payload": {"name": "Progetto"},
            },
        )
        assert project.status_code == 200, project.text
        project_id = project.json()["result"]["project_id"]

        listed_owner = client.get("/v1/workspaces/ws_local/projects", headers=owner_h)
        assert listed_owner.status_code == 200
        assert any(item["id"] == project_id for item in listed_owner.json()["items"])

        listed_other = client.get("/v1/workspaces/ws_local/projects", headers=other_h)
        assert listed_other.status_code == 200
        assert listed_other.json()["items"] == []

        denied = client.get(f"/v1/workspaces/ws_local/projects/{project_id}", headers=other_h)
        assert denied.status_code == 403

        issue = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=owner_h,
            json={
                "command_id": "c_grant",
                "type": "grant.issue",
                "payload": {
                    "project_id": project_id,
                    "subject_id": "person_other",
                    "capability": "read",
                },
            },
        )
        assert issue.status_code == 200, issue.text
        grant_id = issue.json()["result"]["grant_id"]

        visible = client.get(f"/v1/workspaces/ws_local/projects/{project_id}", headers=other_h)
        assert visible.status_code == 200

        grants = client.get(
            f"/v1/workspaces/ws_local/grants?project_id={project_id}",
            headers=owner_h,
        )
        assert grants.status_code == 200
        assert any(g["id"] == grant_id for g in grants.json()["items"])

        revoke = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=owner_h,
            json={
                "command_id": "c_rev",
                "type": "grant.revoke",
                "payload": {"grant_id": grant_id},
            },
        )
        assert revoke.status_code == 200
        denied_again = client.get(f"/v1/workspaces/ws_local/projects/{project_id}", headers=other_h)
        assert denied_again.status_code == 403

    reset_context_for_tests(None)
