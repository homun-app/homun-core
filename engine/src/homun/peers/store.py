"""Connessioni remote del peer (F5 pilot): chi è l'host, con che persona.

Vive in ``<data_dir>/remote-peers.db``, insieme alle proiezioni: la chiave
del dispositivo sta in ``<data_dir>/device-key.json`` (0600)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

CONNECTIONS_TABLE = "remote_connections"


def peers_db_path(data_dir: Path) -> Path:
    return data_dir / "remote-peers.db"


def device_key_path(data_dir: Path) -> Path:
    return data_dir / "device-key.json"


def _connect(data_dir: Path) -> sqlite3.Connection:
    path = peers_db_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {CONNECTIONS_TABLE} (
            host TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            person_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            device_token TEXT NOT NULL,
            key_fingerprint TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            paired_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    return conn


class PeerConnections:
    def __init__(self, data_dir: Path) -> None:
        self._conn = _connect(data_dir)
        self._data_dir = data_dir

    def upsert(self, *, host: str, workspace_id: str, person_id: str, device_id: str,
               device_token: str, key_fingerprint: str, display_name: str = "") -> None:
        self._conn.execute(
            f"INSERT OR REPLACE INTO {CONNECTIONS_TABLE}"
            " (host, workspace_id, person_id, device_id, device_token,"
            "  key_fingerprint, display_name, paired_at)"
            " VALUES (?,?,?,?,?,?,?,datetime('now'))",
            (host.rstrip("/"), workspace_id, person_id, device_id,
             device_token, key_fingerprint, display_name))
        self._conn.commit()

    def get(self, host: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            f"SELECT host, workspace_id, person_id, device_id, device_token,"
            " key_fingerprint, display_name FROM "
            f"{CONNECTIONS_TABLE} WHERE host=?", (host.rstrip("/"),)).fetchone()
        if row is None:
            return None
        return {"host": row[0], "workspace_id": row[1], "person_id": row[2],
                "device_id": row[3], "device_token": row[4],
                "key_fingerprint": row[5], "display_name": row[6]}

    def list(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            f"SELECT host, workspace_id, person_id, device_id, key_fingerprint,"
            f" display_name, paired_at FROM {CONNECTIONS_TABLE} ORDER BY paired_at").fetchall()
        return [{"host": r[0], "workspace_id": r[1], "person_id": r[2],
                 "device_id": r[3], "key_fingerprint": r[4],
                 "display_name": r[5], "paired_at": r[6]} for r in rows]

    def connection(self, host: str):
        """La RemoteConnection per l'host noto, o None."""
        record = self.get(host)
        if record is None:
            return None
        from homun.peers.pairing_client import RemoteConnection
        return RemoteConnection(
            host=record["host"], workspace_id=record["workspace_id"],
            person_id=record["person_id"], device_id=record["device_id"],
            device_token=record["device_token"],
            key_fingerprint=record["key_fingerprint"])

def list_projections(data_dir: Path) -> list[dict[str, Any]]:
    """Le proiezioni remote sincronizzate (Fonte: motore remoto)."""
    import json as _json
    import sqlite3
    path = peers_db_path(data_dir)
    if not path.exists():
        return []
    conn = sqlite3.connect(path)
    try:
        rows = conn.execute(
            "SELECT host, project_id, cursor, snapshot FROM remote_projections"
            " ORDER BY updated_at DESC").fetchall()
    finally:
        conn.close()
    return [{"host": r[0], "project_id": r[1], "cursor": r[2],
             "source": "remote-engine",
             "project": (_json.loads(r[3]) or {}).get("project")}
            for r in rows]
