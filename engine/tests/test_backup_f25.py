"""F2.5 backup + restore tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor
from homun.storage.backup import BackupError, create_backup, restore_backup, verify_backup


def test_backup_roundtrip_to_clean_directory(tmp_path: Path) -> None:
    data_dir = tmp_path / "live"
    data_dir.mkdir()
    db_path = data_dir / "ws_local.sqlite3"
    ctx = create_context(workspace_id="ws_local", db_path=db_path)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    ctx.service.apply(actor, "c1", "conversation.create", {"title": "Da salvare"})
    ctx.persist()

    backups_root = tmp_path / "backups"
    backup_dir = create_backup(
        workspace_id="ws_local",
        source_db=db_path,
        backups_root=backups_root,
        live_connection=ctx.repository.connection(),
    )
    manifest = verify_backup(backup_dir)
    assert manifest.workspace_id == "ws_local"
    assert (backup_dir / "ws_local.sqlite3").is_file()
    assert (backup_dir / "manifest.json").is_file()

    restore_dir = tmp_path / "restored"
    restored_db = restore_backup(backup_dir=backup_dir, destination_data_dir=restore_dir)
    assert restored_db.is_file()

    loaded = create_context(workspace_id="ws_local", db_path=restored_db)
    titles = [c.title for c in loaded.service.store.conversations.values()]
    assert "Da salvare" in titles
    loaded.repository.close()
    ctx.repository.close()


def test_restore_rejects_non_empty_destination(tmp_path: Path) -> None:
    data_dir = tmp_path / "live"
    data_dir.mkdir()
    db_path = data_dir / "ws_local.sqlite3"
    ctx = create_context(workspace_id="ws_local", db_path=db_path)
    ctx.persist()
    backup_dir = create_backup(
        workspace_id="ws_local",
        source_db=db_path,
        backups_root=tmp_path / "backups",
        live_connection=ctx.repository.connection(),
    )
    dirty = tmp_path / "dirty"
    dirty.mkdir()
    (dirty / "noise.txt").write_text("nope", encoding="utf-8")
    with pytest.raises(BackupError, match="not empty"):
        restore_backup(backup_dir=backup_dir, destination_data_dir=dirty)
    ctx.repository.close()


def test_http_backup_create_and_list(tmp_path: Path) -> None:
    db_path = tmp_path / "ws_local.sqlite3"
    ctx = create_context(workspace_id="ws_local", db_path=db_path)
    reset_context_for_tests(ctx)
    actor = Actor(id="person_fabio", workspace_id="ws_local", display_name="Fabio")
    ctx.service.apply(actor, "http_c1", "conversation.create", {"title": "HTTP backup"})
    ctx.persist()

    app = create_app()
    with TestClient(app) as client:
        created = client.post("/v1/workspaces/ws_local/backups")
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["id"]
        assert Path(body["path"]).is_dir()
        assert (Path(body["path"]) / "manifest.json").is_file()

        listed = client.get("/v1/workspaces/ws_local/backups")
        assert listed.status_code == 200
        items = listed.json()["items"]
        assert any(item["id"] == body["id"] for item in items)

    reset_context_for_tests(None)
