"""Rebuildable full-text search projection with ACL filtering for canonical sessions.

Search operates on a rebuildable secondary projection of authoritative repository
records. Candidates are authorized against current permissions before any snippet,
metadata, or count is exposed.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from homun.application import session_history as history
from homun.application.session_records import SNAPSHOT, rows as record_rows
from homun.domain.errors import DomainError, ValidationError
from homun.policy.work import require_work_access

_LOCK = threading.RLock()
_PROJECTION_CONNS: Dict[str, sqlite3.Connection] = {}


def _get_search_conn(ctx) -> sqlite3.Connection:
    repo_path = getattr(ctx.repository, 'path', None)
    key = str(repo_path) if repo_path else ':memory:'
    with _LOCK:
        if key not in _PROJECTION_CONNS:
            conn = sqlite3.connect(':memory:', check_same_thread=False)
            conn.row_factory = sqlite3.Row
            with conn:
                conn.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS canonical_session_fts USING fts5(
                    session_id UNINDEXED,
                    work_id UNINDEXED,
                    role UNINDEXED,
                    content,
                    turn_index UNINDEXED
                );
                """)
                conn.execute("""
                CREATE TABLE IF NOT EXISTS canonical_search_watermark (
                    work_id TEXT PRIMARY KEY,
                    indexed_count INTEGER NOT NULL DEFAULT 0,
                    rebuilt_at REAL NOT NULL
                );
                """)
            _PROJECTION_CONNS[key] = conn
        return _PROJECTION_CONNS[key]


def _sync_work_projection(ctx, work_id: str) -> None:
    """Ensure projection matches authoritative store records."""
    store = ctx.repository.load()
    conn = _get_search_conn(ctx)
    with _LOCK:
        with conn:
            # Rebuild index for this work
            conn.execute("DELETE FROM canonical_session_fts WHERE work_id = ?", (work_id,))
            indexed = 0
            for cmd in store.commands.values():
                if cmd.type not in {'agent_run.propose', SNAPSHOT} or cmd.result.get('work_id') != work_id:
                    continue
                sid = cmd.command_id
                # Skip pruned
                if cmd.result.get('_tombstone') or cmd.result.get('tombstone'):
                    continue
                rows = record_rows(cmd)
                for idx, r in enumerate(rows):
                    msg = r.get('message', {})
                    content = msg.get('content') or ''
                    role = msg.get('role') or 'user'
                    if content.strip():
                        conn.execute("""
                        INSERT INTO canonical_session_fts (session_id, work_id, role, content, turn_index)
                        VALUES (?, ?, ?, ?, ?);
                        """, (sid, work_id, role, content, idx))
                        indexed += 1
            now = time.time()
            conn.execute("""
            INSERT OR REPLACE INTO canonical_search_watermark (work_id, indexed_count, rebuilt_at)
            VALUES (?, ?, ?);
            """, (work_id, indexed, now))


def search_canonical_sessions(
    ctx,
    actor: Any,
    work_id: str,
    query: str,
    *,
    limit: int = 50,
    cursor: Optional[int] = None,
) -> Dict[str, Any]:
    """Search canonical transcripts with per-result ACL authorization."""
    if not isinstance(query, str) or not query.strip():
        raise ValidationError('Search query must be a non-empty string')
    if len(query) > 200:
        raise ValidationError('Search query must not exceed 200 characters')

    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')

    _sync_work_projection(ctx, work_id)
    conn = _get_search_conn(ctx)

    # Sanitize FTS query string
    clean_query = query.strip().replace('"', '""')
    fts_term = f'"{clean_query}"'

    with _LOCK:
        sql = """
        SELECT session_id, role, snippet(canonical_session_fts, 3, '[MATCH]', '[/MATCH]', '...', 12) as snippet, turn_index
        FROM canonical_session_fts
        WHERE work_id = ? AND canonical_session_fts MATCH ?
        ORDER BY rank
        """
        cur = conn.execute(sql, (work_id, fts_term))
        raw_matches = cur.fetchall()

    results = []
    seen_sessions = set()
    offset = int(cursor or 0)

    for row in raw_matches:
        sid = row['session_id']
        # Re-check authorization against current store state
        try:
            session_view = history.lookup(store, actor, work_id, sid)
        except DomainError:
            continue  # Unauthorized or unreadable session excluded before exposing any content

        # Exclude archived if needed or include title
        results.append({
            'session_id': sid,
            'title': session_view.get('title'),
            'role': row['role'],
            'snippet': row['snippet'],
            'turn_index': row['turn_index'],
        })

    paginated = results[offset: offset + limit]
    next_cursor = offset + limit if (offset + limit) < len(results) else None

    return {
        'query': query,
        'count': len(results),
        'results': paginated,
        'next_cursor': next_cursor,
    }


def rebuild_search_index(ctx, actor: Any, work_id: str) -> Dict[str, Any]:
    """Rebuild the search index projection from authoritative commands."""
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'write')
    _sync_work_projection(ctx, work_id)
    conn = _get_search_conn(ctx)
    with _LOCK:
        row = conn.execute("SELECT * FROM canonical_search_watermark WHERE work_id = ?", (work_id,)).fetchone()
        return {
            'status': 'rebuilt',
            'work_id': work_id,
            'indexed_count': row['indexed_count'] if row else 0,
            'rebuilt_at': row['rebuilt_at'] if row else time.time(),
        }
