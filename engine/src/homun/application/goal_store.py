"""Durable SQLite store for GoalManager state (H25).

Replaces the process-local dict so goals survive engine restarts.
Uses HOMUN_DATA_DIR/goals.sqlite by default; :memory: only when explicitly requested.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
import threading
from pathlib import Path
from typing import Optional

from homun.application.goal_contracts import GoalState
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)


class GoalStore:
    """Thread-safe SQLite persistence for session goal state."""

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
            CREATE TABLE IF NOT EXISTS goals (
                session_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        self._conn.commit()

    def get(self, session_id: str) -> Optional[GoalState]:
        if not session_id:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT payload FROM goals WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            data = json.loads(row["payload"])
            return GoalState.from_dict(data)
        except Exception as exc:
            logger.warning("Failed to decode goal for %s: %s", session_id, exc)
            return None

    def put(self, session_id: str, state: GoalState) -> None:
        if not session_id or state is None:
            return
        payload = json.dumps(state.to_dict(), ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO goals(session_id, payload, updated_at)
                VALUES(?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (session_id, payload, time.time()),
            )
            self._conn.commit()

    def delete(self, session_id: str) -> None:
        if not session_id:
            return
        with self._lock:
            self._conn.execute("DELETE FROM goals WHERE session_id = ?", (session_id,))
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()


_GLOBAL_GOAL_STORE: Optional[GoalStore] = None
_STORE_LOCK = threading.Lock()


def default_goal_db_path() -> Path:
    override = os.environ.get("HOMUN_GOAL_DB")
    if override:
        return Path(override).expanduser().resolve()
    return default_data_dir() / "goals.sqlite"


def get_goal_store() -> GoalStore:
    global _GLOBAL_GOAL_STORE
    with _STORE_LOCK:
        if _GLOBAL_GOAL_STORE is None:
            path = default_goal_db_path()
            if str(path) != ":memory:":
                path.parent.mkdir(parents=True, exist_ok=True)
            _GLOBAL_GOAL_STORE = GoalStore(path)
        return _GLOBAL_GOAL_STORE


def set_goal_store(store: Optional[GoalStore]) -> None:
    global _GLOBAL_GOAL_STORE
    with _STORE_LOCK:
        _GLOBAL_GOAL_STORE = store
