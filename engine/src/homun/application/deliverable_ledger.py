"""Durable destination-scoped delivery claims and outcome receipts.

Pending claims deliberately have no lease: a dead sender may already have sent.
Only a known failed attempt or an unsent intent is automatically retryable.
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

from homun.storage.paths import default_data_dir
from homun.application.delivery_outcomes import delivery_status


@dataclass
class DeliveryReceipt:
    receipt_id: str
    channel: str
    session_id: str
    path: str
    filename: str
    category: str
    status: str = "delivered"
    delivered_at: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)
    destination_id: str = ""


class DeliverableLedger:
    """SQLite is authoritative; separate instances never rely on stale caches."""

    def __init__(self, db_path: Optional[Path | str] = None) -> None:
        self._lock = threading.Lock()
        self._db_path = str(db_path or default_data_dir() / "deliverables" / "ledger.sqlite")
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=30)
        with self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            self._conn.execute("""CREATE TABLE IF NOT EXISTS receipts (
                receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                path TEXT NOT NULL, payload TEXT NOT NULL, delivered_at REAL NOT NULL)""")
            columns = {r[1] for r in self._conn.execute("PRAGMA table_info(receipts)")}
            if "channel" not in columns:
                self._conn.execute("ALTER TABLE receipts ADD COLUMN channel TEXT NOT NULL DEFAULT ''")
                self._conn.execute("ALTER TABLE receipts ADD COLUMN destination_id TEXT NOT NULL DEFAULT ''")
                for receipt_id, payload in self._conn.execute("SELECT receipt_id,payload FROM receipts").fetchall():
                    data = json.loads(payload)
                    metadata = data.get("metadata") or {}
                    # Old dispatcher wrote failed into metadata but hardcoded delivered.
                    if metadata.get("status") == "failed":
                        data["status"] = "failed"
                    response = metadata.get("channel_response") or {}
                    if response:
                        data["status"] = delivery_status(response, has_media=True)
                    elif metadata.get('status') != 'failed':
                        data['status'] = 'unknown'
                    metadata['legacy_unscoped'] = not bool(data.get('destination_id') or response.get('channel_id') or metadata.get('destination_id') or metadata.get('chat_id'))
                    data['metadata'] = metadata
                    data["destination_id"] = str(data.get("destination_id") or response.get("channel_id") or metadata.get("destination_id") or metadata.get("chat_id") or "")
                    self._conn.execute("UPDATE receipts SET channel=?,destination_id=?,payload=? WHERE receipt_id=?",
                        (data.get("channel", ""), data["destination_id"], json.dumps(data), receipt_id))
            self._conn.execute("DROP INDEX IF EXISTS idx_receipt_session_path")
            self._conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_scope ON receipts(session_id,channel,destination_id,path)")

    @staticmethod
    def _decode(row) -> Optional[DeliveryReceipt]:
        return DeliveryReceipt(**json.loads(row[0])) if row else None

    def _find(self, session_id, channel, destination_id, path):
        return self._decode(self._conn.execute(
            "SELECT payload FROM receipts WHERE session_id=? AND channel=? AND destination_id=? AND path=?",
            (session_id, channel, destination_id, path)).fetchone())

    def _persist(self, receipt):
        self._conn.execute("""INSERT INTO receipts
            (receipt_id,session_id,path,payload,delivered_at,channel,destination_id)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id,channel,destination_id,path)
            DO UPDATE SET receipt_id=excluded.receipt_id,payload=excluded.payload,delivered_at=excluded.delivered_at""",
            (receipt.receipt_id,receipt.session_id,receipt.path,json.dumps(asdict(receipt)),
             receipt.delivered_at,receipt.channel,receipt.destination_id))

    def is_delivered(self, session_id: str, path: str, *, channel: Optional[str] = None,
                     destination_id: Optional[str] = None) -> bool:
        return any(r.path == path and r.status == "delivered"
                   and (channel is None or r.channel == channel)
                   and (destination_id is None or r.destination_id == destination_id)
                   for r in self.list_receipts(session_id))

    def claim_delivery(self, session_id: str, channel: str, path: str, filename: str,
                       category: str, *, destination_id: str, metadata=None,
                       intent: bool = False) -> tuple[DeliveryReceipt, bool]:
        """Commit the claim before transport. The UUID fences finalization."""
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            previous = self._find(session_id, channel, destination_id, path)
            if previous is None and destination_id:
                legacy = self._find(session_id, channel, '', path)
                if legacy and legacy.metadata.get('legacy_unscoped') and legacy.status not in {'failed', 'intent'}:
                    return legacy, False
            if previous and previous.status not in {"failed", "intent"}:
                return previous, False
            receipt = DeliveryReceipt(f"dlv_{uuid.uuid4().hex}", channel, session_id,
                path, filename, category, "intent" if intent else "pending",
                metadata=dict(metadata or {}), destination_id=destination_id)
            self._persist(receipt)
            return receipt, True

    def finish_delivery(self, receipt: DeliveryReceipt, status: str, *, metadata=None) -> DeliveryReceipt:
        if status not in {"delivered", "failed", "unknown"}:
            raise ValueError("Invalid delivery outcome")
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            current = self._find(receipt.session_id, receipt.channel, receipt.destination_id, receipt.path)
            if current is None or current.receipt_id != receipt.receipt_id or current.status != "pending":
                raise ValueError("Delivery claim is no longer pending")
            current.status = status
            current.delivered_at = time.time()
            current.metadata.update(metadata or {})
            self._persist(current)
            return current

    def record_delivery(self, session_id: str, channel: str, path: str, filename: str,
                        category: str, *, metadata=None, destination_id: str = "",
                        status: str = "delivered") -> DeliveryReceipt:
        """Compatibility API for recording externally established outcomes."""
        if status not in {"delivered", "failed", "unknown", "intent"}:
            raise ValueError("Invalid delivery outcome")
        metadata = dict(metadata or {})
        if metadata.get("status") in {"failed", "unknown", "intent"}:
            status = metadata["status"]
        response = metadata.get("channel_response") or {}
        if response:
            status = delivery_status(response, has_media=True)
        with self._lock, self._conn:
            self._conn.execute("BEGIN IMMEDIATE")
            previous = self._find(session_id, channel, destination_id, path)
            if previous and previous.status not in {"failed", "intent"}:
                return previous
            receipt = DeliveryReceipt(f"dlv_{uuid.uuid4().hex}", channel, session_id,
                path, filename, category, status, metadata=metadata, destination_id=destination_id)
            self._persist(receipt)
            return receipt

    def list_receipts(self, session_id: Optional[str] = None) -> List[DeliveryReceipt]:
        with self._lock:
            rows = self._conn.execute("SELECT payload FROM receipts" +
                (" WHERE session_id=?" if session_id is not None else "") + " ORDER BY delivered_at DESC",
                (session_id,) if session_id is not None else ()).fetchall()
            return [self._decode(row) for row in rows]


_GLOBAL_DELIVERABLE_LEDGER: Optional[DeliverableLedger] = None
_LEDGER_LOCK = threading.Lock()


def get_deliverable_ledger() -> DeliverableLedger:
    global _GLOBAL_DELIVERABLE_LEDGER
    with _LEDGER_LOCK:
        if _GLOBAL_DELIVERABLE_LEDGER is None:
            _GLOBAL_DELIVERABLE_LEDGER = DeliverableLedger()
        return _GLOBAL_DELIVERABLE_LEDGER


def reset_deliverable_ledger() -> None:
    global _GLOBAL_DELIVERABLE_LEDGER
    with _LEDGER_LOCK:
        _GLOBAL_DELIVERABLE_LEDGER = None


def set_deliverable_ledger(ledger: Optional[DeliverableLedger]) -> None:
    global _GLOBAL_DELIVERABLE_LEDGER
    with _LEDGER_LOCK:
        _GLOBAL_DELIVERABLE_LEDGER = ledger

