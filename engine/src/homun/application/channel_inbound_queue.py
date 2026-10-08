"""Durable SQLite-backed inbound channel message queue (H32/D1).

Ensures inbound messages from messaging platforms are persisted before
processing, leased atomically, and recovered across engine restarts.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.application.gateway_contracts import ChannelMedia, ChannelMessage
from homun.storage.paths import default_data_dir


@dataclass
class InboundQueueItem:
    item_id: str
    platform: str
    channel_id: str
    user_id: str
    username: Optional[str]
    raw_payload: Dict[str, Any]
    parsed_message: Dict[str, Any]
    status: str = "pending"  # pending, processing, completed, failed, unauthorized
    created_at: float = field(default_factory=time.time)
    leased_by: Optional[str] = None
    leased_until: float = 0.0
    attempts: int = 0
    max_attempts: int = 3
    error: Optional[str] = None
    response_text: Optional[str] = None
    delivery_receipt_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> InboundQueueItem:
        return cls(
            item_id=row["item_id"],
            platform=row["platform"],
            channel_id=row["channel_id"],
            user_id=row["user_id"],
            username=row["username"],
            raw_payload=json.loads(row["raw_payload"]),
            parsed_message=json.loads(row["parsed_message"]),
            status=row["status"],
            created_at=row["created_at"],
            leased_by=row["leased_by"],
            leased_until=row["leased_until"],
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            error=row["error"],
            response_text=row["response_text"],
            delivery_receipt_id=row["delivery_receipt_id"],
        )


class InboundChannelQueue:
    """Authoritative durable queue for inbound channel events."""

    def __init__(self, db_path: Optional[Path | str] = None) -> None:
        self._lock = threading.Lock()
        self._db_path = str(db_path or default_data_dir() / "channels" / "inbound_queue.sqlite")
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._init_db()

    def _init_db(self) -> None:
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS channel_inbound_queue (
                    item_id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    username TEXT,
                    raw_payload TEXT NOT NULL,
                    parsed_message TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    leased_by TEXT,
                    leased_until REAL NOT NULL DEFAULT 0.0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 3,
                    error TEXT,
                    response_text TEXT,
                    delivery_receipt_id TEXT
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_inbound_status ON channel_inbound_queue(status, leased_until)"
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_inbound_platform ON channel_inbound_queue(platform, created_at)"
            )

    def enqueue(
        self,
        platform: str,
        raw_payload: Dict[str, Any],
        parsed_message: ChannelMessage,
        *,
        status: str = "pending",
        item_id: Optional[str] = None,
    ) -> InboundQueueItem:
        qid = item_id or f"inq_{uuid.uuid4().hex[:12]}"
        now = time.time()
        item = InboundQueueItem(
            item_id=qid,
            platform=platform.strip().lower(),
            channel_id=parsed_message.channel_id,
            user_id=parsed_message.user_id,
            username=parsed_message.username,
            raw_payload=raw_payload,
            parsed_message=parsed_message.to_dict(),
            status=status,
            created_at=now,
        )
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO channel_inbound_queue (
                    item_id, platform, channel_id, user_id, username,
                    raw_payload, parsed_message, status, created_at,
                    leased_by, leased_until, attempts, max_attempts,
                    error, response_text, delivery_receipt_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.item_id,
                    item.platform,
                    item.channel_id,
                    item.user_id,
                    item.username,
                    json.dumps(item.raw_payload),
                    json.dumps(item.parsed_message),
                    item.status,
                    item.created_at,
                    item.leased_by,
                    item.leased_until,
                    item.attempts,
                    item.max_attempts,
                    item.error,
                    item.response_text,
                    item.delivery_receipt_id,
                ),
            )
        return item

    def claim_next(
        self,
        worker_id: str,
        *,
        lease_seconds: float = 30.0,
        now: Optional[float] = None,
        platform: Optional[str] = None,
    ) -> Optional[InboundQueueItem]:
        current_time = now or time.time()
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            query = """
                SELECT * FROM channel_inbound_queue
                WHERE (status = 'pending' OR (status = 'processing' AND leased_until < ?))
            """
            params: list[Any] = [current_time]
            if platform:
                query += " AND platform = ?"
                params.append(platform.strip().lower())
            query += " ORDER BY created_at ASC LIMIT 1"

            cursor = self._conn.execute(query, params)
            row = cursor.fetchone()
            if not row:
                return None

            item_id = row["item_id"]
            new_attempts = row["attempts"] + 1
            leased_until = current_time + lease_seconds

            self._conn.execute(
                """
                UPDATE channel_inbound_queue
                SET status = 'processing',
                    leased_by = ?,
                    leased_until = ?,
                    attempts = ?
                WHERE item_id = ?
                """,
                (worker_id, leased_until, new_attempts, item_id),
            )
            # Re-fetch updated row
            cur2 = self._conn.execute("SELECT * FROM channel_inbound_queue WHERE item_id = ?", (item_id,))
            return InboundQueueItem.from_row(cur2.fetchone())

    def complete(
        self,
        item_id: str,
        response_text: str,
        delivery_receipt_id: Optional[str] = None,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                """
                UPDATE channel_inbound_queue
                SET status = 'completed',
                    response_text = ?,
                    delivery_receipt_id = ?,
                    leased_by = NULL,
                    leased_until = 0.0
                WHERE item_id = ?
                """,
                (response_text, delivery_receipt_id, item_id),
            )

    def fail(
        self,
        item_id: str,
        error: str,
        *,
        retryable: bool = True,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            cur = self._conn.execute("SELECT attempts, max_attempts FROM channel_inbound_queue WHERE item_id = ?", (item_id,))
            row = cur.fetchone()
            if not row:
                return
            new_status = "failed"
            if retryable and row["attempts"] < row["max_attempts"]:
                new_status = "pending"

            self._conn.execute(
                """
                UPDATE channel_inbound_queue
                SET status = ?,
                    error = ?,
                    leased_by = NULL,
                    leased_until = 0.0
                WHERE item_id = ?
                """,
                (new_status, str(error), item_id),
            )

    def recover_stale_claims(
        self,
        *,
        now: Optional[float] = None,
        max_age_seconds: float = 60.0,
    ) -> int:
        """Reset stuck 'processing' items whose lease expired back to 'pending' if under max_attempts."""
        current_time = now or time.time()
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            # Mark over-limit as failed
            self._conn.execute(
                """
                UPDATE channel_inbound_queue
                SET status = 'failed',
                    error = 'exceeded max retry attempts during recovery',
                    leased_by = NULL,
                    leased_until = 0.0
                WHERE status = 'processing'
                  AND leased_until < ?
                  AND attempts >= max_attempts
                """,
                (current_time,),
            )
            # Reset recoverable items to pending
            cursor = self._conn.execute(
                """
                UPDATE channel_inbound_queue
                SET status = 'pending',
                    leased_by = NULL,
                    leased_until = 0.0
                WHERE status = 'processing'
                  AND leased_until < ?
                  AND attempts < max_attempts
                """,
                (current_time,),
            )
            return cursor.rowcount

    def get_item(self, item_id: str) -> Optional[InboundQueueItem]:
        with self._lock, self._conn:
            cur = self._conn.execute("SELECT * FROM channel_inbound_queue WHERE item_id = ?", (item_id,))
            row = cur.fetchone()
            return InboundQueueItem.from_row(row) if row else None

    def list_items(
        self,
        *,
        platform: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 50,
    ) -> List[InboundQueueItem]:
        with self._lock, self._conn:
            query = "SELECT * FROM channel_inbound_queue WHERE 1=1"
            params: list[Any] = []
            if platform:
                query += " AND platform = ?"
                params.append(platform.strip().lower())
            if status:
                query += " AND status = ?"
                params.append(status.strip().lower())
            query += " ORDER BY created_at DESC LIMIT ?"
            params.append(limit)
            rows = self._conn.execute(query, params).fetchall()
            return [InboundQueueItem.from_row(r) for r in rows]


_GLOBAL_INBOUND_QUEUE: Optional[InboundChannelQueue] = None


def get_inbound_channel_queue() -> InboundChannelQueue:
    global _GLOBAL_INBOUND_QUEUE
    if _GLOBAL_INBOUND_QUEUE is None:
        _GLOBAL_INBOUND_QUEUE = InboundChannelQueue()
    return _GLOBAL_INBOUND_QUEUE


def reset_inbound_channel_queue() -> None:
    global _GLOBAL_INBOUND_QUEUE
    _GLOBAL_INBOUND_QUEUE = None
