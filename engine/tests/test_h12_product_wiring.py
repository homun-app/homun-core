"""H12 product wiring: checkpoints before approved workspace writes."""
from __future__ import annotations

from pathlib import Path

from homun.application.workspace_checkpoints import (
    get_checkpoint_manager,
    get_workspace_working_diff,
    list_workspace_checkpoints,
    note_agent_write,
    plan_workspace_restore,
    restore_workspace_checkpoint,
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


def test_workspace_working_diff_and_selective_restore(tmp_path):
    work = tmp_path / "ws"
    work.mkdir()
    file_a = work / "a.txt"
    file_b = work / "b.txt"
    file_a.write_text("initial A\n")
    file_b.write_text("initial B\n")

    mgr = CheckpointManager(base=tmp_path / "ck")
    set_checkpoint_manager(mgr)

    # Initial checkpoint
    assert snapshot_before_write(work, reason="baseline") is True
    cps = list_workspace_checkpoints(work)
    assert len(cps) == 1
    baseline_hash = cps[0]["hash"]

    # Mutate working directory: file_a written by agent, file_b edited by user
    file_a.write_text("modified A\n")
    note_agent_write(work, file_a)
    file_b.write_text("modified B\n")

    # Inspect working diff
    diff_view = get_workspace_working_diff(work)
    assert diff_view["success"] is True
    assert diff_view["checkpoint"] == baseline_hash
    assert "-initial A" in diff_view["diff"]
    assert "+modified A" in diff_view["diff"]
    assert "a.txt" in diff_view["stat"]

    # Plan restore: file_a (agent write) can be restored; file_b (user edit) is preserved
    plan = plan_workspace_restore(work, baseline_hash)
    assert plan["restore"] == ["a.txt"]
    assert plan["skipped"] == ["b.txt"]

    # Safe restore checkpoint: restores file_a, preserves file_b
    restored = restore_workspace_checkpoint(work, baseline_hash, safe=True)
    assert restored["success"] is True
    assert file_a.read_text() == "initial A\n"
    assert file_b.read_text() == "modified B\n"

    # Full restore checkpoint: restores everything
    full_restored = restore_workspace_checkpoint(work, baseline_hash, safe=False)
    assert full_restored["success"] is True
    assert file_b.read_text() == "initial B\n"


    set_checkpoint_manager(None)

