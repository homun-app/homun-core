"""Local data paths for the Homun engine."""

from __future__ import annotations

import os
from pathlib import Path


def default_data_dir() -> Path:
    override = os.environ.get("HOMUN_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "Homun2" / "engine"


def default_db_path(workspace_id: str = "ws_local") -> Path:
    return default_data_dir() / f"{workspace_id}.sqlite3"
