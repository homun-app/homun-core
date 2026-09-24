"""Configuration lifecycle and schema migration engine for Homun.

Manages versioned config schema transitions, validation, and automated backups.
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field

CURRENT_CONFIG_SCHEMA_VERSION = 2


class ConfigMigrationResult(BaseModel):
    success: bool
    from_version: int
    to_version: int
    backup_path: Optional[str] = None
    applied_migrations: List[str] = Field(default_factory=list)
    message: str = ""


class ConfigLifecycleManager:
    """Handles config loading, schema migrations, and version verification."""

    def __init__(self, config_dir: Path) -> None:
        self.config_dir = config_dir
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.config_file = self.config_dir / "config.json"
        self.backups_dir = self.config_dir / "backups"
        self.backups_dir.mkdir(parents=True, exist_ok=True)

    def load_raw_config(self) -> Dict[str, Any]:
        """Load raw configuration JSON or return initial v2 default."""
        if not self.config_file.exists():
            default_cfg = {
                "schema_version": CURRENT_CONFIG_SCHEMA_VERSION,
                "terminal": {"backend": "docker", "timeout": 300},
                "safety": {"egress_filtering": True, "approval_required": True},
                "providers": {"profiles": []},
            }
            self.save_config(default_cfg)
            return default_cfg

        try:
            return json.loads(self.config_file.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError(f"Corrupted config file at {self.config_file}: {exc}") from exc

    def save_config(self, config_data: Dict[str, Any]) -> None:
        """Atomically persist configuration data."""
        tmp = self.config_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(config_data, indent=2), encoding="utf-8")
        tmp.replace(self.config_file)

    def backup_config(self) -> Path:
        """Create a timestamped backup before migrations or destructive edits."""
        if not self.config_file.exists():
            return Path("")
        ts = int(time.time())
        dest = self.backups_dir / f"config_backup_{ts}.json"
        dest.write_text(self.config_file.read_text(encoding="utf-8"), encoding="utf-8")
        return dest

    def get_schema_version(self, config_data: Dict[str, Any]) -> int:
        """Extract schema version, defaulting to 1 for legacy unversioned configs."""
        return int(config_data.get("schema_version") or 1)

    def migrate(self) -> ConfigMigrationResult:
        """Run pending schema migrations sequentially up to CURRENT_CONFIG_SCHEMA_VERSION."""
        raw = self.load_raw_config()
        current_v = self.get_schema_version(raw)

        if current_v == CURRENT_CONFIG_SCHEMA_VERSION:
            return ConfigMigrationResult(
                success=True,
                from_version=current_v,
                to_version=current_v,
                message="Config schema is up to date",
            )

        backup_file = self.backup_config()
        working = copy.deepcopy(raw)
        applied = []

        try:
            # Migration: v1 -> v2
            if current_v < 2:
                working, note = self._migrate_v1_to_v2(working)
                applied.append(note)

            working["schema_version"] = CURRENT_CONFIG_SCHEMA_VERSION
            self.save_config(working)

            return ConfigMigrationResult(
                success=True,
                from_version=current_v,
                to_version=CURRENT_CONFIG_SCHEMA_VERSION,
                backup_path=str(backup_file) if backup_file.name else None,
                applied_migrations=applied,
                message=f"Migrated config schema from v{current_v} to v{CURRENT_CONFIG_SCHEMA_VERSION}",
            )
        except Exception as exc:
            # Restore backup if migration fails
            if backup_file.exists():
                self.config_file.write_text(backup_file.read_text(encoding="utf-8"), encoding="utf-8")
            return ConfigMigrationResult(
                success=False,
                from_version=current_v,
                to_version=current_v,
                backup_path=str(backup_file) if backup_file.name else None,
                message=f"Migration failed and rolled back: {exc}",
            )

    def _migrate_v1_to_v2(self, data: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
        """Migration v1 -> v2:
        - Relocates top-level 'terminal_env' to 'terminal.backend'
        - Ensures 'safety.egress_filtering' exists
        - Normalizes 'providers' to dict structure
        """
        # 1. Terminal backend
        if "terminal_env" in data:
            val = data.pop("terminal_env")
            data.setdefault("terminal", {})["backend"] = val

        # 2. Safety defaults
        safety = data.setdefault("safety", {})
        if "egress_filtering" not in safety:
            safety["egress_filtering"] = True
        if "approval_required" not in safety:
            safety["approval_required"] = True

        # 3. Providers structure
        providers = data.get("providers")
        if isinstance(providers, list):
            data["providers"] = {"profiles": providers}
        elif not isinstance(providers, dict):
            data["providers"] = {"profiles": []}

        return data, "v1_to_v2: normalized terminal, safety, and provider structures"
