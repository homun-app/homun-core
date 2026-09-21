"""Consistent SQLite + manifest backup/restore (F2.5).

Encryption at rest is still D-CRYPTO-01 — backups are not a security boundary.
Restore only targets an empty directory; never overwrites a live data dir in place.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from homun.storage.backup_types import BackupError, BackupManifest
from homun.storage.backup_io import _sha256_file, _export_sqlite_copy, _assert_clean_destination
from homun.storage.schema import UnsupportedSchemaVersion, validate_schema_version
from homun.storage.sqlite import _open_connection

BACKUP_FORMAT = "homun-engine-backup"
BACKUP_FORMAT_VERSION = 1


def _validate_workspace_version(database: Path, encryption_key: bytes | None = None) -> None:
    """Check the snapshot's version without initializing or migrating it."""
    from homun.storage.encryption import EncryptionError
    try:
        with closing(_open_connection(database, encryption_key, readonly=True)) as conn:
            validate_schema_version(conn)
    except UnsupportedSchemaVersion as exc:
        raise BackupError(str(exc)) from exc
    except BackupError:
        raise
    except EncryptionError as exc:
        raise BackupError(f'Workspace key required or wrong: {exc}') from exc
    except sqlite3.Error as exc:
        raise BackupError('Invalid workspace database') from exc








def create_backup(
    *,
    workspace_id: str,
    source_db: Path,
    backups_root: Path,
    live_connection: sqlite3.Connection | None = None,
    stamp: str | None = None,
    encryption_key: bytes | None = None,
) -> Path:
    """Write a consistent SQLite copy + manifest under backups_root/<stamp>/."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", workspace_id):
        raise BackupError("Invalid backup workspace identity")
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", stamp):
        raise BackupError("Invalid backup directory name")
    backup_dir = backups_root / stamp
    if backup_dir.exists():
        raise BackupError(f"Backup directory already exists: {backup_dir}")
    backup_dir.mkdir(parents=True, exist_ok=False)

    db_name = f"{workspace_id}.sqlite3"
    dest_db = backup_dir / db_name
    try:
        _export_sqlite_copy(source_db, dest_db, live_connection=live_connection,
                            encryption_key=encryption_key)
        _validate_workspace_version(dest_db, encryption_key)
        digest = _sha256_file(dest_db)
        manifest = BackupManifest(
            format=BACKUP_FORMAT,
            version=BACKUP_FORMAT_VERSION,
            created_at=datetime.now(timezone.utc).isoformat(),
            workspace_id=workspace_id,
            files=[
                {
                    "name": db_name,
                    "sha256": digest,
                    "bytes": dest_db.stat().st_size,
                }
            ],
            notes=[
                "Consistent SQLite online backup (sqlite3.Connection.backup).",
                *(["Workspace database is SQLCipher-encrypted; verification and "
                   "restore require the same workspace key."]
                  if encryption_key is not None else
                  ["Encryption at rest is not included (D-CRYPTO-01)."]),
                "File materials/blobs are not part of this F2.5 slice.",
            ],
        )
        (backup_dir / "manifest.json").write_text(
            json.dumps(manifest.to_dict(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except Exception:
        shutil.rmtree(backup_dir, ignore_errors=True)
        raise
    return backup_dir


def read_manifest(backup_dir: Path) -> BackupManifest:
    manifest_path = backup_dir / "manifest.json"
    if manifest_path.is_symlink():
        raise BackupError("Manifest must not be a symbolic link")
    if not manifest_path.is_file():
        raise BackupError(f"Missing manifest.json in {backup_dir}")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise BackupError("Invalid backup manifest JSON") from exc
    if not isinstance(data, dict):
        raise BackupError("manifest.json must be an object")
    try:
        manifest = BackupManifest.from_dict(data)
    except (TypeError, ValueError) as exc:
        raise BackupError("Invalid backup manifest fields") from exc
    if manifest.format != BACKUP_FORMAT:
        raise BackupError(f"Unsupported backup format: {manifest.format}")
    if manifest.version == 2:
        from homun.storage.backup_inventory import read_inventory
        return read_inventory(backup_dir)
    if manifest.version != BACKUP_FORMAT_VERSION:
        raise BackupError(f"Unsupported backup version: {manifest.version}")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", manifest.workspace_id):
        raise BackupError("Invalid backup workspace identity")
    expected_name = f"{manifest.workspace_id}.sqlite3"
    # Version 1 represents exactly one workspace database. Extra files need a
    # newer format and an explicit recovery protocol, not arbitrary copy paths.
    if (len(manifest.files) != 1 or not isinstance(manifest.files[0], dict)
            or manifest.files[0].get("name") != expected_name):
        raise BackupError("Invalid backup inventory: expected one workspace database")
    return manifest


def verify_backup(backup_dir: Path, *, encryption_key: bytes | None = None) -> BackupManifest:
    manifest = read_manifest(backup_dir)
    if manifest.version == 2:
        from homun.storage.installation_backup import verify_installation_backup
        return verify_installation_backup(backup_dir)
    for entry in manifest.files:
        name = str(entry.get("name", ""))
        expected = str(entry.get("sha256", ""))
        path = backup_dir / name
        if path.is_symlink() or not path.resolve().is_relative_to(backup_dir.resolve()):
            raise BackupError("Backup file must remain inside the backup directory")
        if not path.is_file():
            raise BackupError(f"Backup file missing: {name}")
        actual = _sha256_file(path)
        if actual != expected:
            raise BackupError(f"Checksum mismatch for {name}")
        expected_bytes = entry.get("bytes")
        if expected_bytes is not None and path.stat().st_size != int(expected_bytes):
            raise BackupError(f"Size mismatch for {name}")
        _validate_workspace_version(path, encryption_key)
    return manifest




def restore_backup(
    *,
    backup_dir: Path,
    destination_data_dir: Path,
    encryption_key: bytes | None = None,
) -> Path:
    """Restore verified backup files into an empty data directory."""
    manifest = verify_backup(backup_dir, encryption_key=encryption_key)
    if manifest.version == 2:
        from homun.storage.installation_backup import restore_installation_backup
        return restore_installation_backup(backup_dir, destination_data_dir)
    _assert_clean_destination(destination_data_dir)
    destination_data_dir.mkdir(parents=True, exist_ok=True)

    restored: list[Path] = []
    try:
        for entry in manifest.files:
            name = str(entry["name"])
            source = backup_dir / name
            target = destination_data_dir / name
            if target.exists():
                raise BackupError(f"Refusing to overwrite existing file: {target}")
            restored.append(target)
            shutil.copy2(source, target)
            actual = _sha256_file(target)
            if actual != str(entry["sha256"]):
                raise BackupError(f"Checksum mismatch after copy for {name}")
    except Exception:
        for path in restored:
            path.unlink(missing_ok=True)
        raise

    return destination_data_dir / f"{manifest.workspace_id}.sqlite3"


def list_backups(backups_root: Path) -> list[dict[str, Any]]:
    if not backups_root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for child in sorted(backups_root.iterdir()):
        # A manifest can exist before the atomic publication of a v2 backup.
        # Staging left by a killed writer must never appear as a completed backup.
        if child.name.startswith(".") or not child.is_dir():
            continue
        manifest_path = child / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = read_manifest(child)
            items.append(
                {
                    "id": child.name,
                    "path": str(child),
                    "created_at": manifest.created_at,
                    "workspace_id": manifest.workspace_id,
                    "files": manifest.files,
                }
            )
        except BackupError:
            continue
    return items
