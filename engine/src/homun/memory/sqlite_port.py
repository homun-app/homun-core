"""SQLite-backed MemoryPort (F3.5a slice A — no Mem0 yet)."""

from __future__ import annotations

import json
import sqlite3
from functools import wraps
from threading import RLock

from homun.domain.errors import NotFoundError, ValidationError
from homun.memory.types import MemoryNote, new_memory_id, utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_work ON memories(workspace_id);
"""


def _atomic_write(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._lock:
            if self._conn.in_transaction:
                raise RuntimeError("Memory connection already has an active transaction")
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                result = method(self, *args, **kwargs)
                self._conn.commit()
                return result
            except BaseException:
                self._conn.rollback()
                raise
    return wrapped


class SqliteMemoryPort:
    """Approved notes only; project isolation via project_id filter."""

    def __init__(self, conn: sqlite3.Connection, workspace_id: str) -> None:
        self._lock = RLock()
        self._conn = conn
        self.workspace_id = workspace_id
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def list(
        self,
        *,
        work_id: str | None = None,
        project_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[MemoryNote]:
        notes = self._all()
        out: list[MemoryNote] = []
        for note in notes:
            if not include_deleted and note.status == "deleted":
                continue
            if work_id is not None and note.work_id != work_id:
                continue
            if project_id is not None and note.project_id != project_id:
                continue
            out.append(note)
        out.sort(key=lambda n: n.created_at)
        return out

    @_atomic_write
    def add_approved(
        self,
        *,
        text: str,
        actor_id: str,
        work_id: str | None = None,
        project_id: str | None = None,
    ) -> MemoryNote:
        cleaned = text.strip()
        if not cleaned:
            raise ValidationError("Memory text is required")
        note = MemoryNote(
            id=new_memory_id(),
            workspace_id=self.workspace_id,
            text=cleaned,
            work_id=work_id,
            project_id=project_id,
            status="approved",
            created_by=actor_id,
        )
        self._upsert(note)
        return note

    @_atomic_write
    def rectify(self, memory_id: str, *, text: str, actor_id: str) -> MemoryNote:
        del actor_id  # reserved for audit trail
        note = self._get(memory_id)
        cleaned = text.strip()
        if not cleaned:
            raise ValidationError("Memory text is required")
        if note.status == "deleted":
            raise ValidationError("Cannot rectify a deleted memory")
        note.text = cleaned
        note.status = "rectified"
        note.updated_at = utc_now()
        self._upsert(note)
        return note

    @_atomic_write
    def delete(self, memory_id: str, *, actor_id: str) -> MemoryNote:
        del actor_id
        note = self._get(memory_id)
        note.status = "deleted"
        note.updated_at = utc_now()
        self._upsert(note)
        return note

    def export(self, *, project_id: str | None = None) -> list[MemoryNote]:
        return self.list(project_id=project_id, include_deleted=False)

    def recall(
        self,
        query: str,
        *,
        project_id: str | None = None,
        limit: int = 10,
    ) -> list[MemoryNote]:
        needle = query.strip().lower()
        if not needle:
            return []
        matches = [
            note
            for note in self.list(project_id=project_id, include_deleted=False)
            if needle in note.text.lower()
        ]
        return matches[: max(1, min(limit, 50))]

    def _all(self) -> list[MemoryNote]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT payload FROM memories WHERE workspace_id = ?",
                (self.workspace_id,),
            ).fetchall()
        return [MemoryNote.model_validate(json.loads(row[0])) for row in rows]

    def _get(self, memory_id: str) -> MemoryNote:
        row = self._conn.execute(
            "SELECT payload FROM memories WHERE id = ? AND workspace_id = ?",
            (memory_id, self.workspace_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(f"Memory not found: {memory_id}")
        return MemoryNote.model_validate(json.loads(row[0]))

    def _upsert(self, note: MemoryNote) -> None:
        payload = json.dumps(note.model_dump(mode="json"))
        self._conn.execute(
            """
            INSERT INTO memories(id, workspace_id, payload) VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
            """,
            (note.id, self.workspace_id, payload),
        )

