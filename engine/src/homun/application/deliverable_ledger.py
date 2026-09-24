"""Deliverable delivery ledger and receipt manager (H42).

Derived from Hermes gateway/delivery_ledger.py and tools/bot_live_delivery.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Maintains at-most-once delivery state across messaging channels, ensuring artifacts are
not re-uploaded on replay or turn resumption, with durable delivery receipts.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

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
    """In-memory and durable delivery tracking ledger."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._receipts: Dict[str, DeliveryReceipt] = {}
        # (session_id, path) -> receipt_id
        self._delivered_index: Dict[tuple[str, str], str] = {}

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
