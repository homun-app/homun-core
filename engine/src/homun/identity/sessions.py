"""Registro sessioni delle persone: token hash, revoca per persona/dispositivo.

Le sessioni vivono in una tabella dedicata dello stesso database del
workspace (creazione lazy, come memories): sono operative, non storia di
dominio. Il token in chiaro esiste solo nella risposta al riscatto."""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import Any

from contextlib import contextmanager

SESSIONS_TABLE = "person_sessions"


def person_session_table(conn) -> None:
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {SESSIONS_TABLE} (
            token_hash TEXT PRIMARY KEY,
            person_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            status TEXT NOT NULL
        )
    """)


class PersonSessionStore:
    def __init__(self, conn, lock: RLock) -> None:
        self._conn = conn
        self._lock = lock
        with self._lock:
            person_session_table(self._conn)
            self._conn.commit()

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create(self, *, person_id: str, device_id: str, token: str,
               expires_delta_days: int = 30) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=expires_delta_days)
        row = {"token_hash": self._hash(token), "person_id": person_id,
               "device_id": device_id, "created_at": now.isoformat(),
               "expires_at": expires.isoformat(), "status": "active"}
        with self._lock:
            self._conn.execute(
                f"INSERT OR REPLACE INTO {SESSIONS_TABLE} VALUES (?,?,?,?,?,?)",
                (row["token_hash"], person_id, device_id, row["created_at"],
                 row["expires_at"], row["status"]))
            self._conn.commit()
        return row

    def resolve(self, token: str) -> dict[str, Any] | None:
        """La sessione attiva per questo token, o None."""
        with self._lock:
            row = self._conn.execute(
                f"SELECT person_id, device_id, expires_at, status FROM {SESSIONS_TABLE}"
                " WHERE token_hash=?", (self._hash(token),)).fetchone()
        if row is None:
            return None
        person_id, device_id, expires_at, status = row
        if status != "active":
            return None
        try:
            if datetime.fromisoformat(expires_at) <= datetime.now(timezone.utc):
                return None
        except ValueError:
            return None
        return {"person_id": person_id, "device_id": device_id, "expires_at": expires_at}

    def revoke_person(self, person_id: str) -> None:
        with self._lock:
            self._conn.execute(
                f"UPDATE {SESSIONS_TABLE} SET status='revoked' WHERE person_id=?",
                (person_id,))
            self._conn.commit()

    def revoke_device(self, device_id: str) -> None:
        with self._lock:
            self._conn.execute(
                f"UPDATE {SESSIONS_TABLE} SET status='revoked' WHERE device_id=?",
                (device_id,))
            self._conn.commit()
