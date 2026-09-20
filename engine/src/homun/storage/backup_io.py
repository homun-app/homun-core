"""Shared backup io."""
from __future__ import annotations
from pathlib import Path
import hashlib
import sqlite3
from homun.storage.backup_types import BackupError


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _export_sqlite_copy(
    source_db: Path,
    dest_db: Path,
    live_connection: sqlite3.Connection | None = None,
) -> None:
    dest_db.parent.mkdir(parents=True, exist_ok=True)
    if dest_db.exists():
        raise BackupError(f"Backup database already exists: {dest_db}")

    if live_connection is not None:
        dest = sqlite3.connect(dest_db)
        try:
            live_connection.backup(dest)
            dest.commit()
        finally:
            dest.close()
        return

    if not source_db.exists():
        raise BackupError(f"Source database missing: {source_db}")

    source = sqlite3.connect(source_db.resolve().as_uri()+"?mode=ro", uri=True)
    dest = sqlite3.connect(dest_db)
    try:
        source.backup(dest)
        dest.commit()
    finally:
        dest.close()
        source.close()


def _assert_clean_destination(destination: Path) -> None:
    if destination.is_symlink():
        raise BackupError("Restore destination must not be a symbolic link")
    if not destination.exists():
        return
    if not destination.is_dir():
        raise BackupError(f"Destination is not a directory: {destination}")
    remaining = [p for p in destination.iterdir() if p.name != ".DS_Store"]
    if remaining:
        raise BackupError(
            f"Destination is not empty: {destination}. Restore only targets a clean directory."
        )

