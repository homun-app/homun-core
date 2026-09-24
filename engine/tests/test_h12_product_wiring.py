"""H12 product wiring: checkpoints before approved workspace writes."""
from __future__ import annotations

from pathlib import Path

from homun.application.workspace_checkpoints import (
    get_checkpoint_manager,
    note_agent_write,
    set_checkpoint_manager,
    snapshot_before_write,
)
from homun.execution.checkpoint_manager import CheckpointManager, _project_hash


def test_snapshot_before_write_records_checkpoint(tmp_path):
    work = tmp_path / "ws"
    work.mkdir()
    (work / "a.txt").write_text("one\n")
    mgr = CheckpointManager(base=tmp_path / "ck")
    set_checkpoint_manager(mgr)

    assert snapshot_before_write(work, reason="pre-write:a.txt") is True
    listed = mgr.list_checkpoints(work)
    assert listed
    assert "pre-write:a.txt" in listed[0]["reason"]

    (work / "a.txt").write_text("two\n")
    note_agent_write(work, work / "a.txt")
    ledger = mgr._load_ledger(_project_hash(work))
    assert ledger
    assert any(Path(k).name == "a.txt" for k in ledger)

    set_checkpoint_manager(None)


def test_default_checkpoint_base_under_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("HOMUN_DATA_DIR", str(tmp_path / "data"))
    set_checkpoint_manager(None)
    mgr = get_checkpoint_manager()
    assert Path(mgr.base) == (tmp_path / "data" / "checkpoints")
    set_checkpoint_manager(None)
