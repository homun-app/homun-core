"""Durable session retention: preview, dependency protection, and payload reclaiming.

Homun distinguishes reversible archive from payload pruning. Pruning reclaims bulky
transcript payloads into tombstones while preserving audit commands, budget usage
receipts, lineage identities, and consent records.
"""
from __future__ import annotations

import hashlib
import json
import time
from copy import deepcopy
from typing import Any, Dict, List, Optional, Set

from homun.application import session_history as history
from homun.application.session_records import SNAPSHOT
from homun.application.price_comparisons import cached, save
from homun.domain.errors import ConflictError, ValidationError
from homun.policy.work import require_work_access

ACTIVE_STATUSES = {
    'pending_approval', 'queued', 'running', 'paused',
    'waiting_input', 'waiting_external', 'waiting_automation'
}


def _calculate_payload_bytes(messages: List[Dict[str, Any]]) -> int:
    try:
        return len(json.dumps(messages, ensure_ascii=False).encode('utf-8'))
    except Exception:
        return sum(len(str(m).encode('utf-8')) for m in messages)


def _find_referenced_session_ids(store, work_id: str) -> Set[str]:
    """Find session IDs that are actively referenced as lineage parents or sources."""
    referenced = set()
    for cmd in store.commands.values():
        if cmd.result.get('work_id') != work_id:
            continue
        res = cmd.result
        # Check parent_id
        if res.get('parent_id'):
            referenced.add(res['parent_id'])
        # Check session_context
        ctx_data = res.get('session_context') or res.get('_session_context')
        if isinstance(ctx_data, dict) and ctx_data.get('session_id'):
            referenced.add(ctx_data['session_id'])
        # Check sources in snapshot
        for src in res.get('sources', []):
            if isinstance(src, dict) and src.get('session_id'):
                referenced.add(src['session_id'])
    return referenced


def preview_retention(
    ctx,
    actor: Any,
    work_id: str,
    *,
    older_than_seconds: Optional[float] = None,
    include_pinned: bool = False,
    session_id: Optional[str] = None,
    store: Optional[Any] = None,
) -> Dict[str, Any]:
    """Preview sessions eligible for transcript pruning with exclusion reasons."""
    if store is None:
        store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')

    now = time.time()
    referenced_ids = _find_referenced_session_ids(store, work_id)

    eligible = []
    excluded = []
    total_bytes = 0

    commands = [store.commands[session_id]] if session_id and session_id in store.commands else store.commands.values()

    for cmd in commands:
        if cmd.type not in {'agent_run.propose', SNAPSHOT} or cmd.result.get('work_id') != work_id:
            continue
        sid = cmd.command_id
        try:
            view = history.lookup(store, actor, work_id, sid)
        except Exception:
            continue

        # Check already pruned
        if view.get('tombstone') or view.get('pruned'):
            excluded.append({'session_id': sid, 'reason': 'already_pruned'})
            continue

        # Check active status
        if view.get('status') in ACTIVE_STATUSES:
            excluded.append({'session_id': sid, 'reason': 'active_run'})
            continue

        # Check pinned status
        if view.get('pinned') and not include_pinned:
            excluded.append({'session_id': sid, 'reason': 'pinned'})
            continue

        # Check age if requested
        if older_than_seconds is not None:
            created_at = float(view.get('created_at') or 0.0)
            if created_at and (now - created_at) < older_than_seconds:
                excluded.append({'session_id': sid, 'reason': 'too_recent'})
                continue

        # Check if referenced by another active / non-pruned entity
        if sid in referenced_ids:
            excluded.append({'session_id': sid, 'reason': 'referenced_by_lineage'})
            continue

        # Calculate payload size
        msgs = view.get('messages', [])
        p_bytes = _calculate_payload_bytes(msgs)
        total_bytes += p_bytes

        eligible.append({
            'session_id': sid,
            'title': view.get('title'),
            'message_count': len(msgs),
            'revision': view.get('revision'),
            'payload_bytes': p_bytes,
        })

    # Sort deterministically
    eligible.sort(key=lambda x: x['session_id'])
    digest_input = ':'.join(f"{item['session_id']}@{item['revision']}" for item in eligible)
    selection_digest = hashlib.sha256(digest_input.encode()).hexdigest()

    return {
        'status': 'preview',
        'eligible': eligible,
        'excluded': excluded,
        'eligible_count': len(eligible),
        'total_reclaimable_bytes': total_bytes,
        'selection_digest': selection_digest,
    }


def apply_retention(
    ctx,
    actor: Any,
    work_id: str,
    *,
    command_id: str,
    selection_digest: str,
    older_than_seconds: Optional[float] = None,
    include_pinned: bool = False,
    session_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Atomically reclaim transcript payloads for the verified preview selection."""
    if not isinstance(command_id, str) or not 1 <= len(command_id) <= 140:
        raise ValidationError('command_id must be between 1 and 140 characters')
    if not isinstance(selection_digest, str) or len(selection_digest) < 16:
        raise ValidationError('A valid selection_digest is required to prevent stale pruning')

    now = time.time()
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id, 'write')

            # Replay idempotency
            rec, fingerprint = cached(
                store, actor, command_id, 'session.retention',
                {'work_id': work_id, 'selection_digest': selection_digest}
            )
            if rec:
                return rec.result

            # Re-verify preview inside transaction to prevent races
            preview = preview_retention(
                ctx, actor, work_id,
                older_than_seconds=older_than_seconds,
                include_pinned=include_pinned,
                session_id=session_id,
                store=store,
            )
            if preview['selection_digest'] != selection_digest:
                raise ConflictError('Retention preview is stale; candidate sessions or revisions changed')

            eligible = preview['eligible']
            if not eligible:
                result = {
                    'status': 'applied',
                    'pruned_count': 0,
                    'reclaimed_bytes': 0,
                    'pruned_session_ids': [],
                    'timestamp': now,
                }
                save(store, actor, command_id, 'session.retention', fingerprint, result)
                ctx.service.store = store
                return result

            total_reclaimed = 0
            pruned_ids = []

            for item in eligible:
                sid = item['session_id']
                cmd = store.commands.get(sid)
                if not cmd:
                    continue

                res = cmd.result
                tombstone = {
                    'pruned_at': now,
                    'reclaimed_bytes': item['payload_bytes'],
                    'message_count': item['message_count'],
                    'original_revision': item['revision'],
                }

                if cmd.type == 'agent_run.propose':
                    res['_tombstone'] = tombstone
                    res['_messages'] = []
                elif cmd.type == SNAPSHOT:
                    res['tombstone'] = tombstone
                    res['messages'] = []

                total_reclaimed += item['payload_bytes']
                pruned_ids.append(sid)

            result = {
                'status': 'applied',
                'pruned_count': len(pruned_ids),
                'reclaimed_bytes': total_reclaimed,
                'pruned_session_ids': pruned_ids,
                'timestamp': now,
            }
            save(store, actor, command_id, 'session.retention', fingerprint, result)
        ctx.service.store = store

    return result
