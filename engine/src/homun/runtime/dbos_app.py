"""DBOS process lifecycle for Homun engine (F4.1)."""

from __future__ import annotations

from pathlib import Path

from dbos import DBOS

_CONFIGURED = False
_LAUNCHED = False
_DATA_DIR: Path | None = None


def data_dir() -> Path:
    if _DATA_DIR is None:
        raise RuntimeError("DBOS runtime not configured")
    return _DATA_DIR


def receipts_dir() -> Path:
    path = data_dir() / "receipts"
    path.mkdir(parents=True, exist_ok=True)
    return path


def configure_dbos(root: Path, *, app_name: str = "homun-engine") -> None:
    """Idempotent DBOS config bound to engine data_dir."""
    global _CONFIGURED, _DATA_DIR
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    root = root.resolve()
    if _CONFIGURED:
        if root != _DATA_DIR:
            raise RuntimeError("DBOS already configured for a different data directory")
        return
    db_path = (root / "dbos.sqlite").as_posix()
    DBOS(
        config={
            "name": app_name,
            "application_version": "0.1.0",
            "system_database_url": f"sqlite:///{db_path}",
            "run_admin_server": False,
        }
    )
    _DATA_DIR = root
    _CONFIGURED = True


def launch_dbos() -> None:
    global _LAUNCHED
    if not _CONFIGURED:
        raise RuntimeError("configure_dbos() before launch_dbos()")
    if _LAUNCHED:
        return
    DBOS.launch()
    DBOS.register_queue("homun-work")
    _LAUNCHED = True


def shutdown_dbos() -> None:
    global _LAUNCHED, _CONFIGURED, _DATA_DIR
    try:
        if _CONFIGURED:
            DBOS.destroy()
    finally:
        _LAUNCHED = False
        _CONFIGURED = False
        _DATA_DIR = None


def is_launched() -> bool:
    return _LAUNCHED
