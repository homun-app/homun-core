"""Product wiring for filesystem checkpoints around authorized workspace writes (H12).

Checkpoints are infrastructure owned by the file-mutating path, not as a
model-visible tool. Homun mirrors that: snapshots run before approved writes and agent
writes are recorded for selective rollback.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

from homun.execution.checkpoint_manager import CheckpointManager
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_GLOBAL: Optional[CheckpointManager] = None


def default_checkpoint_base() -> Path:
    return default_data_dir() / "checkpoints"


def get_checkpoint_manager(*, base: Optional[Path] = None) -> CheckpointManager:
    """Return the process checkpoint manager (HOMUN_DATA_DIR/checkpoints by default)."""
    global _GLOBAL
    with _LOCK:
        if base is not None:
            return CheckpointManager(base=base)
        if _GLOBAL is None:
            root = default_checkpoint_base()
            root.mkdir(parents=True, exist_ok=True)
            _GLOBAL = CheckpointManager(base=root)
        return _GLOBAL


def set_checkpoint_manager(manager: Optional[CheckpointManager]) -> None:
    global _GLOBAL
    with _LOCK:
        _GLOBAL = manager


def snapshot_before_write(working_dir: str | Path, reason: str = "pre-write") -> bool:
    """Take a per-turn shadow checkpoint before mutating the workspace."""
    try:
        return bool(get_checkpoint_manager().ensure_checkpoint(working_dir, reason))
    except Exception as exc:
        logger.warning("Checkpoint before write failed: %s", exc)
        return False


def note_agent_write(working_dir: str | Path, file_path: str | Path) -> None:
    """Record an agent write so selective rollback can preserve later user edits."""
    try:
        get_checkpoint_manager().record_agent_write(working_dir, file_path)
    except Exception as exc:
        logger.warning("Agent write ledger update failed: %s", exc)


def list_workspace_checkpoints(working_dir: str | Path) -> list[dict]:
    """List snapshots for a directory from most recent to oldest."""
    try:
        return get_checkpoint_manager().list_checkpoints(working_dir)
    except Exception as exc:
        logger.warning("Listing checkpoints failed: %s", exc)
        return []


def get_workspace_working_diff(working_dir: str | Path, commit_hash: Optional[str] = None) -> dict:
    """Show diff between a checkpoint (default: latest checkpoint) and current working tree."""
    mgr = get_checkpoint_manager()
    if commit_hash is None:
        cps = mgr.list_checkpoints(working_dir)
        if not cps:
            return {"success": True, "stat": "", "diff": "", "checkpoint": None}
        commit_hash = cps[0]["hash"]
    res = mgr.diff(working_dir, commit_hash)
    res["checkpoint"] = commit_hash
    return res


def plan_workspace_restore(working_dir: str | Path, commit_hash: str) -> dict:
    """Classify files into restore vs skipped (preserving subsequent user edits)."""
    return get_checkpoint_manager().safe_restore_plan(working_dir, commit_hash)


def restore_workspace_checkpoint(
    working_dir: str | Path,
    commit_hash: str,
    file_path: Optional[str | Path] = None,
    safe: bool = False,
) -> dict:
    """Restore working directory files to the specified checkpoint state."""
    return get_checkpoint_manager().restore(working_dir, commit_hash, file_path=file_path, safe=safe)


