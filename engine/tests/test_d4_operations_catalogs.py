"""Tests for Stage D4: Daemon restart, Batch runner canonical executor & trajectory, and catalog packs."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from homun.app import create_app
from homun.application.batch_eval_runner import (
    BatchEvalRunner,
    BatchItem,
    create_canonical_batch_executor,
)
from homun.application.daemon_lifecycle import DaemonManager
from homun.application.surface_catalog_packs import (
    BUILTIN_PACKS,
    CatalogPacksManager,
    SkillPack,
)
from homun.application.trajectory_capture import TrajectoryStore


# ---------------------------------------------------------------------------
# 1. Daemon Lifecycle: Start, Real Restart with New PID, and Stop
# ---------------------------------------------------------------------------

def test_daemon_lifecycle_start_restart_and_stop(tmp_path: Path):
    mgr = DaemonManager(run_dir=tmp_path / "daemon")

    # Start long-lived sleep child
    start_cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
    res_start = mgr.start(cmd=start_cmd)
    assert res_start["success"] is True
    pid1 = res_start["pid"]
    assert pid1 is not None
    assert mgr.is_pid_alive(pid1) is True
    assert mgr.status().is_alive is True

    # Real restart with new PID
    restart_cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
    res_restart = mgr.restart(timeout_seconds=2.0, start_cmd=restart_cmd)
    assert res_restart["success"] is True
    pid2 = res_restart["new_pid"]
    assert pid2 is not None
    assert pid2 != pid1
    assert mgr.is_pid_alive(pid2) is True
    assert mgr.is_pid_alive(pid1) is False

    # Stop daemon
    res_stop = mgr.stop(timeout_seconds=2.0)
    assert res_stop["success"] is True
    assert mgr.is_pid_alive(pid2) is False
    assert mgr.status().is_alive is False


# ---------------------------------------------------------------------------
# 2. Batch Eval Runner: Canonical Executor & Trajectory Store
# ---------------------------------------------------------------------------

def test_batch_eval_runner_with_canonical_executor(tmp_path: Path):
    data_dir = tmp_path / "homun_data"
    traj_store = TrajectoryStore(data_dir / "trajectories")

    executor = create_canonical_batch_executor(data_dir=data_dir, trajectory_store=traj_store)
    runner = BatchEvalRunner(data_dir / "eval_batches", task_executor=executor)

    items = [
        BatchItem(id="item_1", prompt="Explain binary search in one sentence."),
        BatchItem(id="item_2", prompt="What is 2 + 2?"),
    ]

    results, summary = runner.run_batch(items, run_name="test_run")

    assert summary.total_items == 2
    assert summary.completed_items == 2
    assert summary.failed_items == 0
    assert len(results) == 2
    assert results[0].success is True
    assert len(results[0].output) > 0
    assert results[1].success is True

    # Checkpoint exists
    checkpoint = data_dir / "eval_batches" / "test_run_checkpoint.jsonl"
    assert checkpoint.is_file()

    # Trajectories were recorded into the store
    trajectories = traj_store.read_trajectories()
    assert len(trajectories) >= 2


def test_research_api_batch_endpoint_uses_canonical_executor(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOMUN_DATA_DIR", str(tmp_path))
    app = create_app()
    client = TestClient(app)

    payload = {
        "items": [
            {"id": "api_item_1", "prompt": "Hello world from API evaluation"},
        ],
        "run_name": "api_eval_test",
        "concurrency": 1,
    }

    resp = client.post("/v1/research/batch/run", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"]["completed_items"] == 1
    assert len(body["results"]) == 1
    assert body["results"][0]["success"] is True


# ---------------------------------------------------------------------------
# 3. Shipped Catalog Packs: Discovery, Rich Installation, and Removal
# ---------------------------------------------------------------------------

def test_catalog_packs_inventory_installation_and_removal(tmp_path: Path):
    skills_dir = tmp_path / "skills"
    mgr = CatalogPacksManager(skills_dir=skills_dir)

    manifest = mgr.get_catalog_manifest()
    pack_ids = {p.id for p in manifest}

    # Verify complete bundled and optional packs are present
    assert "productivity" in pack_ids
    assert "research" in pack_ids
    assert "dev_essentials" in pack_ids
    assert "data_analysis" in pack_ids
    assert "sysadmin_suite" in pack_ids

    # Install productivity pack (which includes pdf_toolkit with scripts resource)
    pack = mgr.install_pack("productivity")
    assert pack.is_installed is True

    # Verify skill structure with frontmatter and resources
    pdf_skill_dir = skills_dir / "productivity" / "pdf_toolkit"
    assert pdf_skill_dir.is_dir()
    skill_md = pdf_skill_dir / "SKILL.md"
    assert skill_md.is_file()
    md_text = skill_md.read_text(encoding="utf-8")
    assert "name: \"PDF Toolkit\"" in md_text
    assert "license: \"Apache-2.0\"" in md_text
    assert "Instructions" in md_text

    # Verify resource script was installed
    script_file = pdf_skill_dir / "scripts" / "pdf_extract.py"
    assert script_file.is_file()
    assert "def extract_text" in script_file.read_text(encoding="utf-8")

    # Re-checking manifest shows productivity installed
    updated_manifest = {p.id: p.is_installed for p in mgr.get_catalog_manifest()}
    assert updated_manifest["productivity"] is True
    assert updated_manifest["research"] is False

    # Uninstall pack
    uninstalled = mgr.uninstall_pack("productivity")
    assert uninstalled is True
    assert not (skills_dir / "productivity").exists()

    final_manifest = {p.id: p.is_installed for p in mgr.get_catalog_manifest()}
    assert final_manifest["productivity"] is False
