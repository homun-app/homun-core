"""Durable SQLite store for heartbeat and loop automation state (H26/H27)."""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional, TypeVar

from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)

T = TypeVar("T")


class AutomationStore:
    """Thread-safe SQLite KV for per-session automation payloads."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        if self.db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS automation_state (
                kind TEXT NOT NULL,
                session_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (kind, session_id)
            )
            """
        )
        self._conn.commit()

    def get(self, kind: str, session_id: str) -> Optional[dict[str, Any]]:
        if not kind or not session_id:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT payload FROM automation_state WHERE kind = ? AND session_id = ?",
                (kind, session_id),
            ).fetchone()
        if row is None:
            return None
        try:
            data = json.loads(row["payload"])
            return data if isinstance(data, dict) else None
        except Exception as exc:
            logger.warning("Failed to decode %s for %s: %s", kind, session_id, exc)
            return None

    def put(self, kind: str, session_id: str, payload: dict[str, Any]) -> None:
        if not kind or not session_id or payload is None:
            return
        blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO automation_state(kind, session_id, payload, updated_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(kind, session_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (kind, session_id, blob, time.time()),
            )
            self._conn.commit()

    def delete(self, kind: str, session_id: str) -> None:
        if not kind or not session_id:
            return
        with self._lock:
            self._conn.execute(
                "DELETE FROM automation_state WHERE kind = ? AND session_id = ?",
                (kind, session_id),
            )
            self._conn.commit()

    def list_all(self, kind: str) -> list[tuple[str, dict[str, Any]]]:
        if not kind:
            return []
        with self._lock:
            rows = self._conn.execute(
                "SELECT session_id, payload FROM automation_state WHERE kind = ?",
                (kind,),
            ).fetchall()
        results: list[tuple[str, dict[str, Any]]] = []
        for r in rows:
            try:
                data = json.loads(r["payload"])
                if isinstance(data, dict):
                    results.append((r["session_id"], data))
            except Exception as exc:
                logger.warning("Failed to decode entry for %s: %s", kind, exc)
        return results

    def close(self) -> None:
        with self._lock:
            self._conn.close()



_GLOBAL: Optional[AutomationStore] = None
_LOCK = threading.Lock()


def default_automation_db_path() -> Path:
    override = os.environ.get("HOMUN_AUTOMATION_DB")
    if override:
        return Path(override).expanduser().resolve()
    return default_data_dir() / "automation.sqlite"


def get_automation_store() -> AutomationStore:
    global _GLOBAL
    with _LOCK:
        if _GLOBAL is None:
            path = default_automation_db_path()
            if str(path) != ":memory:":
                path.parent.mkdir(parents=True, exist_ok=True)
            _GLOBAL = AutomationStore(path)
        return _GLOBAL


def set_automation_store(store: Optional[AutomationStore]) -> None:
    global _GLOBAL
    with _LOCK:
        _GLOBAL = store


def load_typed(kind: str, session_id: str, from_dict: Callable[[dict[str, Any]], T]) -> Optional[T]:
    data = get_automation_store().get(kind, session_id)
    if data is None:
        return None
    try:
        return from_dict(data)
    except Exception as exc:
        logger.warning("Failed to hydrate %s for %s: %s", kind, session_id, exc)
        return None


def save_typed(kind: str, session_id: str, state: Any) -> None:
    get_automation_store().put(kind, session_id, state.to_dict())
