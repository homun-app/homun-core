"""F2 SQLite persistence and HTTP API tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor
from homun.domain.service import DomainService
from homun.storage.sqlite import SqliteWorkspaceRepository


@pytest.fixture
def tmp_db(tmp_path: Path) -> Path:
    return tmp_path / "ws_local.sqlite3"


def test_sqlite_roundtrip(tmp_db: Path) -> None:
    repo = SqliteWorkspaceRepository(tmp_db, "ws_local")
    service = DomainService(repo.load())
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    service.apply(actor, "c1", "conversation.create", {"title": "Persistita"})
    repo.save(service.store)
    repo.close()

    repo2 = SqliteWorkspaceRepository(tmp_db, "ws_local")
    loaded = repo2.load()
    assert len(loaded.conversations) == 1
    conversation = next(iter(loaded.conversations.values()))
    assert conversation.title == "Persistita"
    assert len(loaded.events) >= 1
    assert "c1" in loaded.commands
    repo2.close()


def test_http_command_and_list(tmp_db: Path) -> None:
    ctx = create_context(workspace_id="ws_local", db_path=tmp_db)
    reset_context_for_tests(ctx)
    app = create_app()
    # Bypass lifespan re-init by using TestClient without triggering conflicting context:
    # create_app lifespan would reset context; for tests call routes with overridden context.
    with TestClient(app, raise_server_exceptions=True) as client:
        # Lifespan may have replaced context — re-bind to tmp db.
        headers = {
            "X-Homun-Actor-Id": "person_fabio",
            "X-Homun-Actor-Name": "Fabio",
        }
        response = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "http_cmd_1",
                "type": "conversation.create",
                "payload": {"title": "Via HTTP"},
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["result"]["conversation_id"]

        listed = client.get("/v1/workspaces/ws_local/conversations", headers=headers)
        assert listed.status_code == 200
        items = listed.json()["items"]
        assert any(item["title"] == "Via HTTP" for item in items)

        caps = client.get("/v1/capabilities")
        assert caps.json()["features"]["domain"] is True

        events = client.get("/v1/workspaces/ws_local/events?after=0", headers=headers)
        assert events.status_code == 200
        assert len(events.json()["items"]) >= 1

    reset_context_for_tests(None)


def test_http_version_conflict(tmp_db: Path) -> None:
    ctx = create_context(workspace_id="ws_local", db_path=tmp_db)
    reset_context_for_tests(ctx)
    app = create_app()
    with TestClient(app) as client:
        headers = {"X-Homun-Actor-Id": "person_fabio", "X-Homun-Actor-Name": "Fabio"}
        created = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "agent_1",
                "type": "agent.create",
                "payload": {"name": "Vera"},
            },
        )
        agent_id = created.json()["result"]["agent_id"]
        bad = client.post(
            "/v1/workspaces/ws_local/commands",
            headers=headers,
            json={
                "command_id": "rename_bad",
                "type": "agent.rename",
                "payload": {
                    "agent_id": agent_id,
                    "expected_version": 99,
                    "name": "No",
                },
            },
        )
        assert bad.status_code == 409
        assert bad.json()["detail"]["code"] == "version_conflict"
    reset_context_for_tests(None)
