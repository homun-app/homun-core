"""Tests for C1: registered checkpoint diff/restore approvals and LSP lifecycle.

Verifies checkpoint tools in agent tool catalog, safe restore planning, approval
enforcement for filesystem rollbacks, and truthful LSP lifecycle management.
"""
from __future__ import annotations

from pathlib import Path
import pytest
from unittest.mock import MagicMock, patch

from homun.application.agent_tool_registry import registry_for
from homun.application.checkpoint_tools import execute as checkpoint_execute
from homun.application.surface_toolset_policy import is_tool_allowed_for_surface
from homun.application.workspace_checkpoints import (
    get_checkpoint_manager,
    set_checkpoint_manager,
    snapshot_before_write,
)
from homun.domain.errors import ConflictError
from homun.domain.models import Actor
from homun.execution.checkpoint_manager import CheckpointManager
from homun.execution.file_syntax import delta as syntax_delta
from homun.execution.lsp_lifecycle import LSPService, get_lsp_service, set_lsp_service


@pytest.fixture
def workspace_fixture(tmp_path: Path):
    """Create a temporary workspace with checkpoint manager."""
    data_dir = tmp_path / "homun_data"
    data_dir.mkdir()
    cp_base = data_dir / "checkpoints"
    cp_mgr = CheckpointManager(base=cp_base)
    set_checkpoint_manager(cp_mgr)

    work_dir = tmp_path / "project_work"
    work_dir.mkdir()
    (work_dir / "app.py").write_text("print('v1')", encoding="utf-8")
    (work_dir / "config.json").write_text('{"version": 1}', encoding="utf-8")

    # Take initial checkpoint
    cp_mgr.ensure_checkpoint(work_dir, reason="initial v1")

    yield {
        "work_dir": work_dir,
        "cp_mgr": cp_mgr,
        "data_dir": data_dir,
    }

    set_checkpoint_manager(None)
    set_lsp_service(None)


def test_checkpoint_tools_registered_in_catalog(workspace_fixture):
    """When checkpoints policy is configured, all 4 tools appear in registry."""
    run = {
        "id": "run_cp_test",
        "assignee_id": "test_agent",
        "materials": [],
        "checkpoints": {"policy": "workspace-checkpoints-v1", "version": 1},
    }
    registry = registry_for(run)
    manifest = {item["name"]: item for item in registry.manifest()}

    assert "checkpoint_list" in manifest
    assert "checkpoint_diff" in manifest
    assert "checkpoint_plan_restore" in manifest
    assert "checkpoint_restore" in manifest

    assert manifest["checkpoint_list"]["replay"] == "read_only"
    assert manifest["checkpoint_diff"]["replay"] == "read_only"
    assert manifest["checkpoint_plan_restore"]["replay"] == "read_only"
    assert manifest["checkpoint_restore"]["replay"] == "never"


def test_surface_policy_denies_checkpoint_restore_in_readonly_mode():
    """In readonly mode, checkpoint_restore is blocked while list and diff are allowed."""
    policy_run = {
        "tool_policy": {
            "surface": "desktop",
            "toolset": "readonly",
            "allowed_tools": None,
            "denied_tools": [],
        }
    }
    assert is_tool_allowed_for_surface("checkpoint_list", policy_run) is True
    assert is_tool_allowed_for_surface("checkpoint_diff", policy_run) is True
    assert is_tool_allowed_for_surface("checkpoint_plan_restore", policy_run) is True
    assert is_tool_allowed_for_surface("checkpoint_restore", policy_run) is False


def test_checkpoint_list_and_diff_execution(workspace_fixture):
    """checkpoint_list returns previous commits and checkpoint_diff detects changes."""
    work_dir = workspace_fixture["work_dir"]
    # Mutate a file
    (work_dir / "app.py").write_text("print('v2 modified')", encoding="utf-8")

    ctx = MagicMock()
    actor = Actor(id="user_1", workspace_id="ws_1", display_name="User")
    run = {
        "id": "run_1",
        "work_id": "work_1",
        "_workspace_root": str(work_dir),
    }

    with patch("homun.application.checkpoint_tools.require_work_access"):
        # 1. List
        list_res = checkpoint_execute(ctx, actor, run, "checkpoint_list", {"limit": 10})
        assert list_res["count"] >= 1
        assert "checkpoints" in list_res
        latest_hash = list_res["checkpoints"][0]["hash"]

        # 2. Diff
        diff_res = checkpoint_execute(ctx, actor, run, "checkpoint_diff", {"commit_hash": latest_hash})
        assert diff_res["checkpoint"] == latest_hash
        assert "app.py" in diff_res["stat"] or "app.py" in diff_res["diff"]

        # 3. Plan restore
        plan_res = checkpoint_execute(ctx, actor, run, "checkpoint_plan_restore", {"commit_hash": latest_hash})
        assert plan_res["checkpoint"] == latest_hash
        assert "plan" in plan_res


