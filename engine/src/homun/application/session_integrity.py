"""Forensic integrity verification and projection self-healing for canonical sessions.

Integrity checks scan transcripts for closed tool-call boundaries, distinguish
authorized pruned tombstones from corrupted missing payloads, and repair rebuildable
projections without ever inventing or fabricating authoritative messages.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from homun.application import session_history as history
from homun.application.session_records import SNAPSHOT, rows as record_rows
from homun.application.session_search import rebuild_search_index
from homun.domain.errors import ValidationError
from homun.policy.work import require_work_access


def check_integrity(ctx, actor: Any, work_id: str) -> Dict[str, Any]:
    """Inspect canonical sessions for message closure, tombstones, and corruption."""
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')

    issues: List[Dict[str, Any]] = []
    scanned_count = 0
    pruned_count = 0

    for cmd in store.commands.values():
        if cmd.type not in {'agent_run.propose', SNAPSHOT} or cmd.result.get('work_id') != work_id:
            continue
        scanned_count += 1
        sid = cmd.command_id
        res = cmd.result

        # Check tombstone
        tombstone = res.get('_tombstone') or res.get('tombstone')
        if tombstone:
            pruned_count += 1
            if not isinstance(tombstone, dict) or not tombstone.get('pruned_at'):
                issues.append({
                    'session_id': sid,
                    'severity': 'error',
                    'issue': 'malformed_tombstone',
                    'detail': 'Tombstone metadata is invalid or missing pruned_at',
                })
            continue

        # Check missing payload without tombstone
        if cmd.type == 'agent_run.propose' and '_messages' not in res:
            issues.append({
                'session_id': sid,
                'severity': 'error',
                'issue': 'corrupted_missing_payload',
                'detail': 'Run command is missing authoritative transcript without a valid tombstone',
            })
            continue

        if cmd.type == SNAPSHOT and 'messages' not in res:
            issues.append({
                'session_id': sid,
                'severity': 'error',
                'issue': 'corrupted_missing_payload',
                'detail': 'Snapshot command is missing messages list without a valid tombstone',
            })
            continue

        # Validate closed tool boundaries
        msgs = record_rows(cmd)
        try:
            history.closed_prefix(msgs)
        except ValidationError as exc:
            issues.append({
                'session_id': sid,
                'severity': 'error',
                'issue': 'unclosed_tool_boundaries',
                'detail': str(exc),
            })

    is_healthy = (len(issues) == 0)
    return {
        'status': 'checked',
        'healthy': is_healthy,
        'scanned_count': scanned_count,
        'pruned_count': pruned_count,
        'issue_count': len(issues),
        'issues': issues,
    }


def repair_sessions(
    ctx,
    actor: Any,
    work_id: str,
    *,
    preview: bool = True,
    command_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Repair rebuildable session projections without mutating authoritative transcripts."""
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'write' if not preview else 'read')

    integrity = check_integrity(ctx, actor, work_id)
    if preview:
        return {
            'status': 'preview',
            'healthy': integrity['healthy'],
            'issues': integrity['issues'],
            'actions_planned': ['rebuild_fts_projection'] if integrity['healthy'] else ['rebuild_fts_projection', 'report_unrepairable_corruption'],
        }

    # Apply repair: rebuild projections
    fts_result = rebuild_search_index(ctx, actor, work_id)
    return {
        'status': 'repaired',
        'repaired_at': time.time(),
        'fts_rebuilt': True,
        'indexed_count': fts_result['indexed_count'],
        'remaining_unrepairable_issues': integrity['issues'],
    }
