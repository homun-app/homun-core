"""Deliverable delivery ledger and receipt manager (H42).

Derived from Hermes gateway/delivery_ledger.py and tools/bot_live_delivery.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Maintains at-most-once delivery state across messaging channels, ensuring artifacts are
not re-uploaded on replay or turn resumption, with durable delivery receipts.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)


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


class DeliverableLedger:
    """Durable delivery tracking ledger (SQLite under HOMUN_DATA_DIR)."""

    def __init__(self, db_path: Optional[Path | str] = None) -> None:
        self._lock = threading.Lock()
        self._receipts: Dict[str, DeliveryReceipt] = {}
        # (session_id, path) -> receipt_id
        self._delivered_index: Dict[tuple[str, str], str] = {}
        if db_path is None:
            root = default_data_dir() / "deliverables"
            root.mkdir(parents=True, exist_ok=True)
            db_path = root / "ledger.sqlite"
        self._db_path = str(db_path)
        if self._db_path != ":memory:":
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS receipts (
                receipt_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                path TEXT NOT NULL,
                payload TEXT NOT NULL,
                delivered_at REAL NOT NULL
            )
            """
        )
        self._conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_session_path ON receipts(session_id, path)"
        )
        self._conn.commit()
        self._load()

    def _load(self) -> None:
        rows = self._conn.execute("SELECT receipt_id, payload FROM receipts").fetchall()
        for receipt_id, payload in rows:
            try:
                data = json.loads(payload)
                receipt = DeliveryReceipt(
                    receipt_id=str(data.get("receipt_id") or receipt_id),
                    channel=str(data.get("channel") or ""),
                    session_id=str(data.get("session_id") or ""),
                    path=str(data.get("path") or ""),
                    filename=str(data.get("filename") or ""),
                    category=str(data.get("category") or ""),
                    status=str(data.get("status") or "delivered"),
                    delivered_at=float(data.get("delivered_at") or time.time()),
                    metadata=dict(data.get("metadata") or {}),
                )
                self._receipts[receipt.receipt_id] = receipt
                self._delivered_index[(receipt.session_id, receipt.path)] = receipt.receipt_id
            except Exception as exc:
                logger.warning("Failed to load receipt %s: %s", receipt_id, exc)

    def _persist(self, receipt: DeliveryReceipt) -> None:
        self._conn.execute(
            """
            INSERT INTO receipts(receipt_id, session_id, path, payload, delivered_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(receipt_id) DO UPDATE SET
                payload = excluded.payload,
                delivered_at = excluded.delivered_at
            """,
            (
                receipt.receipt_id,
                receipt.session_id,
                receipt.path,
                json.dumps(asdict(receipt), ensure_ascii=False, sort_keys=True),
                receipt.delivered_at,
            ),
        )
        self._conn.commit()

    def is_delivered(self, session_id: str, path: str) -> bool:
        """Check if this exact file path was already delivered to this session."""
        with self._lock:
            return (session_id, path) in self._delivered_index

    def record_delivery(
        self,
        session_id: str,
        channel: str,
        path: str,
        filename: str,
        category: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> DeliveryReceipt:
        """Record an artifact delivery receipt."""
        receipt_id = f"dlv_{uuid.uuid4().hex[:12]}"
        receipt = DeliveryReceipt(
            receipt_id=receipt_id,
            channel=channel,
            session_id=session_id,
            path=path,
            filename=filename,
            category=category,
            status="delivered",
            delivered_at=time.time(),
            metadata=metadata or {},
        )
        with self._lock:
            self._receipts[receipt_id] = receipt
            self._delivered_index[(session_id, path)] = receipt_id
            self._persist(receipt)
        return receipt

    def list_receipts(self, session_id: Optional[str] = None) -> List[DeliveryReceipt]:
        """List delivery receipts for session or all sessions."""
        with self._lock:
            receipts = list(self._receipts.values())
        if session_id:
            receipts = [r for r in receipts if r.session_id == session_id]
        return sorted(receipts, key=lambda r: r.delivered_at, reverse=True)


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
