"""MaterialVersion B3: metadata ledger gated by AccessGrant."""

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


@pytest.fixture
def service() -> tuple[DomainService, Actor, Actor]:
    store = WorkspaceStore("ws_test")
    svc = DomainService(store)
    owner = Actor(id="person_fabio", workspace_id="ws_test", display_name="Fabio")
    other = Actor(id="person_other", workspace_id="ws_test", display_name="Other")
    return svc, owner, other


def _project_with_read(svc: DomainService, owner: Actor, other: Actor) -> str:
    project_id = str(svc.apply(owner, "cmd_p", "project.create", {"name": "P"})["project_id"])
    svc.apply(
        owner,
        "cmd_g",
        "grant.issue",
        {"project_id": project_id, "subject_id": other.id, "capability": "read"},
    )
    return project_id


def test_material_create_requires_write(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, other = service
    project_id = _project_with_read(svc, owner, other)
    with pytest.raises(PermissionDeniedError):
        svc.apply(
            other,
            "cmd_m",
            "material.create",
            {"project_id": project_id, "title": "Note", "kind": "note", "text": "hi"},
        )
    created = svc.apply(
        owner,
        "cmd_ok",
        "material.create",
        {"project_id": project_id, "title": "Note", "kind": "note", "text": "hi"},
    )
    assert created["material_id"]
    mat = svc.get_material(str(created["material_id"]))
    assert mat.text == "hi"
    assert mat.created_by == owner.id


def test_material_archive_hides_from_default(service: tuple[DomainService, Actor, Actor]) -> None:
    svc, owner, _other = service
    project_id = str(svc.apply(owner, "cmd_p", "project.create", {"name": "P"})["project_id"])
    created = svc.apply(
        owner,
        "cmd_m",
        "material.create",
        {"project_id": project_id, "title": "Link", "kind": "link", "source_uri": "https://ex"},
    )
    material_id = str(created["material_id"])
    svc.apply(
        owner,
        "cmd_arch",
        "material.archive",
        {"material_id": material_id, "expected_version": 1},
    )
    assert svc.get_material(material_id).status == "archived"


def test_http_materials_gated(tmp_path: Path) -> None:
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
        assert project.status_code == 200
        project_id = project.json()["result"]["project_id"]

        denied = client.get(
            f"/v1/workspaces/ws_local/projects/{project_id}/materials",
            headers=other_h,
        )
        assert denied.status_code == 403

        client.post(
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
        empty = client.get(
            f"/v1/workspaces/ws_local/projects/{project_id}/materials",
            headers=other_h,
        )
        assert empty.status_code == 200
        assert empty.json()["items"] == []

        create = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=owner_h,
            json={
                "command_id": "c_mat",
                "type": "material.create",
                "payload": {
                    "project_id": project_id,
                    "title": "Brief",
                    "kind": "note",
                    "text": "hello",
                },
            },
        )
        assert create.status_code == 200, create.text
        material_id = create.json()["result"]["material_id"]

        listed = client.get(
            f"/v1/workspaces/ws_local/projects/{project_id}/materials",
            headers=other_h,
        )
        assert listed.status_code == 200
        assert any(item["id"] == material_id for item in listed.json()["items"])

        got = client.get(
            f"/v1/workspaces/ws_local/materials/{material_id}",
            headers=other_h,
        )
        assert got.status_code == 200
        assert got.json()["title"] == "Brief"

        no_write = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=other_h,
            json={
                "command_id": "c_mat_bad",
                "type": "material.create",
                "payload": {"project_id": project_id, "title": "X", "kind": "note"},
            },
        )
        assert no_write.status_code == 403

        archive = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=owner_h,
            json={
                "command_id": "c_arch",
                "type": "material.archive",
                "payload": {"material_id": material_id, "expected_version": 1},
            },
        )
        assert archive.status_code == 200
        hidden = client.get(
            f"/v1/workspaces/ws_local/projects/{project_id}/materials",
            headers=owner_h,
        )
        assert hidden.status_code == 200
        assert hidden.json()["items"] == []

    reset_context_for_tests(None)
