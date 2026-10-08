"""Durable SQLite store for CronManager jobs, occurrences, incidents, and deliveries (H28/H29).

Uses HOMUN_DATA_DIR/cron.sqlite by default; :memory: only when explicitly requested.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from homun.application.cron_contracts import CronIncident, CronJob, CronOccurrence
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)


class CronStore:
    """Thread-safe SQLite persistence scoped by workspace_id."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        if self.db_path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cron_jobs (
                workspace_id TEXT NOT NULL,
                job_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (workspace_id, job_id)
            );
            CREATE TABLE IF NOT EXISTS cron_occurrences (
                workspace_id TEXT NOT NULL,
                job_id TEXT NOT NULL,
                occurrence_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                run_at REAL NOT NULL,
                PRIMARY KEY (workspace_id, occurrence_id)
            );
            CREATE INDEX IF NOT EXISTS idx_cron_occ_job
                ON cron_occurrences(workspace_id, job_id, run_at);
            CREATE TABLE IF NOT EXISTS cron_incidents (
                workspace_id TEXT NOT NULL,
                job_id TEXT NOT NULL,
                incident_key TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (workspace_id, job_id, incident_key)
            );
            CREATE TABLE IF NOT EXISTS cron_deliveries (
                workspace_id TEXT NOT NULL,
                delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
                payload TEXT NOT NULL,
                enqueued_at REAL NOT NULL
            );
            """
        )
        self._conn.commit()

    def put_job(self, workspace_id: str, job: CronJob) -> None:
        blob = json.dumps(job.to_dict(), ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO cron_jobs(workspace_id, job_id, payload, updated_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(workspace_id, job_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (workspace_id, job.id, blob, time.time()),
            )
            self._conn.commit()

    def get_job(self, workspace_id: str, job_id: str) -> Optional[CronJob]:
        with self._lock:
            row = self._conn.execute(
                "SELECT payload FROM cron_jobs WHERE workspace_id = ? AND job_id = ?",
                (workspace_id, job_id),
            ).fetchone()
        if row is None:
            return None
        try:
            return CronJob.from_dict(json.loads(row["payload"]))
        except Exception as exc:
            logger.warning("Failed to decode cron job %s/%s: %s", workspace_id, job_id, exc)
            return None

    def list_jobs(self, workspace_id: str) -> List[CronJob]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT payload FROM cron_jobs WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchall()
        out: List[CronJob] = []
        for row in rows:
            try:
                out.append(CronJob.from_dict(json.loads(row["payload"])))
            except Exception as exc:
                logger.warning("Failed to decode cron job in %s: %s", workspace_id, exc)
        return out

    def delete_job(self, workspace_id: str, job_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "DELETE FROM cron_jobs WHERE workspace_id = ? AND job_id = ?",
                (workspace_id, job_id),
            )
            self._conn.commit()

    def append_occurrence(self, workspace_id: str, occ: CronOccurrence) -> None:
        blob = json.dumps(occ.to_dict(), ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO cron_occurrences(workspace_id, job_id, occurrence_id, payload, run_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id, occurrence_id) DO UPDATE SET
                    payload = excluded.payload,
                    run_at = excluded.run_at,
                    job_id = excluded.job_id
                """,
                (workspace_id, occ.job_id, occ.occurrence_id, blob, occ.run_at),
            )
            self._conn.commit()

    def list_occurrences(self, workspace_id: str, job_id: str) -> List[CronOccurrence]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT payload FROM cron_occurrences
                WHERE workspace_id = ? AND job_id = ?
                ORDER BY run_at ASC
                """,
                (workspace_id, job_id),
            ).fetchall()
        out: List[CronOccurrence] = []
        for row in rows:
            try:
                out.append(CronOccurrence.from_dict(json.loads(row["payload"])))
            except Exception as exc:
                logger.warning("Failed to decode occurrence for %s/%s: %s", workspace_id, job_id, exc)
        return out

    @staticmethod
    def _incident_key(incident: CronIncident) -> str:
        # Stable key for unresolved duplicate merge across process restarts.
        return f"{incident.error_message}|{incident.first_seen_at:.6f}"

    def put_incident(self, workspace_id: str, incident: CronIncident, *, previous_key: Optional[str] = None) -> str:
        key = previous_key or self._incident_key(incident)
        blob = json.dumps(incident.to_dict(), ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO cron_incidents(workspace_id, job_id, incident_key, payload, updated_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(workspace_id, job_id, incident_key) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (workspace_id, incident.job_id, key, blob, time.time()),
            )
            self._conn.commit()
        return key

    def list_incidents(self, workspace_id: str, job_id: str) -> List[CronIncident]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT payload FROM cron_incidents
                WHERE workspace_id = ? AND job_id = ?
                ORDER BY updated_at ASC
                """,
                (workspace_id, job_id),
            ).fetchall()
        out: List[CronIncident] = []
        for row in rows:
            try:
                out.append(CronIncident.from_dict(json.loads(row["payload"])))
            except Exception as exc:
                logger.warning("Failed to decode incident for %s/%s: %s", workspace_id, job_id, exc)
        return out

    def append_delivery(self, workspace_id: str, delivery: Dict[str, Any]) -> None:
        blob = json.dumps(delivery, ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO cron_deliveries(workspace_id, payload, enqueued_at)
                VALUES(?, ?, ?)
                """,
                (workspace_id, blob, float(delivery.get("enqueued_at") or time.time())),
            )
            self._conn.commit()

    def list_deliveries(self, workspace_id: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT payload FROM cron_deliveries
                WHERE workspace_id = ?
                ORDER BY delivery_id ASC
                """,
                (workspace_id,),
            ).fetchall()
        out: List[Dict[str, Any]] = []
        for row in rows:
            try:
                data = json.loads(row["payload"])
                if isinstance(data, dict):
                    out.append(data)
            except Exception as exc:
                logger.warning("Failed to decode delivery in %s: %s", workspace_id, exc)
        return out

    def pending_deliveries(self, workspace_id: str) -> List[Tuple[int, Dict[str, Any]]]:
        """Rowid + payload for deliveries still awaiting a dispatch attempt."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT rowid AS delivery_id, payload FROM cron_deliveries
                WHERE workspace_id = ?
                ORDER BY delivery_id ASC
                """,
                (workspace_id,),
            ).fetchall()
        out: List[Tuple[int, Dict[str, Any]]] = []
        for row in rows:
            try:
                data = json.loads(row["payload"])
                if isinstance(data, dict) and data.get("status") == "pending":
                    out.append((int(row["delivery_id"]), data))
            except Exception:
                continue
        return out

    def update_delivery(self, workspace_id: str, delivery_id: int, payload: Dict[str, Any]) -> None:
        blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        with self._lock:
            self._conn.execute(
                "UPDATE cron_deliveries SET payload=? WHERE workspace_id=? AND rowid=?",
                (blob, workspace_id, int(delivery_id)),
            )
            self._conn.commit()

    def clear_workspace(self, workspace_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM cron_jobs WHERE workspace_id = ?", (workspace_id,))
            self._conn.execute("DELETE FROM cron_occurrences WHERE workspace_id = ?", (workspace_id,))
            self._conn.execute("DELETE FROM cron_incidents WHERE workspace_id = ?", (workspace_id,))
            self._conn.execute("DELETE FROM cron_deliveries WHERE workspace_id = ?", (workspace_id,))
            self._conn.commit()

    def clear_all(self) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM cron_jobs")
            self._conn.execute("DELETE FROM cron_occurrences")
            self._conn.execute("DELETE FROM cron_incidents")
            self._conn.execute("DELETE FROM cron_deliveries")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()


_GLOBAL: Optional[CronStore] = None
_LOCK = threading.Lock()


def default_cron_db_path() -> Path:
    override = os.environ.get("HOMUN_CRON_DB")
    if override:
        return Path(override).expanduser().resolve()
    return default_data_dir() / "cron.sqlite"


def get_cron_store() -> CronStore:
    global _GLOBAL
    with _LOCK:
        if _GLOBAL is None:
            path = default_cron_db_path()
            if str(path) != ":memory:":
                path.parent.mkdir(parents=True, exist_ok=True)
            _GLOBAL = CronStore(path)
        return _GLOBAL


def set_cron_store(store: Optional[CronStore]) -> None:
    global _GLOBAL
    with _LOCK:
        _GLOBAL = store
