"""SQLite storage engine with WAL journaling, FTS5 search, integrity checks, and repair (H31).

Homun maintains transactional SQLite persistence for sessions and transcripts with WAL mode,
FTS5 full-text indexing, forensic integrity validation, and self-healing repair.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from homun.application.session_contracts import SessionMessage, SessionRecord, SessionUsage

logger = logging.getLogger(__name__)


class SessionStorage:
    """Thread-safe SQLite storage engine for agent sessions and messages with FTS5 and repair."""

    def __init__(self, db_path: Optional[Path | str] = None):
        self.db_path = str(db_path) if db_path else ":memory:"
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        if self._conn is None:
            if self.db_path != ":memory:":
                Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA busy_timeout = 5000")
            if self.db_path != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL")
            self._conn = conn
        return self._conn

    def _init_db(self) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    title TEXT,
                    cwd TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    pinned INTEGER NOT NULL DEFAULT 0,
                    parent_id TEXT,
                    forked_at_turn INTEGER,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_active_at REAL NOT NULL,
                    model_pin TEXT,
                    provider_pin TEXT,
                    message_count INTEGER NOT NULL DEFAULT 0,
                    prompt_tokens INTEGER NOT NULL DEFAULT 0,
                    completion_tokens INTEGER NOT NULL DEFAULT 0,
                    cost_estimate REAL NOT NULL DEFAULT 0.0,
                    metadata TEXT NOT NULL DEFAULT '{}'
                );
                """)
                conn.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    turn_index INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    tool_name TEXT,
                    tool_call_id TEXT,
                    tool_calls TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    compacted INTEGER NOT NULL DEFAULT 0,
                    tokens INTEGER NOT NULL DEFAULT 0,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn_index);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, status);")

                # FTS5 virtual table and synchronization triggers
                conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    content,
                    role,
                    tool_name,
                    tool_calls,
                    content='messages',
                    content_rowid='rowid'
                );
                """)
                conn.execute("""
                CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, content, role, tool_name, tool_calls)
                    VALUES (new.rowid, new.content, new.role, new.tool_name, new.tool_calls);
                END;
                """)
                conn.execute("""
                CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content, role, tool_name, tool_calls)
                    VALUES ('delete', old.rowid, old.content, old.role, old.tool_name, old.tool_calls);
                END;
                """)
                conn.execute("""
                CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, content, role, tool_name, tool_calls)
                    VALUES ('delete', old.rowid, old.content, old.role, old.tool_name, old.tool_calls);
                    INSERT INTO messages_fts(rowid, content, role, tool_name, tool_calls)
                    VALUES (new.rowid, new.content, new.role, new.tool_name, new.tool_calls);
                END;
                """)

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # --- Session Operations ---

    def save_session(self, session: SessionRecord) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                cursor = conn.execute("""
                INSERT INTO sessions (
                    id, workspace_id, title, cwd, status, pinned, parent_id, forked_at_turn,
                    created_at, updated_at, last_active_at, model_pin, provider_pin,
                    message_count, prompt_tokens, completion_tokens, cost_estimate, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    cwd=excluded.cwd,
                    status=excluded.status,
                    pinned=excluded.pinned,
                    parent_id=excluded.parent_id,
                    forked_at_turn=excluded.forked_at_turn,
                    updated_at=excluded.updated_at,
                    last_active_at=excluded.last_active_at,
                    model_pin=excluded.model_pin,
                    provider_pin=excluded.provider_pin,
                    message_count=excluded.message_count,
                    prompt_tokens=excluded.prompt_tokens,
                    completion_tokens=excluded.completion_tokens,
                    cost_estimate=excluded.cost_estimate,
                    metadata=excluded.metadata
                WHERE sessions.workspace_id = excluded.workspace_id;
                """, (
                    session.id, session.workspace_id, session.title, session.cwd,
                    session.status, 1 if session.pinned else 0, session.parent_id,
                    session.forked_at_turn, session.created_at, session.updated_at,
                    session.last_active_at, session.model_pin, session.provider_pin,
                    session.message_count, session.prompt_tokens, session.completion_tokens,
                    session.cost_estimate, json.dumps(session.metadata or {}),
                ))
                if cursor.rowcount != 1:
                    raise ValueError('Session belongs to another workspace')

    def get_session(self, session_id: str) -> Optional[SessionRecord]:
        with self._lock:
            conn = self._get_connection()
            cur = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
            row = cur.fetchone()
            if not row:
                return None
            return self._row_to_session(row)

    def list_sessions(
        self,
        workspace_id: str = "default",
        *,
        include_archived: bool = False,
        query: Optional[str] = None,
    ) -> List[SessionRecord]:
        with self._lock:
            conn = self._get_connection()
            conditions = ["workspace_id = ?", "status != 'cleared'"]
            params: List[Any] = [workspace_id]

            if not include_archived:
                conditions.append("status != 'archived'")

            if query and query.strip():
                # Search matching title or sessions containing matching message text in FTS
                conditions.append("""(
                    title LIKE ? OR id IN (
                        SELECT session_id FROM messages WHERE rowid IN (
                            SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?
                        )
                    )
                )""")
                search_term = f"%{query.strip()}%"
                fts_query = query.strip().replace("'", "''")
                params.extend([search_term, fts_query])

            sql = f"SELECT * FROM sessions WHERE {' AND '.join(conditions)} ORDER BY pinned DESC, last_active_at DESC"
            cur = conn.execute(sql, params)
            return [self._row_to_session(r) for r in cur.fetchall()]

    def delete_session(self, session_id: str, hard: bool = False) -> bool:
        with self._lock:
            conn = self._get_connection()
            with conn:
                if hard:
                    cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
                else:
                    cur = conn.execute("UPDATE sessions SET status = 'cleared' WHERE id = ?", (session_id,))
                return cur.rowcount > 0

    def _row_to_session(self, r: sqlite3.Row) -> SessionRecord:
        meta = {}
        try:
            meta = json.loads(r["metadata"] or "{}")
        except Exception:
            pass
        return SessionRecord(
            id=r["id"],
            workspace_id=r["workspace_id"],
            title=r["title"],
            cwd=r["cwd"],
            status=r["status"],
            pinned=bool(r["pinned"]),
            parent_id=r["parent_id"],
            forked_at_turn=r["forked_at_turn"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            last_active_at=r["last_active_at"],
            model_pin=r["model_pin"],
            provider_pin=r["provider_pin"],
            message_count=r["message_count"],
            prompt_tokens=r["prompt_tokens"],
            completion_tokens=r["completion_tokens"],
            cost_estimate=r["cost_estimate"],
            metadata=meta,
        )

    # --- Message Operations ---

    def append_message(self, msg: SessionMessage) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                INSERT INTO messages (
                    id, session_id, turn_index, role, content, timestamp,
                    tool_name, tool_call_id, tool_calls, active, compacted, tokens, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                """, (
                    msg.id, msg.session_id, msg.turn_index, msg.role, msg.content,
                    msg.timestamp, msg.tool_name, msg.tool_call_id, msg.tool_calls,
                    msg.active, msg.compacted, msg.tokens, json.dumps(msg.metadata or {}),
                ))
                # Update session metadata
                conn.execute("""
                UPDATE sessions SET
                    message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ? AND active = 1),
                    last_active_at = ?,
                    updated_at = ?
                WHERE id = ?;
                """, (msg.session_id, msg.timestamp, msg.timestamp, msg.session_id))

    def get_messages(self, session_id: str, *, only_active: bool = True) -> List[SessionMessage]:
        with self._lock:
            conn = self._get_connection()
            sql = "SELECT * FROM messages WHERE session_id = ?"
            params: List[Any] = [session_id]
            if only_active:
                sql += " AND active = 1"
            sql += " ORDER BY turn_index ASC, timestamp ASC"
            cur = conn.execute(sql, params)
            results = []
            for r in cur.fetchall():
                meta = {}
                try:
                    meta = json.loads(r["metadata"] or "{}")
                except Exception:
                    pass
                results.append(SessionMessage(
                    id=r["id"],
                    session_id=r["session_id"],
                    turn_index=r["turn_index"],
                    role=r["role"],
                    content=r["content"],
                    timestamp=r["timestamp"],
                    tool_name=r["tool_name"],
                    tool_call_id=r["tool_call_id"],
                    tool_calls=r["tool_calls"],
                    active=r["active"],
                    compacted=r["compacted"],
                    tokens=r["tokens"],
                    metadata=meta,
                ))
            return results

    def rewind_messages(self, session_id: str, from_turn: int) -> int:
        """Carrier-aware rewind: deactivates (active=0) messages from from_turn onwards."""
        with self._lock:
            conn = self._get_connection()
            with conn:
                cur = conn.execute("""
                UPDATE messages SET active = 0 WHERE session_id = ? AND turn_index >= ? AND active = 1;
                """, (session_id, from_turn))
                deactivated = cur.rowcount
                # Recalculate message_count
                conn.execute("""
                UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ? AND active = 1)
                WHERE id = ?;
                """, (session_id, session_id))
                return deactivated

    def copy_messages_for_fork(self, source_id: str, target_id: str, up_to_turn: Optional[int] = None) -> int:
        """Copy active messages from source up to up_to_turn into newly forked session."""
        with self._lock:
            conn = self._get_connection()
            with conn:
                turn_clause = " AND turn_index <= ?" if up_to_turn is not None else ""
                params: List[Any] = [source_id]
                if up_to_turn is not None:
                    params.append(up_to_turn)
                messages = conn.execute(
                    f"SELECT * FROM messages WHERE session_id = ? AND active = 1{turn_clause} ORDER BY turn_index ASC",
                    params,
                ).fetchall()

                import uuid
                copied = 0
                for r in messages:
                    new_msg_id = f"msg-{uuid.uuid4().hex[:10]}"
                    conn.execute("""
                    INSERT INTO messages (
                        id, session_id, turn_index, role, content, timestamp,
                        tool_name, tool_call_id, tool_calls, active, compacted, tokens, metadata
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                    """, (
                        new_msg_id, target_id, r["turn_index"], r["role"], r["content"],
                        r["timestamp"], r["tool_name"], r["tool_call_id"], r["tool_calls"],
                        1, r["compacted"], r["tokens"], r["metadata"],
                    ))
                    copied += 1

                conn.execute("""
                UPDATE sessions SET message_count = ? WHERE id = ?;
                """, (copied, target_id))
                return copied

    # --- Search and Accounting ---

    def search_messages_fts(self, workspace_id: str, query: str, limit: int = 50) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._get_connection()
            safe_query = query.strip().replace("'", "''")
            sql = """
            SELECT m.id, m.session_id, m.turn_index, m.role, m.content, m.timestamp, s.title as session_title
            FROM messages_fts f
            JOIN messages m ON f.rowid = m.rowid
            JOIN sessions s ON m.session_id = s.id
            WHERE messages_fts MATCH ? AND s.workspace_id = ? AND m.active = 1
            ORDER BY m.timestamp DESC
            LIMIT ?;
            """
            cur = conn.execute(sql, (safe_query, workspace_id, limit))
            return [dict(r) for r in cur.fetchall()]

    def record_usage(self, session_id: str, prompt_tokens: int, completion_tokens: int, cost: float) -> None:
        with self._lock:
            conn = self._get_connection()
            with conn:
                conn.execute("""
                UPDATE sessions SET
                    prompt_tokens = prompt_tokens + ?,
                    completion_tokens = completion_tokens + ?,
                    cost_estimate = cost_estimate + ?
                WHERE id = ?;
                """, (prompt_tokens, completion_tokens, cost, session_id))

    def get_usage(self, workspace_id: str, session_id: Optional[str] = None) -> SessionUsage:
        with self._lock:
            conn = self._get_connection()
            if session_id:
                cur = conn.execute("""
                SELECT SUM(prompt_tokens) as p, SUM(completion_tokens) as c, SUM(cost_estimate) as cost
                FROM sessions WHERE id = ? AND workspace_id = ?;
                """, (session_id, workspace_id))
            else:
                cur = conn.execute("""
                SELECT SUM(prompt_tokens) as p, SUM(completion_tokens) as c, SUM(cost_estimate) as cost
                FROM sessions WHERE workspace_id = ?;
                """, (workspace_id,))
            row = cur.fetchone()
            p = int(row["p"] or 0) if row else 0
            c = int(row["c"] or 0) if row else 0
            cost = float(row["cost"] or 0.0) if row else 0.0
            return SessionUsage(
                session_id=session_id,
                workspace_id=workspace_id,
                prompt_tokens=p,
                completion_tokens=c,
                total_tokens=p + c,
                total_cost=round(cost, 6),
            )

    # --- Integrity Check and Repair (H31) ---

    def run_integrity_check(self) -> Tuple[bool, List[str]]:
        """Validate SQLite integrity, orphaned messages, and FTS consistency."""
        with self._lock:
            conn = self._get_connection()
            issues: List[str] = []

            # 1. PRAGMA integrity_check
            cur = conn.execute("PRAGMA integrity_check;")
            rows = [r[0] for r in cur.fetchall()]
            if rows != ["ok"]:
                issues.extend(rows)

            # 2. Check for orphaned messages (messages with non-existent session_id)
            orphans = conn.execute("""
            SELECT COUNT(*) FROM messages WHERE session_id NOT IN (SELECT id FROM sessions);
            """).fetchone()[0]
            if orphans > 0:
                issues.append(f"Found {orphans} orphaned messages without parent session")

            # 3. Check FTS row count matches messages count
            fts_count = conn.execute("SELECT COUNT(*) FROM messages_fts;").fetchone()[0]
            msg_count = conn.execute("SELECT COUNT(*) FROM messages;").fetchone()[0]
            if fts_count != msg_count:
                issues.append(f"FTS index row count mismatch: {fts_count} in FTS vs {msg_count} in messages")

            is_healthy = (len(issues) == 0)
            return is_healthy, issues

    def repair_database(self) -> Dict[str, Any]:
        """Repair database issues: adopt/clean orphaned messages, rebuild FTS, and checkpoint WAL."""
        with self._lock:
            conn = self._get_connection()
            repaired: Dict[str, Any] = {"orphans_adopted": 0, "fts_rebuilt": False, "checkpoint": "ok"}
            with conn:
                # 1. Adopt orphaned messages by creating a recovered session
                orphan_rows = conn.execute("""
                SELECT DISTINCT session_id FROM messages WHERE session_id NOT IN (SELECT id FROM sessions);
                """).fetchall()

                import time
                for row in orphan_rows:
                    sid = row[0]
                    now = time.time()
                    conn.execute("""
                    INSERT INTO sessions (id, workspace_id, title, cwd, status, created_at, updated_at, last_active_at)
                    VALUES (?, '__quarantine__', 'Recovered Session', '', 'archived', ?, ?, ?);
                    """, (sid, now, now, now))
                    repaired["orphans_adopted"] += 1

                # 2. Rebuild FTS index
                try:
                    conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
                    repaired["fts_rebuilt"] = True
                except Exception as exc:
                    logger.warning("FTS rebuild notice: %s", exc)

                # 3. WAL checkpoint
                if self.db_path != ":memory:":
                    try:
                        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
                    except Exception as exc:
                        repaired["checkpoint"] = f"error: {exc}"

            return repaired
