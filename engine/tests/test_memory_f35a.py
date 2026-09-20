"""F3.5a MemoryPort — approved local notes with project isolation."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.errors import NotFoundError, ValidationError
from homun.memory.sqlite_port import SqliteMemoryPort


@pytest.fixture
def memory_port(tmp_path: Path) -> SqliteMemoryPort:
    conn = sqlite3.connect(tmp_path / "mem.db")
    return SqliteMemoryPort(conn, "ws_test")


def test_add_list_and_project_isolation(memory_port: SqliteMemoryPort) -> None:
    a = memory_port.add_approved(
        text="Cliente Acme preferisce PDF",
        actor_id="person_fabio",
        work_id="work_1",
        project_id="proj_a",
    )
    memory_port.add_approved(
        text="Progetto B: tono formale",
        actor_id="person_fabio",
        project_id="proj_b",
    )
    only_a = memory_port.list(project_id="proj_a")
    assert len(only_a) == 1
    assert only_a[0].id == a.id
    assert only_a[0].text == "Cliente Acme preferisce PDF"


def test_rectify_and_delete(memory_port: SqliteMemoryPort) -> None:
    note = memory_port.add_approved(text="Bozza", actor_id="person_fabio")
    fixed = memory_port.rectify(note.id, text="Versione corretta", actor_id="person_fabio")
    assert fixed.status == "rectified"
    assert fixed.text == "Versione corretta"
    deleted = memory_port.delete(note.id, actor_id="person_fabio")
    assert deleted.status == "deleted"
    assert memory_port.list() == []
    assert len(memory_port.list(include_deleted=True)) == 1


def test_empty_text_rejected(memory_port: SqliteMemoryPort) -> None:
    with pytest.raises(ValidationError):
        memory_port.add_approved(text="   ", actor_id="person_fabio")


def test_missing_memory_raises(memory_port: SqliteMemoryPort) -> None:
    with pytest.raises(NotFoundError):
        memory_port.delete("mem_missing", actor_id="person_fabio")


def test_recall_filters_by_substring_and_project(memory_port: SqliteMemoryPort) -> None:
    memory_port.add_approved(
        text="Cliente Acme preferisce PDF",
        actor_id="person_fabio",
        project_id="proj_a",
    )
    memory_port.add_approved(
        text="Altro cliente vuole Excel",
        actor_id="person_fabio",
        project_id="proj_b",
    )
    hits = memory_port.recall("acme", project_id="proj_a")
    assert len(hits) == 1
    assert "Acme" in hits[0].text
    assert memory_port.recall("acme", project_id="proj_b") == []


def test_dual_write_falls_back_to_ledger_recall() -> None:
    import sqlite3
    from homun.memory.mem0_port import DualWriteMemoryPort

    conn = sqlite3.connect(":memory:")
    ledger = SqliteMemoryPort(conn, "ws_test")
    port = DualWriteMemoryPort(ledger, mem0=None)
    port.add_approved(text="Tono formale per Acme", actor_id="person_fabio", project_id="p1")
    assert len(port.recall("formale", project_id="p1")) == 1


def test_export_skips_deleted(memory_port: SqliteMemoryPort) -> None:
    keep = memory_port.add_approved(text="Keep", actor_id="person_fabio", project_id="p1")
    gone = memory_port.add_approved(text="Gone", actor_id="person_fabio", project_id="p1")
    memory_port.delete(gone.id, actor_id="person_fabio")
    exported = memory_port.export(project_id="p1")
    assert [n.id for n in exported] == [keep.id]


def test_memory_http_routes(tmp_path: Path) -> None:
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    try:
        created = client.post(
            f"/v1/workspaces/{ctx.workspace_id}/memories",
            json={"text": "Ricordo approvato", "project_id": "proj_x"},
            headers={"X-Homun-Actor-Id": "person_fabio"},
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["text"] == "Ricordo approvato"
        assert body["status"] == "approved"

        listed = client.get(
            f"/v1/workspaces/{ctx.workspace_id}/memories",
            params={"project_id": "proj_x"},
        )
        assert listed.status_code == 200
        assert len(listed.json()["memories"]) == 1

        mid = body["id"]
        rectified = client.post(
            f"/v1/workspaces/{ctx.workspace_id}/memories/{mid}/rectify",
            json={"text": "Aggiornato"},
            headers={"X-Homun-Actor-Id": "person_fabio"},
        )
        assert rectified.status_code == 200
        assert rectified.json()["status"] == "rectified"

        deleted = client.delete(
            f"/v1/workspaces/{ctx.workspace_id}/memories/{mid}",
            headers={"X-Homun-Actor-Id": "person_fabio"},
        )
        assert deleted.status_code == 200
        assert deleted.json()["status"] == "deleted"

        exported = client.get(f"/v1/workspaces/{ctx.workspace_id}/memories/export")
        assert exported.status_code == 200
        assert exported.json()["memories"] == []
    finally:
        reset_context_for_tests(None)
        ctx.repository.close()


def test_http_two_projects_isolation_and_export(tmp_path: Path) -> None:
    """F3.5a gate: two projects never mix on list/recall/export."""
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    reset_context_for_tests(ctx)
    client = TestClient(create_app())
    headers = {"X-Homun-Actor-Id": "person_fabio"}
    try:
        a = client.post(
            f"/v1/workspaces/{ctx.workspace_id}/memories",
            json={"text": "Segreto Acme listino", "project_id": "proj_acme"},
            headers=headers,
        )
        b = client.post(
            f"/v1/workspaces/{ctx.workspace_id}/memories",
            json={"text": "Segreto Beta log", "project_id": "proj_beta"},
            headers=headers,
        )
        assert a.status_code == 200 and b.status_code == 200

        listed_a = client.get(
            f"/v1/workspaces/{ctx.workspace_id}/memories",
            params={"project_id": "proj_acme"},
        )
        assert listed_a.status_code == 200
        texts_a = [m["text"] for m in listed_a.json()["memories"]]
        assert texts_a == ["Segreto Acme listino"]

        recall_a = client.get(
            f"/v1/workspaces/{ctx.workspace_id}/memories/recall",
            params={"q": "Segreto", "project_id": "proj_acme"},
        )
        assert recall_a.status_code == 200
        assert [m["text"] for m in recall_a.json()["memories"]] == ["Segreto Acme listino"]

        export_b = client.get(
            f"/v1/workspaces/{ctx.workspace_id}/memories/export",
            params={"project_id": "proj_beta"},
        )
        assert export_b.status_code == 200
        assert [m["text"] for m in export_b.json()["memories"]] == ["Segreto Beta log"]
    finally:
        reset_context_for_tests(None)
        ctx.repository.close()
