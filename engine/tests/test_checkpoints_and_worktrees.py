"""Tests for filesystem checkpoints, selective rollback, working diffs, and worktrees (H12)."""
import os
import subprocess
from pathlib import Path
from homun.execution.checkpoint_manager import CheckpointManager
from homun.execution.working_diff import collect_working_diff
from homun.execution.subagent_worktree import create_subagent_worktree, cleanup_subagent_worktree


def test_checkpoint_snapshots_and_diff(tmp_path):
    work_dir = tmp_path / "project"
    work_dir.mkdir()
    (work_dir / "app.py").write_text("def run():\n    return 1\n", encoding="utf-8")

    mgr = CheckpointManager(base=tmp_path / "checkpoints")

    # Take initial checkpoint
    assert mgr.ensure_checkpoint(work_dir, "initial state") is True

    # List checkpoints
    ckpts = mgr.list_checkpoints(work_dir)
    assert len(ckpts) == 1
    assert ckpts[0]["reason"] == "initial state"
    initial_hash = ckpts[0]["hash"]

    # Modify file
    (work_dir / "app.py").write_text("def run():\n    return 2\n", encoding="utf-8")

    # Diff against initial checkpoint
    diff_res = mgr.diff(work_dir, initial_hash)
    assert diff_res["success"] is True
    assert "-    return 1" in diff_res["diff"]
    assert "+    return 2" in diff_res["diff"]


def test_selective_rollback_preserving_user_edits(tmp_path):
    work_dir = tmp_path / "project"
    work_dir.mkdir()
    file_a = work_dir / "agent_file.txt"
    file_b = work_dir / "user_file.txt"

    file_a.write_text("v1 agent content", encoding="utf-8")
    file_b.write_text("v1 user content", encoding="utf-8")

    mgr = CheckpointManager(base=tmp_path / "checkpoints")
    assert mgr.ensure_checkpoint(work_dir, "base commit") is True
    base_commit = mgr.list_checkpoints(work_dir)[0]["hash"]

    # Agent edits both files
    file_a.write_text("v2 agent content edited by agent", encoding="utf-8")
    file_b.write_text("v2 content edited by agent", encoding="utf-8")
    mgr.record_agent_write(work_dir, file_a)
    mgr.record_agent_write(work_dir, file_b)

    mgr.new_turn()
    assert mgr.ensure_checkpoint(work_dir, "agent turn 1") is True

    # User subsequently hand-edits file_b
    file_b.write_text("v3 hand edit by human user!", encoding="utf-8")

    # Safe restore to base commit:
    # file_a should be rolled back to v1
    # file_b should be SKIPPED because human edited it after the agent's write!
    mgr.new_turn()
    restore_res = mgr.restore(work_dir, base_commit, safe=True)
    assert restore_res["success"] is True
    assert "agent_file.txt" in restore_res["restored_files"]
    assert "user_file.txt" in restore_res["skipped_user_edits"]

    # Verify disk contents
    assert file_a.read_text(encoding="utf-8") == "v1 agent content"
    assert file_b.read_text(encoding="utf-8") == "v3 hand edit by human user!"


def test_single_file_selective_rollback(tmp_path):
    work_dir = tmp_path / "project"
    work_dir.mkdir()
    f1 = work_dir / "f1.txt"
    f2 = work_dir / "f2.txt"

    f1.write_text("original 1", encoding="utf-8")
    f2.write_text("original 2", encoding="utf-8")

    mgr = CheckpointManager(base=tmp_path / "checkpoints")
    mgr.ensure_checkpoint(work_dir, "initial")
    c1 = mgr.list_checkpoints(work_dir)[0]["hash"]

    f1.write_text("mutated 1", encoding="utf-8")
    f2.write_text("mutated 2", encoding="utf-8")

    # Restore only f1
    mgr.new_turn()
    res = mgr.restore(work_dir, c1, file_path="f1.txt")
    assert res["success"] is True
    assert f1.read_text(encoding="utf-8") == "original 1"
    assert f2.read_text(encoding="utf-8") == "mutated 2"


def test_working_diff_collection(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=str(repo), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(repo), check=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(repo), check=True)

    tracked = repo / "tracked.txt"
    tracked.write_text("line 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-m", "first commit"], cwd=str(repo), check=True)

    # Edit tracked file (unstaged)
    tracked.write_text("line 1\nline 2\n", encoding="utf-8")

    # Add untracked file
    untracked = repo / "new_file.txt"
    untracked.write_text("brand new\n", encoding="utf-8")

    # Collect working diff
    res = collect_working_diff(str(repo), mode="working")
    assert res["success"] is True
    assert "+line 2" in res["diff"]
    assert "new_file.txt" in res["untracked"]
    assert "+brand new" in res["diff"]


def test_subagent_worktree_lifecycle(tmp_path):
    repo = tmp_path / "git_project"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=str(repo), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(repo), check=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=str(repo), check=True)

    readme = repo / "README.md"
    readme.write_text("# Project\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=str(repo), check=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=str(repo), check=True)

    # Create subagent worktree
    wt = create_subagent_worktree(str(repo), subagent_id="test_worker")
    assert wt is not None
    wt_path = Path(wt["path"])
    assert wt_path.exists()
    assert (wt_path / "README.md").exists()
    assert wt["branch"] == "homun-subagent/subagent-test_worker"

    # Clean up clean worktree
    clean_res = cleanup_subagent_worktree(wt)
    assert clean_res["cleaned"] is True
    assert not wt_path.exists()

    # Re-create and test refusal when uncommitted changes exist
    wt2 = create_subagent_worktree(str(repo), subagent_id="dirty_worker")
    assert wt2 is not None
    wt2_path = Path(wt2["path"])
    (wt2_path / "dirty.txt").write_text("uncommitted work", encoding="utf-8")

    # Normal cleanup should refuse due to uncommitted changes
    refuse_res = cleanup_subagent_worktree(wt2, force=False)
    assert refuse_res["cleaned"] is False
    assert refuse_res["reason"] == "uncommitted_changes"
    assert wt2_path.exists()

    # Force cleanup should succeed
    force_res = cleanup_subagent_worktree(wt2, force=True)
    assert force_res["cleaned"] is True
    assert not wt2_path.exists()
