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
