"""F5 fetta 3 — lato peer: abbonamento agli eventi e proiezione locale.

La proiezione remota vive in una tabella dedicata del proprio engine,
SEPARATA dallo spazio locale (Fonte: motore remoto, mai mescolato).
Il cursor persiste per riprendere senza gap né duplicati dopo una
disconnessione; gli eventi arrivano ordinati per sequence dell'host."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

PROJECTION_TABLE = "remote_projections"


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {PROJECTION_TABLE} (
            host TEXT NOT NULL,
            project_id TEXT NOT NULL,
            cursor INTEGER NOT NULL DEFAULT 0,
            snapshot TEXT NOT NULL DEFAULT '{{}}',
            events TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (host, project_id)
        )
    """)
    conn.commit()
    return conn


class RemoteProjection:
    """Il progetto di uno spazio remoto visto da questo peer, read-only."""

    def __init__(self, db_path: Path, host: str, project_id: str) -> None:
        self._conn = _connect(db_path)
        self.host = host.rstrip("/")
        self.project_id = project_id
        self._conn.execute(
            f"INSERT OR IGNORE INTO {PROJECTION_TABLE} (host, project_id, cursor, updated_at)"
            " VALUES (?,?,0,datetime('now'))", (self.host, project_id))
        self._conn.commit()

    @property
    def cursor(self) -> int:
        row = self._conn.execute(
            f"SELECT cursor FROM {PROJECTION_TABLE} WHERE host=? AND project_id=?",
            (self.host, self.project_id)).fetchone()
        return int(row[0]) if row else 0

    def store_snapshot(self, snapshot: dict[str, Any]) -> None:
        self._conn.execute(
            f"UPDATE {PROJECTION_TABLE} SET snapshot=?, cursor=?, updated_at=datetime('now')"
            " WHERE host=? AND project_id=?",
            (json.dumps(snapshot, ensure_ascii=False), snapshot.get("cursor", 0),
             self.host, self.project_id))
        self._conn.commit()

    def append_events(self, events: list[dict[str, Any]], cursor: int) -> None:
        current = self._conn.execute(
            f"SELECT events FROM {PROJECTION_TABLE} WHERE host=? AND project_id=?",
            (self.host, self.project_id)).fetchone()
        stored = json.loads(current[0]) if current and current[0] else []
        seen = {e["sequence"] for e in stored}
        stored.extend(e for e in events if e["sequence"] not in seen)
        stored.sort(key=lambda e: e["sequence"])
        self._conn.execute(
            f"UPDATE {PROJECTION_TABLE} SET events=?, cursor=?, updated_at=datetime('now')"
            " WHERE host=? AND project_id=?",
            (json.dumps(stored[-2000:], ensure_ascii=False), cursor,
             self.host, self.project_id))
        self._conn.commit()

    def view(self) -> dict[str, Any]:
        """Stato attuale: snapshot + eventi, marcato Fonte: motore remoto."""
        row = self._conn.execute(
            f"SELECT snapshot, events, cursor FROM {PROJECTION_TABLE}"
            " WHERE host=? AND project_id=?",
            (self.host, self.project_id)).fetchone()
        snapshot, events, cursor = row or ("{}", "[]", 0)
        return {"source": "remote-engine", "host": self.host,
                "project_id": self.project_id,
                "snapshot": json.loads(snapshot), "events": json.loads(events),
                "cursor": int(cursor)}


def sync_remote_project(connection, db_path: Path, project_id: str) -> dict[str, Any]:
    """Bootstrap (se serve) + incremento con cursor. Idempotente."""
    from homun.peers.pairing_client import remote_request
    projection = RemoteProjection(db_path, connection.host, project_id)
    if projection.cursor == 0:
        snapshot = remote_request(
            connection,
            f"/v1/workspaces/{connection.workspace_id}/remote/snapshot?project_id={project_id}")
        projection.store_snapshot(snapshot)
    while True:
        page = remote_request(
            connection,
            f"/v1/workspaces/{connection.workspace_id}/remote/events"
            f"?project_id={project_id}&cursor={projection.cursor}")
        projection.append_events(page["items"], page["cursor"])
        if not page["has_more"] or not page["items"]:
            break
    return projection.view()
