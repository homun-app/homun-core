"""Shared backup types."""
from __future__ import annotations
from pathlib import Path
from dataclasses import dataclass
from typing import Any


class BackupError(Exception):
    """Backup or restore failed with an explicit reason."""


@dataclass(frozen=True)
class BackupManifest:
    format: str
    version: int
    created_at: str
    workspace_id: str
    files: list[dict[str, Any]]
    notes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "version": self.version,
            "created_at": self.created_at,
            "workspace_id": self.workspace_id,
            "files": self.files,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BackupManifest:
        return cls(
            format=str(data.get("format", "")),
            version=int(data.get("version", 0)),
            created_at=str(data.get("created_at", "")),
            workspace_id=str(data.get("workspace_id", "")),
            files=list(data.get("files") or []),
            notes=list(data.get("notes") or []),
        )

