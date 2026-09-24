"""Write approval gate and pending execution ledger (H40).

Derived from Hermes tools/write_approval.py and tools/approval.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Provides approval boundaries for cross-session writes across memory, skills, workspace,
and external side-effects. Denied actions produce zero side effects with an auditable
refusal; approved actions execute strictly once.
"""
from __future__ import annotations

import json
import sqlite3
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)

SUBSYSTEMS = ("memory", "skills", "workspace", "terminal", "general")

STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_REJECTED = "rejected"


@dataclass
class PendingActionRecord:
    id: str
    subsystem: str
    action: str
    summary: str
    payload: Dict[str, Any]
    origin: str = "foreground"
    status: str = STATUS_PENDING
    created_at: float = field(default_factory=time.time)
    resolved_at: Optional[float] = None
    rejection_reason: Optional[str] = None
    executed: bool = False


class WriteApprovalGate:
    """Approval gate managing staged writes and single-execution guarantees."""

    def __init__(self, pending_dir: Optional[Path] = None) -> None:
        self._enabled_subsystems: Dict[str, bool] = {
            "memory": True,
            "skills": True,
            "workspace": False,
            "terminal": True,
            "general": False,
        }
        self._lock = threading.Lock()
        self._records: Dict[str, PendingActionRecord] = {}
        if pending_dir is None:
            pending_dir = default_data_dir() / "write_approvals"
        self._pending_dir = Path(pending_dir)
        self._pending_dir.mkdir(parents=True, exist_ok=True)
        self._db_path = self._pending_dir / "approvals.sqlite"
        self._conn = self._open_db()
        self._load_from_db()


    def _open_db(self):
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.commit()
        return conn

    def _load_from_db(self) -> None:
        rows = self._conn.execute("SELECT id, payload FROM approvals").fetchall()
        for action_id, payload in rows:
            try:
                data = json.loads(payload)
                self._records[action_id] = PendingActionRecord(
                    id=str(data.get("id") or action_id),
                    subsystem=str(data.get("subsystem") or "general"),
                    action=str(data.get("action") or ""),
                    summary=str(data.get("summary") or ""),
                    payload=dict(data.get("payload") or {}),
                    origin=str(data.get("origin") or "foreground"),
                    status=str(data.get("status") or STATUS_PENDING),
                    created_at=float(data.get("created_at") or time.time()),
                    resolved_at=data.get("resolved_at"),
                    rejection_reason=data.get("rejection_reason"),
                    executed=bool(data.get("executed")),
                )
            except Exception as exc:
                logger.warning("Failed to load approval %s: %s", action_id, exc)

    def _persist(self, record: PendingActionRecord) -> None:
        self._conn.execute(
            """
            INSERT INTO approvals(id, payload, updated_at)
            VALUES(?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (record.id, json.dumps(asdict(record), ensure_ascii=False, sort_keys=True), time.time()),
        )
        self._conn.commit()

    def is_approval_required(self, subsystem: str) -> bool:
        """Check if write approval is active for the given subsystem."""
        return self._enabled_subsystems.get(subsystem, False)

    def set_approval_required(self, subsystem: str, enabled: bool) -> None:
        """Enable or disable write approval for a subsystem."""
        self._enabled_subsystems[subsystem] = enabled

    def stage_action(
        self,
        subsystem: str,
        action: str,
        payload: Dict[str, Any],
        *,
        summary: str,
        origin: str = "foreground",
    ) -> PendingActionRecord:
        """Stage a pending action for human or supervisory approval."""
        act_id = f"appr_{uuid.uuid4().hex[:10]}"
        record = PendingActionRecord(
            id=act_id,
            subsystem=subsystem,
            action=action,
            summary=summary.strip(),
            payload=payload,
            origin=origin,
            status=STATUS_PENDING,
            created_at=time.time(),
        )
        with self._lock:
            self._records[act_id] = record
            self._persist(record)
        return record

    def list_pending(self, subsystem: Optional[str] = None) -> List[PendingActionRecord]:
        """List currently pending actions."""
        with self._lock:
            records = list(self._records.values())
        if subsystem:
            records = [r for r in records if r.subsystem == subsystem]
        return [r for r in records if r.status == STATUS_PENDING]

    def get_record(self, action_id: str) -> Optional[PendingActionRecord]:
        """Get record by ID."""
        with self._lock:
            return self._records.get(action_id)

    def approve_and_execute(
        self,
        action_id: str,
        *,
        executor: Optional[Callable[[Dict[str, Any]], Any]] = None,
    ) -> Tuple[bool, Any, Optional[str]]:
        """Approve and execute a staged action. Enforces single-execution guarantee.

        Returns (success, result, error_message).
        """
        with self._lock:
            record = self._records.get(action_id)
            if not record:
                return False, None, f"Action '{action_id}' not found."

            if record.status == STATUS_APPROVED or record.executed:
                return False, None, f"Action '{action_id}' has already been executed."

            if record.status == STATUS_REJECTED:
                return False, None, f"Action '{action_id}' was rejected ({record.rejection_reason})."

            record.status = STATUS_APPROVED
            record.resolved_at = time.time()
            record.executed = True
            self._persist(record)

        # Execute payload handler outside lock
        if executor:
            try:
                res = executor(record.payload)
                return True, res, None
            except Exception as exc:
                logger.error("Execution of approved action %s failed: %s", action_id, exc)
                return False, None, str(exc)

        return True, {"action_id": action_id, "status": "approved_and_executed"}, None

    def reject_action(
        self,
        action_id: str,
        *,
        reason: Optional[str] = None,
    ) -> Tuple[bool, Optional[str]]:
        """Reject a staged action with an auditable refusal reason and zero side-effects.

        Returns (success, error_message).
        """
        with self._lock:
            record = self._records.get(action_id)
            if not record:
                return False, f"Action '{action_id}' not found."

            if record.executed:
                return False, f"Action '{action_id}' was already executed; cannot reject."

            record.status = STATUS_REJECTED
            record.resolved_at = time.time()
            record.rejection_reason = reason or "Denied by human supervisor."
            self._persist(record)

        return True, None


_GLOBAL_GATE: Optional[WriteApprovalGate] = None
_GATE_LOCK = threading.Lock()


def get_write_approval_gate() -> WriteApprovalGate:
    """Get singleton write approval gate instance."""
    global _GLOBAL_GATE
    with _GATE_LOCK:
        if _GLOBAL_GATE is None:
            _GLOBAL_GATE = WriteApprovalGate()
        return _GLOBAL_GATE


def reset_write_approval_gate() -> None:
    """Reset global gate (for tests)."""
    global _GLOBAL_GATE
    with _GATE_LOCK:
        _GLOBAL_GATE = None
