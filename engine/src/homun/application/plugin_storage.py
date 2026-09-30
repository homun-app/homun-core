"""Persistent storage convention for Homun plugins.

Plugins store durable state under ``<homun_home>/plugin-data/<name>/``, completely
separate from their install tree ``<homun_home>/plugins/<name>/``. This guarantees that
disabling or uninstalling a plugin does not destroy its retained state (honoring
the retained-data contract) unless explicitly purged.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import sqlite3
from typing import Optional

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
_HOME_OVERRIDE: Optional[Path] = None


def get_homun_home() -> Path:
    """Return the current Homun home directory."""
    if _HOME_OVERRIDE is not None:
        return _HOME_OVERRIDE
    env = os.environ.get("HOMUN_HOME")
    if env:
        return Path(env).resolve()
    return Path.home() / ".homun"


def set_homun_home_override(path: str | Path | None) -> Optional[Path]:
    """Temporarily override Homun home (for tests / profile isolation). Returns old value."""
    global _HOME_OVERRIDE
    old = _HOME_OVERRIDE
    _HOME_OVERRIDE = Path(path).resolve() if path is not None else None
    return old


def reset_homun_home_override(old_value: Optional[Path]) -> None:
    """Restore previous Homun home override."""
    global _HOME_OVERRIDE
    _HOME_OVERRIDE = old_value


def validate_plugin_name(name: str) -> str:
    """Ensure plugin name is a safe identifier with no path traversal."""
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name) or ".." in name:
        raise ValueError(f"Invalid plugin name for storage: {name!r}")
    return name


def plugin_data_dir(name: str, base_dir: Optional[Path] = None) -> Path:
    """Return and ensure ``<homun home>/plugin-data/<name>/``.

    Guaranteed to live outside any ``plugins/`` directory.
    """
    valid_name = validate_plugin_name(name)
    home = base_dir if base_dir is not None else get_homun_home()
    root = home / "plugin-data" / valid_name
    root.mkdir(parents=True, exist_ok=True)
    return root


def plugin_db(name: str, filename: str = "data.db", base_dir: Optional[Path] = None) -> sqlite3.Connection:
    """Open an SQLite connection to a database within the plugin's data directory.

    Configured with WAL mode (where supported) and foreign key constraints enabled.
    """
    if not isinstance(filename, str) or Path(filename).name != filename or not filename or ".." in filename:
        raise ValueError(f"Invalid plugin db filename: {filename!r}")
    
    data_dir = plugin_data_dir(name, base_dir=base_dir)
    db_path = data_dir / filename
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
    except sqlite3.OperationalError:
        pass
    
    return conn


def plugins_root(base_dir=None) -> Path:
    """Install tree for user plugins: <home>/plugins/."""
    return get_homun_home() / "plugins"


def plugins_config_path(base_dir=None) -> Path:
    """Persisted enable/disable state across engine restarts."""
    return get_homun_home() / "plugins.json"


def load_plugins_config(base_dir=None) -> dict:
    import json as _json
    path = plugins_config_path(base_dir)
    try:
        data = _json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def save_plugins_config(config: dict, base_dir=None) -> None:
    import json as _json
    path = plugins_config_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json.dumps(config, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
