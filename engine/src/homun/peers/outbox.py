"""F5 fetta 4 — outbox del peer: comandi non consegnati, UI onesta.

Niente «salvato» quando l'host non c'è: i comandi restano in attesa con
il loro stato visibile (pending / delivered / conflict), si consegnano
in ordine di coda alla riconnessione e la deduplica per command_id dell'host
rende il doppio flush innocuo."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

OUTBOX_TABLE = "remote_outbox"


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {OUTBOX_TABLE} (
            command_id TEXT PRIMARY KEY,
            host TEXT NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at TEXT
        )
    """)
    conn.commit()
    return conn


class RemoteOutbox:
    def __init__(self, db_path: Path) -> None:
        self._conn = _connect(db_path)

    def enqueue(self, *, host: str, command_id: str, type_: str, payload: dict[str, Any]) -> None:
        self._conn.execute(
            f"INSERT OR IGNORE INTO {OUTBOX_TABLE} (command_id, host, type, payload)"
            " VALUES (?,?,?,?)",
            (command_id, host.rstrip("/"), type_, json.dumps(payload, ensure_ascii=False)))
        self._conn.commit()

    def pending(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            f"SELECT command_id, host, type, payload, status, attempts, last_error, created_at"
            f" FROM {OUTBOX_TABLE} WHERE status='pending' ORDER BY created_at, command_id").fetchall()
        return [{"command_id": r[0], "host": r[1], "type": r[2],
                 "payload": json.loads(r[3]), "status": r[4], "attempts": r[5],
                 "last_error": r[6], "created_at": r[7]} for r in rows]

    def _mark(self, command_id: str, status: str, error: str | None) -> None:
        self._conn.execute(
            f"UPDATE {OUTBOX_TABLE} SET status=?, last_error=?, attempts=attempts+1,"
            " delivered_at=CASE WHEN ?='delivered' THEN datetime('now') ELSE delivered_at END"
            " WHERE command_id=?", (status, error, status, command_id))
        self._conn.commit()

    def flush(self, connection) -> dict[str, int]:
        """Consegna i pending in ordine. Host assente: restano pending.

        Un comando rifiutato dal dominio (es. version_conflict) passa a
        conflict: consegnato sì, accettato no — l'onestà della UI."""
        from homun.peers.pairing_client import remote_request
        delivered = conflicts = 0
        for entry in self.pending():
            if entry["host"] != connection.host.rstrip("/"):
                continue
            try:
                response = remote_request(
                    connection,
                    f"/v1/workspaces/{connection.workspace_id}/remote/commands",
                    method="POST",
                    payload={"command_id": entry["command_id"], "type": entry["type"],
                             "payload": entry["payload"]})
            except Exception as exc:
                self._mark(entry["command_id"], "pending", f"consegna fallita: {exc}")
                break  # host assente: gli altri restano in attesa, in ordine
            outcome = response.get("outcome") or {}
            if outcome.get("status") == "accepted":
                self._mark(entry["command_id"], "delivered", None)
                delivered += 1
            else:
                self._mark(entry["command_id"], "conflict",
                           str(outcome.get("message") or outcome.get("status")))
                conflicts += 1
        return {"delivered": delivered, "conflicts": conflicts,
                "pending": len(self.pending())}
