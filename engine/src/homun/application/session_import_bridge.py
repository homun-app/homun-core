"""Explicit versioned bridge from standalone SessionStorage to canonical snapshots.

Homun preserves complete tool-call boundaries, redacts secret headers/arguments,
attaches deterministic provenance, and never redirects canonical updates back to
the standalone database.
"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from typing import Any, Dict, Optional

from homun.application import session_history as history
from homun.application.price_comparisons import cached, save
from homun.application.session_history import normalize_imported_message, closed_prefix
from homun.application.session_manager import redact_secrets, get_default_storage
from homun.application.session_storage import SessionStorage
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.policy.work import require_work_access


def bridge_import_snapshot(
    ctx,
    actor: Any,
    work_id: str,
    source_storage: SessionStorage,
    source_session_id: str,
    *,
    command_id: Optional[str] = None,
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """Import a detached SessionStorage session into an immutable canonical snapshot."""
    if not isinstance(source_storage, SessionStorage):
        raise ValidationError("Source storage must be a verified SessionStorage instance")
    if not isinstance(source_session_id, str) or not source_session_id.strip():
        raise ValidationError("source_session_id is required")

    session = source_storage.get_session(source_session_id)
    if not session:
        raise NotFoundError(f"Standalone session not found: {source_session_id}")

    messages = source_storage.get_messages(source_session_id, only_active=True)
    if not messages:
        raise ValidationError("Source standalone session has no messages to import")

    # Build provenance fingerprint
    db_origin = getattr(source_storage, "db_path", ":memory:")
    storage_hash = hashlib.sha256(str(db_origin).encode()).hexdigest()[:16]
    provenance = f"legacy-storage:{storage_hash}"

    # Determine command_id deterministically if not explicitly supplied
    if not command_id:
        seed = f"{storage_hash}:{source_session_id}:{len(messages)}"
        command_id = f"import-{hashlib.sha256(seed.encode()).hexdigest()[:24]}"
    elif not (1 <= len(command_id) <= 140):
        raise ValidationError("command_id must be between 1 and 140 characters")

    # Convert messages and preserve tool boundaries
    rows = []
    for idx, msg in enumerate(messages):
        msg_dict = msg.to_dict()
        normalized = normalize_imported_message(msg_dict)
        rows.append({
            "id": f"{command_id}:{idx}",
            "run_id": None,
            "index": idx,
            "message": normalized.model_dump(),
        })

    # Validate closed prefix: no unfulfilled tool calls or dangling results
    closed_rows = closed_prefix(rows)

    snapshot_title = redact_secrets(title or session.title or f"Imported {source_session_id}")

    snapshot_value = {
        "id": command_id,
        "work_id": work_id,
        "status": "snapshot",
        "operation": "import",
        "title": snapshot_title,
        "parent_id": None,
        "messages": closed_rows,
        "sources": [],
        "materials": [],
        "provenance": provenance,
        "historical_usage": {
            "prompt_tokens": session.prompt_tokens,
            "completion_tokens": session.completion_tokens,
            "cost_estimate": session.cost_estimate,
        },
        "historical_runtime": {
            "cwd": session.cwd,
            "model_pin": session.model_pin,
            "provider_pin": session.provider_pin,
        },
    }

    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id, "write")
            record, fingerprint = cached(
                store, actor, command_id, history.SNAPSHOT,
                {"action": "import", "source_session_id": source_session_id, "work_id": work_id}
            )
            if record:
                return {"status": "imported", "session": history.lookup(store, actor, work_id, command_id)}
            save(store, actor, command_id, history.SNAPSHOT, fingerprint, snapshot_value)
            result = history.lookup(store, actor, work_id, command_id)
        ctx.service.store = store

    return {"status": "imported", "session": result}
