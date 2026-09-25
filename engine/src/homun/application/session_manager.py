"""SessionManager: lifecycle, cwd restoration, rewind, fork lineage, and export/import (H30/H31).

Homun maintains sessions with working directory restoration, carrier-aware turn rewind,
forked branching with lineage tracking, secret-redacted export, transcript import without
identity drift, and SQLite FTS-backed storage with integrity repair and usage accounting.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from homun.application.session_contracts import (
    RewindOutcome,
    SessionLineage,
    SessionMessage,
    SessionRecord,
    SessionUsage,
)
from homun.application.session_storage import SessionStorage
from homun.storage.paths import default_data_dir

logger = logging.getLogger(__name__)

# Patterns for secret redaction during export
_SECRET_PATTERNS = [
    re.compile(r"(?:sk-|anthropic-|ghp_|gho_|xoxb-|xoxp-)[a-zA-Z0-9_\-]{16,}"),
    re.compile(r"Bearer\s+[a-zA-Z0-9_\.\-]{16,}", re.IGNORECASE),
    re.compile(r'(?i)(?:api_key|secret_key|private_key|token|password)\s*[:=]\s*["\']?([a-zA-Z0-9_\-\.]{12,})["\']?'),
]

_GLOBAL_DEFAULT_STORAGE: Optional[SessionStorage] = None


def get_default_storage() -> SessionStorage:
    """Return process-wide session storage.

    Product default is a durable SQLite file under HOMUN_DATA_DIR.
    Use HOMUN_SESSION_DB=:memory: (or set_default_storage) for tests.
    """
    global _GLOBAL_DEFAULT_STORAGE
    if _GLOBAL_DEFAULT_STORAGE is None:
        override = os.environ.get("HOMUN_SESSION_DB")
        if override == ":memory:":
            path: str | Path = ":memory:"
        elif override:
            path = Path(override).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
        else:
            path = default_data_dir() / "sessions.sqlite"
            path.parent.mkdir(parents=True, exist_ok=True)
        _GLOBAL_DEFAULT_STORAGE = SessionStorage(path)
    return _GLOBAL_DEFAULT_STORAGE


def set_default_storage(storage: Optional[SessionStorage]) -> None:
    global _GLOBAL_DEFAULT_STORAGE
    _GLOBAL_DEFAULT_STORAGE = storage


def redact_secrets(text: str) -> str:
    """Sanitize API keys, bearer tokens, and private credentials from text."""
    if not text:
        return ""
    result = text
    for pat in _SECRET_PATTERNS:
        result = pat.sub("[REDACTED_SECRET]", result)
    return result


class SessionManager:
    """Manager for agent sessions, cwd restoration, rewind, fork lineage, and accounting."""

    def __init__(self, workspace_id: str = "default", storage: Optional[SessionStorage] = None):
        self.workspace_id = str(workspace_id or "default")
        self.storage = storage or get_default_storage()

    # --- CRUD Operations ---

    def create_session(
        self,
        *,
        cwd: str = "",
        title: Optional[str] = None,
        parent_id: Optional[str] = None,
        forked_at_turn: Optional[int] = None,
        model_pin: Optional[str] = None,
        provider_pin: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        now: Optional[float] = None,
    ) -> SessionRecord:
        curr = time.time() if now is None else float(now)
        session_id = f"session-{uuid.uuid4().hex[:8]}"

        session = SessionRecord(
            id=session_id,
            workspace_id=self.workspace_id,
            title=title.strip() if title else f"Session {session_id[:12]}",
            cwd=cwd.strip(),
            status="active",
            pinned=False,
            parent_id=parent_id,
            forked_at_turn=forked_at_turn,
            created_at=curr,
            updated_at=curr,
            last_active_at=curr,
            model_pin=model_pin.strip() if model_pin else None,
            provider_pin=provider_pin.strip() if provider_pin else None,
            message_count=0,
            metadata=dict(metadata or {}),
        )
        self.storage.save_session(session)
        return session

    def get_session(self, session_id: str) -> Optional[SessionRecord]:
        return self.storage.get_session(session_id)

    def update_session(
        self,
        session_id: str,
        *,
        title: Optional[str] = None,
        cwd: Optional[str] = None,
        pinned: Optional[bool] = None,
        archived: Optional[bool] = None,
        model_pin: Optional[str] = None,
        provider_pin: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        now: Optional[float] = None,
    ) -> SessionRecord:
        session = self.get_session(session_id)
        if not session or session.status == "cleared":
            raise ValueError(f"Session not found: {session_id}")

        curr = time.time() if now is None else float(now)
        session.updated_at = curr

        if title is not None:
            session.title = title.strip() or None
        if cwd is not None:
            session.cwd = cwd.strip()
        if pinned is not None:
            session.pinned = bool(pinned)
        if archived is not None:
            session.status = "archived" if archived else "active"
        if model_pin is not None:
            session.model_pin = model_pin.strip() or None
        if provider_pin is not None:
            session.provider_pin = provider_pin.strip() or None
        if metadata is not None:
            session.metadata.update(metadata)

        self.storage.save_session(session)
        return session

    def list_sessions(
        self,
        *,
        include_archived: bool = False,
        query: Optional[str] = None,
    ) -> List[SessionRecord]:
        return self.storage.list_sessions(self.workspace_id, include_archived=include_archived, query=query)

    def delete_session(self, session_id: str, hard: bool = False) -> bool:
        return self.storage.delete_session(session_id, hard=hard)

    # --- Resume & Working Directory Restoration (H30) ---

    def resume_session(self, session_id: str, now: Optional[float] = None) -> Dict[str, Any]:
        """Resume session, confirming status and providing restored working directory (cwd)."""
        session = self.get_session(session_id)
        if not session or session.status == "cleared":
            raise ValueError(f"Cannot resume: session {session_id} not found or cleared")

        curr = time.time() if now is None else float(now)
        session.last_active_at = curr
        if session.status == "archived":
            session.status = "active"
        self.storage.save_session(session)

        return {
            "session": session.to_dict(),
            "restored_cwd": session.cwd,
            "message_count": session.message_count,
        }

    # --- Pin & Archive (H30) ---

    def pin_session(self, session_id: str, pinned: bool = True) -> SessionRecord:
        return self.update_session(session_id, pinned=pinned)

    def archive_session(self, session_id: str, archived: bool = True) -> SessionRecord:
        return self.update_session(session_id, archived=archived)

    # --- Pruning (H30) ---

    def prune_sessions(
        self,
        older_than_seconds: float,
        *,
        include_archived: bool = False,
        dry_run: bool = False,
        now: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Prune unpinned inactive sessions older than threshold."""
        curr = time.time() if now is None else float(now)
        threshold_ts = curr - float(older_than_seconds)
        all_sessions = self.storage.list_sessions(self.workspace_id, include_archived=True)

        candidates = []
        for s in all_sessions:
            if s.pinned:
                continue
            if s.status == "archived" and not include_archived:
                continue
            if s.last_active_at <= threshold_ts:
                candidates.append(s)

        if not dry_run:
            for s in candidates:
                self.delete_session(s.id, hard=False)

        return {
            "threshold_seconds": older_than_seconds,
            "candidates_count": len(candidates),
            "candidates": [s.id for s in candidates],
            "dry_run": dry_run,
        }

    # --- Messages and Transcript ---

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        turn_index: Optional[int] = None,
        tool_name: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        tool_calls: Optional[str] = None,
        tokens: int = 0,
        metadata: Optional[Dict[str, Any]] = None,
        now: Optional[float] = None,
    ) -> SessionMessage:
        session = self.get_session(session_id)
        if not session or session.status == "cleared":
            raise ValueError(f"Session not found: {session_id}")

        curr = time.time() if now is None else float(now)
        msg_id = f"msg-{uuid.uuid4().hex[:8]}"

        if turn_index is None:
            active_msgs = self.storage.get_messages(session_id, only_active=True)
            turn_index = (active_msgs[-1].turn_index + 1) if active_msgs else 0

        msg = SessionMessage(
            id=msg_id,
            session_id=session_id,
            turn_index=turn_index,
            role=role,
            content=content,
            timestamp=curr,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            tool_calls=tool_calls,
            active=1,
            compacted=0,
            tokens=tokens,
            metadata=dict(metadata or {}),
        )
        self.storage.append_message(msg)
        return msg

    def get_messages(self, session_id: str, *, only_active: bool = True) -> List[SessionMessage]:
        return self.storage.get_messages(session_id, only_active=only_active)

    # --- Carrier-aware Rewind (H30) ---

    def rewind_session(self, session_id: str, target_turn: int) -> RewindOutcome:
        """Soft-deactivate messages starting from target_turn, preserving history authority."""
        session = self.get_session(session_id)
        if not session or session.status == "cleared":
            raise ValueError(f"Session not found: {session_id}")

        deactivated = self.storage.rewind_messages(session_id, target_turn)
        remaining = self.storage.get_messages(session_id, only_active=True)
        last_turn = remaining[-1].turn_index if remaining else -1

        return RewindOutcome(
            session_id=session_id,
            target_turn=target_turn,
            messages_deactivated=deactivated,
            active_messages_remaining=len(remaining),
            last_active_turn=last_turn,
        )

    # --- Fork and Lineage (H30) ---

    def fork_session(
        self,
        source_session_id: str,
        *,
        at_turn_index: Optional[int] = None,
        title: Optional[str] = None,
        now: Optional[float] = None,
    ) -> SessionRecord:
        """Create a new child session branching from source at at_turn_index."""
        source = self.get_session(source_session_id)
        if not source or source.status == "cleared":
            raise ValueError(f"Source session not found: {source_session_id}")

        curr = time.time() if now is None else float(now)
        new_title = title or f"{source.title or 'Session'} (Fork)"
        new_session = self.create_session(
            cwd=source.cwd,
            title=new_title,
            parent_id=source_session_id,
            forked_at_turn=at_turn_index,
            model_pin=source.model_pin,
            provider_pin=source.provider_pin,
            metadata={"forked_from": source_session_id},
            now=curr,
        )

        copied = self.storage.copy_messages_for_fork(source_session_id, new_session.id, at_turn_index)
        new_session.message_count = copied
        return new_session

    def get_lineage(self, session_id: str) -> SessionLineage:
        """Trace ancestors up to root and all direct child sessions."""
        session = self.get_session(session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        # 1. Trace ancestors
        ancestors: List[str] = []
        curr_parent = session.parent_id
        while curr_parent:
            ancestors.append(curr_parent)
            parent_record = self.get_session(curr_parent)
            if not parent_record or not parent_record.parent_id or parent_record.parent_id in ancestors:
                break
            curr_parent = parent_record.parent_id

        # 2. Find children
        all_sessions = self.storage.list_sessions(self.workspace_id, include_archived=True)
        children = [s.id for s in all_sessions if s.parent_id == session_id]

        return SessionLineage(
            session_id=session_id,
            parent_id=session.parent_id,
            forked_at_turn=session.forked_at_turn,
            ancestors=ancestors,
            children=children,
        )

    # --- Export with Redaction and Import without Drift (H30) ---

    def export_session(
        self,
        session_id: str,
        *,
        fmt: str = "jsonl",
        redact: bool = True,
    ) -> str:
        """Export session transcript to JSONL or Markdown with secret redaction."""
        session = self.get_session(session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        messages = self.get_messages(session_id, only_active=True)
        fmt_norm = fmt.strip().lower()

        if fmt_norm == "jsonl":
            lines = []
            header = {"type": "session_meta", "session": session.to_dict()}
            lines.append(json.dumps(header))
            for m in messages:
                content = redact_secrets(m.content) if redact else m.content
                rec = {
                    "type": "message",
                    "id": m.id,
                    "session_id": m.session_id,
                    "turn_index": m.turn_index,
                    "role": m.role,
                    "content": content,
                    "timestamp": m.timestamp,
                    "tool_name": m.tool_name,
                    "tool_call_id": m.tool_call_id,
                }
                lines.append(json.dumps(rec))
            return "\n".join(lines) + "\n"

        if fmt_norm in {"markdown", "md"}:
            md_lines = [
                f"# Session: {session.title or session.id}",
                f"- **ID:** `{session.id}`",
                f"- **CWD:** `{session.cwd or 'none'}`",
                f"- **Status:** `{session.status}`",
                f"- **Messages:** {len(messages)}",
                "",
                "## Transcript",
                "",
            ]
            for m in messages:
                content = redact_secrets(m.content) if redact else m.content
                md_lines.append(f"### Turn {m.turn_index} [{m.role.upper()}]")
                if m.tool_name:
                    md_lines.append(f"*Tool: {m.tool_name}*")
                md_lines.append(content)
                md_lines.append("")
            return "\n".join(md_lines)

        raise ValueError(f"Unsupported export format: {fmt!r}")

    def import_session(
        self,
        data: str,
        *,
        title: Optional[str] = None,
        now: Optional[float] = None,
    ) -> SessionRecord:
        """Import transcript text without identity drift (clean ID generation if collision)."""
        lines = [line.strip() for line in (data or "").splitlines() if line.strip()]
        if not lines:
            raise ValueError("Import data cannot be empty")

        curr = time.time() if now is None else float(now)
        session_meta: Optional[Dict[str, Any]] = None
        imported_messages: List[Dict[str, Any]] = []

        for line in lines:
            try:
                rec = json.loads(line)
            except Exception as exc:
                continue

            rec_type = rec.get("type")
            if rec_type == "session_meta" and "session" in rec:
                session_meta = rec["session"]
            elif rec_type == "message" or "role" in rec:
                imported_messages.append(rec)

        orig_id = (session_meta.get("id") if session_meta else "") or f"session-{uuid.uuid4().hex[:8]}"
        existing = self.get_session(orig_id)
        # Avoid identity drift: if ID exists, generate fresh unique ID
        target_id = f"import-{uuid.uuid4().hex[:8]}" if existing else orig_id
        target_title = title or (session_meta.get("title") if session_meta else None) or f"Imported Session {target_id[:12]}"
        target_cwd = (session_meta.get("cwd") if session_meta else "") or ""

        session = SessionRecord(
            id=target_id,
            workspace_id=self.workspace_id,
            title=target_title,
            cwd=target_cwd,
            status="active",
            pinned=False,
            created_at=curr,
            updated_at=curr,
            last_active_at=curr,
            message_count=0,
            metadata={"imported": True, "original_id": orig_id},
        )
        self.storage.save_session(session)

        for idx, m in enumerate(imported_messages):
            msg_id = f"msg-{uuid.uuid4().hex[:8]}"
            self.storage.append_message(SessionMessage(
                id=msg_id,
                session_id=target_id,
                turn_index=int(m.get("turn_index") if m.get("turn_index") is not None else idx),
                role=str(m.get("role") or "user"),
                content=str(m.get("content") or ""),
                timestamp=float(m.get("timestamp") or curr),
                tool_name=m.get("tool_name"),
                tool_call_id=m.get("tool_call_id"),
                active=1,
            ))

        return session

    # --- Handoff Context (H30) ---

    def handoff_session(self, source_session_id: str, target_profile: Optional[str] = None) -> Dict[str, Any]:
        """Produce structured handoff context packet for transferring to another agent or profile."""
        session = self.get_session(source_session_id)
        if not session:
            raise ValueError(f"Session not found: {source_session_id}")

        messages = self.get_messages(source_session_id, only_active=True)
        recent_context = messages[-5:] if len(messages) >= 5 else messages

        return {
            "status": "handoff_ready",
            "source_session_id": source_session_id,
            "target_profile": target_profile or "default",
            "cwd": session.cwd,
            "title": session.title,
            "total_turns": session.message_count,
            "recent_turns": [
                {"role": m.role, "content": m.content[:300], "turn_index": m.turn_index}
                for m in recent_context
            ],
            "exported_at": time.time(),
        }

    # --- Token Accounting and Repair (H31) ---

    def record_usage(self, session_id: str, prompt_tokens: int, completion_tokens: int, cost: float) -> None:
        self.storage.record_usage(session_id, prompt_tokens, completion_tokens, cost)

    def get_usage(self, session_id: Optional[str] = None) -> SessionUsage:
        return self.storage.get_usage(self.workspace_id, session_id)

    def check_integrity(self) -> Dict[str, Any]:
        healthy, issues = self.storage.run_integrity_check()
        return {"healthy": healthy, "issues": issues}

    def repair_integrity(self) -> Dict[str, Any]:
        repair_res = self.storage.repair_database()
        healthy, remaining = self.storage.run_integrity_check()
        return {"repair_result": repair_res, "healthy": healthy, "remaining_issues": remaining}