def test_checkpoint_restore_requires_approval(workspace_fixture):
    """Executing checkpoint_restore without explicit approval fails closed with ConflictError."""
    work_dir = workspace_fixture["work_dir"]
    ctx = MagicMock()
    actor = Actor(id="user_1", workspace_id="ws_1", display_name="User")
    run = {
        "id": "run_1",
        "work_id": "work_1",
        "_workspace_root": str(work_dir),
        "_checkpoint_restore_approved": False,
    }

    with patch("homun.application.checkpoint_tools.require_work_access"):
        with pytest.raises(ConflictError) as exc:
            checkpoint_execute(ctx, actor, run, "checkpoint_restore", {"commit_hash": "head_hash"})
        assert "requires exact human approval" in str(exc.value)


def test_checkpoint_restore_succeeds_when_approved(workspace_fixture):
    """When approved, checkpoint_restore rolls back the file correctly."""
    work_dir = workspace_fixture["work_dir"]
    cp_mgr = workspace_fixture["cp_mgr"]
    cps = cp_mgr.list_checkpoints(work_dir)
    target_hash = cps[0]["hash"]

    # Mutate app.py
    (work_dir / "app.py").write_text("print('mutated corrupt text')", encoding="utf-8")
    assert "mutated" in (work_dir / "app.py").read_text(encoding="utf-8")

    ctx = MagicMock()
    actor = Actor(id="user_1", workspace_id="ws_1", display_name="User")
    run = {
        "id": "run_1",
        "work_id": "work_1",
        "_workspace_root": str(work_dir),
        "_checkpoint_restore_approved": True,
    }

    with patch("homun.application.checkpoint_tools.require_work_access"):
        res = checkpoint_execute(ctx, actor, run, "checkpoint_restore", {"commit_hash": target_hash, "safe": False})
        assert res["status"] == "restored"
        assert res["checkpoint"] == target_hash
        # File has been restored to v1
        assert (work_dir / "app.py").read_text(encoding="utf-8") == "print('v1')"


def test_lsp_lifecycle_service_management(tmp_path: Path):
    """LSPService correctly tracks workspaces, baseline snapshots, delta calculations, and clean shutdown."""
    svc = LSPService(enabled=True)
    set_lsp_service(svc)

    status = svc.get_status()
    assert "enabled" in status and status["enabled"] is True
    assert "supported_extensions" in status
    assert ".py" in status["supported_extensions"]

    ws = tmp_path / "lsp_project"
    ws.mkdir()
    svc.attach_workspace(ws)
    assert str(ws.resolve()) in svc.get_status()["tracked_workspaces"]

    # Test baseline snapshot and diagnostics delta
    file_path = ws / "test_file.py"
    baseline = [{"line": 1, "column": 1, "message": "Preexisting unused import"}]
    svc.snapshot_baseline(file_path, diagnostics=baseline)

    current_after = [
        {"line": 1, "column": 1, "message": "Preexisting unused import"},
        {"line": 5, "column": 10, "message": "New TypeError introduced"},
    ]
    delta = svc.get_diagnostics_delta(file_path, current_after)
    assert delta["baseline_count"] == 1
    assert delta["total_diagnostics"] == 2
    assert delta["introduced_count"] == 1
    assert delta["introduced"][0]["message"] == "New TypeError introduced"

    # Test release workspace
    released_count = svc.release_workspace(ws)
    assert released_count == 1
    assert str(ws.resolve()) not in svc.get_status()["tracked_workspaces"]

    # Shutdown
    svc.shutdown()
    assert len(svc._workspaces) == 0


def test_file_syntax_lsp_delta_integration():
    """file_syntax.delta reports genuine LSP status instead of hardcoded simulation."""
    svc = LSPService(enabled=False)
    set_lsp_service(svc)
    res_disabled = syntax_delta("test.py", None, "print(1)")
    assert res_disabled["lsp"] == "unavailable"

    svc_active = LSPService(enabled=True)
    set_lsp_service(svc_active)
    with patch("shutil.which", return_value="/usr/local/bin/pyright"):
        res_active = syntax_delta("test.py", None, "print(1)")
        assert res_active["lsp"] == "ready"
