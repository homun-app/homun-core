"""Comprehensive unit tests for session lifecycle, lineage, FTS search, and integrity repair (H30/H31).

Covers:
- Session CRUD and metadata tracking.
- Working directory restoration (cwd) on session resume.
- Pin, unpin, archive, unarchive, and age-based pruning.
- Message append, turn indexing, and FTS5 full-text indexing.
- Carrier-aware turn rewind with soft deactivation.
- Forking sessions with message snapshot and lineage tracking (ancestors/children).
- Secret-redacted export (JSONL, Markdown) and foreign transcript import without identity drift.
- Structured handoff context generation.
- Token and cost accounting.
- SQLite WAL mode, PRAGMA integrity_check, and database repair (orphan adoption, FTS rebuild).
- Agent tool execution via session_manage.
"""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from homun.application.session_contracts import (
    RewindOutcome,
    SessionLineage,
    SessionMessage,
    SessionRecord,
    SessionUsage,
)
from homun.application.session_manager import (
    SessionManager,
    redact_secrets,
    set_default_storage,
)
from homun.application.session_storage import SessionStorage
from homun.application.session_tools import execute_standalone as session_execute
from homun.domain.errors import ValidationError


@pytest.fixture
def temp_storage():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_file = Path(tmpdir) / "test_sessions.sqlite"
        storage = SessionStorage(db_file)
        set_default_storage(storage)
        yield storage
        storage.close()
        set_default_storage(None)


def test_session_crud_and_cwd_restoration(temp_storage):
    mgr = SessionManager(workspace_id="ws-crud", storage=temp_storage)

    # 1. Create session with specific cwd
    session = mgr.create_session(
        cwd="/var/projects/acme",
        title="Acme Feature Investigation",
        model_pin="gpt-4o",
        provider_pin="openai",
    )
    assert session.id.startswith("session-")
    assert session.cwd == "/var/projects/acme"
    assert session.title == "Acme Feature Investigation"
    assert session.status == "active"
    assert session.pinned is False

    # 2. Get and List
    fetched = mgr.get_session(session.id)
    assert fetched is not None
    assert fetched.id == session.id

    all_sessions = mgr.list_sessions()
    assert len(all_sessions) == 1
    assert all_sessions[0].id == session.id

    # 3. Update session
    updated = mgr.update_session(session.id, title="Acme Feature V2", cwd="/var/projects/acme/sub")
    assert updated.title == "Acme Feature V2"
    assert updated.cwd == "/var/projects/acme/sub"

    # 4. Resume session restores cwd (H30)
    resume_info = mgr.resume_session(session.id)
    assert resume_info["session"]["id"] == session.id
    assert resume_info["restored_cwd"] == "/var/projects/acme/sub"
    assert resume_info["session"]["status"] == "active"

    # 5. Delete session
    assert mgr.delete_session(session.id) is True
    assert mgr.get_session(session.id).status == "cleared"
    assert len(mgr.list_sessions()) == 0


def test_pin_archive_and_pruning(temp_storage):
    mgr = SessionManager(workspace_id="ws-prune", storage=temp_storage)

    # Session 1: pinned (exempt from pruning)
    s1 = mgr.create_session(title="Pinned Session", now=1000.0)
    mgr.pin_session(s1.id, pinned=True)

    # Session 2: old inactive session
    s2 = mgr.create_session(title="Old Inactive", now=1000.0)

    # Session 3: recent session
    s3 = mgr.create_session(title="Recent Session", now=2000.0)

    # Archive s2
    mgr.archive_session(s2.id, archived=True)
    assert mgr.get_session(s2.id).status == "archived"

    # Prune dry run
    prune_preview = mgr.prune_sessions(older_than_seconds=500.0, include_archived=True, dry_run=True, now=2100.0)
    assert prune_preview["dry_run"] is True
    assert s2.id in prune_preview["candidates"]
    assert s1.id not in prune_preview["candidates"]  # Pinned is protected

    # Actual prune
    prune_res = mgr.prune_sessions(older_than_seconds=500.0, include_archived=True, dry_run=False, now=2100.0)
    assert prune_res["candidates_count"] == 1
    assert mgr.get_session(s2.id).status == "cleared"
    assert mgr.get_session(s1.id).status == "active"
    assert mgr.get_session(s3.id).status == "active"


def test_messages_and_fts_search(temp_storage):
    mgr = SessionManager(workspace_id="ws-fts", storage=temp_storage)
    session = mgr.create_session(title="FTS Session")

    # Add turns
    m1 = mgr.add_message(session.id, "user", "Configure the PostgreSQL database connection string.")
    m2 = mgr.add_message(session.id, "assistant", "I will update database.py with connection credentials.", tool_name="code_edit")
    m3 = mgr.add_message(session.id, "tool", "Successfully updated database.py")
    m4 = mgr.add_message(session.id, "user", "Now verify Redis caching configuration.")

    messages = mgr.get_messages(session.id)
    assert len(messages) == 4
    assert messages[0].content == m1.content

    # FTS5 search
    results_pg = temp_storage.search_messages_fts("ws-fts", "PostgreSQL")
    assert len(results_pg) == 1
    assert "PostgreSQL" in results_pg[0]["content"]

    results_redis = temp_storage.search_messages_fts("ws-fts", "Redis")
    assert len(results_redis) == 1
    assert "Redis" in results_redis[0]["content"]

    # Search in list_sessions
    matched_sessions = mgr.list_sessions(query="PostgreSQL")
    assert len(matched_sessions) == 1
    assert matched_sessions[0].id == session.id


def test_carrier_aware_rewind(temp_storage):
    mgr = SessionManager(workspace_id="ws-rewind", storage=temp_storage)
    session = mgr.create_session(title="Rewind Target")

    mgr.add_message(session.id, "user", "Turn 0 ask", turn_index=0)
    mgr.add_message(session.id, "assistant", "Turn 0 reply", turn_index=0)
    mgr.add_message(session.id, "user", "Turn 1 ask", turn_index=1)
    mgr.add_message(session.id, "assistant", "Turn 1 reply", turn_index=1)
    mgr.add_message(session.id, "user", "Turn 2 ask", turn_index=2)

    assert len(mgr.get_messages(session.id, only_active=True)) == 5

    # Rewind to turn 1: deactivates turns >= 1
    outcome = mgr.rewind_session(session.id, target_turn=1)
    assert outcome.target_turn == 1
    assert outcome.messages_deactivated == 3
    assert outcome.active_messages_remaining == 2
    assert outcome.last_active_turn == 0

    active_after = mgr.get_messages(session.id, only_active=True)
    assert len(active_after) == 2
    assert all(m.turn_index == 0 for m in active_after)

    # All messages still exist in durable transcript (soft delete)
    all_msgs = mgr.get_messages(session.id, only_active=False)
    assert len(all_msgs) == 5


def test_fork_session_and_lineage_tracking(temp_storage):
    mgr = SessionManager(workspace_id="ws-fork", storage=temp_storage)
    root = mgr.create_session(cwd="/root/app", title="Root Session")
    mgr.add_message(root.id, "user", "Turn 0 in root", turn_index=0)
    mgr.add_message(root.id, "assistant", "Reply 0 in root", turn_index=0)
    mgr.add_message(root.id, "user", "Turn 1 in root", turn_index=1)

    # Fork at turn 0
    child1 = mgr.fork_session(root.id, at_turn_index=0, title="Child Branch 1")
    assert child1.parent_id == root.id
    assert child1.forked_at_turn == 0
    assert child1.cwd == "/root/app"
    assert child1.message_count == 2

    # Fork child1 into grandchild
    mgr.add_message(child1.id, "user", "Child turn 1", turn_index=1)
    grandchild = mgr.fork_session(child1.id, at_turn_index=1, title="Grandchild Branch")
    assert grandchild.parent_id == child1.id

    # Check Lineage
    lineage_gc = mgr.get_lineage(grandchild.id)
    assert lineage_gc.parent_id == child1.id
    assert lineage_gc.ancestors == [child1.id, root.id]

    lineage_root = mgr.get_lineage(root.id)
    assert lineage_root.parent_id is None
    assert child1.id in lineage_root.children


def test_export_with_redaction_and_import_without_drift(temp_storage):
    mgr = SessionManager(workspace_id="ws-export", storage=temp_storage)
    session = mgr.create_session(cwd="/app", title="Secret Session")
    mgr.add_message(session.id, "user", "Here is my key: sk-live-1234567890abcdef1234567890 and Bearer secret-token-xyz1234567890", turn_index=0)
    mgr.add_message(session.id, "assistant", "Stored token safely.", turn_index=0)

    # 1. Export with redaction
    jsonl_exported = mgr.export_session(session.id, fmt="jsonl", redact=True)
    assert "sk-live-1234567890" not in jsonl_exported
    assert "[REDACTED_SECRET]" in jsonl_exported
    assert "secret-token-xyz" not in jsonl_exported

    md_exported = mgr.export_session(session.id, fmt="markdown", redact=True)
    assert "# Session: Secret Session" in md_exported
    assert "[REDACTED_SECRET]" in md_exported

    # 2. Import without identity drift
    imported = mgr.import_session(jsonl_exported, title="Imported Transcript")
    assert imported.id != session.id  # Avoids collision with existing session
    assert imported.title == "Imported Transcript"
    assert imported.metadata.get("imported") is True

    imported_msgs = mgr.get_messages(imported.id)
    assert len(imported_msgs) == 2
    assert "[REDACTED_SECRET]" in imported_msgs[0].content


def test_handoff_and_usage_accounting(temp_storage):
    mgr = SessionManager(workspace_id="ws-usage", storage=temp_storage)
    session = mgr.create_session(cwd="/app", title="Handoff Source")
    mgr.add_message(session.id, "user", "Step 1 complete", turn_index=0)

    # Handoff packet
    packet = mgr.handoff_session(session.id, target_profile="production-ops")
    assert packet["status"] == "handoff_ready"
    assert packet["target_profile"] == "production-ops"
    assert packet["cwd"] == "/app"
    assert len(packet["recent_turns"]) == 1

    # Token accounting (H31)
    mgr.record_usage(session.id, prompt_tokens=1500, completion_tokens=350, cost=0.042)
    mgr.record_usage(session.id, prompt_tokens=500, completion_tokens=100, cost=0.010)

    usage = mgr.get_usage(session.id)
    assert usage.prompt_tokens == 2000
    assert usage.completion_tokens == 450
    assert usage.total_tokens == 2450
    assert usage.total_cost == 0.052


def test_sqlite_wal_integrity_and_repair(temp_storage):
    mgr = SessionManager(workspace_id="ws-repair", storage=temp_storage)

    # 1. Clean check
    healthy, issues = temp_storage.run_integrity_check()
    assert healthy is True
    assert issues == []

    # 2. Simulate orphan message
    with temp_storage._lock:
        conn = temp_storage._get_connection()
        with conn:
            conn.execute("PRAGMA foreign_keys = OFF;")
            conn.execute("""
            INSERT INTO messages (id, session_id, turn_index, role, content, timestamp)
            VALUES ('orphan-1', 'stranded-session-999', 0, 'user', 'Orphaned message content', 1000.0);
            """)
            conn.execute("PRAGMA foreign_keys = ON;")

    healthy_after, issues_after = temp_storage.run_integrity_check()
    assert healthy_after is False
    assert any("orphaned messages" in iss for iss in issues_after)

    # 3. Repair database
    repair_res = mgr.repair_integrity()
    assert repair_res["repair_result"]["orphans_adopted"] == 1
    assert repair_res["repair_result"]["fts_rebuilt"] is True
    assert repair_res["healthy"] is True

    # Stranded session is now adopted into sessions
    assert mgr.get_session("stranded-session-999") is None
    recovered = temp_storage.get_session("stranded-session-999")
    assert recovered is not None
    assert recovered.workspace_id == "__quarantine__"
    assert recovered.title == "Recovered Session"


def test_session_manage_tool_execution(temp_storage):
    run = {
        "work_id": "ws-tool-run",
        "session_management": {"policy": "durable-sessions-v1", "version": 1},
    }
    ctx = MagicMock()
    actor = MagicMock()

    # Create
    res_create = session_execute(ctx, actor, run, "session_manage", {
        "action": "create",
        "title": "Agent Created Session",
        "cwd": "/workspace/agent",
    })
    assert res_create["status"] == "created"
    sid = res_create["session"]["id"]

    # List
    res_list = session_execute(ctx, actor, run, "session_manage", {"action": "list"})
    assert res_list["count"] == 1

    # Resume
    res_res = session_execute(ctx, actor, run, "session_manage", {"action": "resume", "session_id": sid})
    assert res_res["status"] == "resumed"
    assert res_res["restored_cwd"] == "/workspace/agent"

    # Pin / Unpin
    res_pin = session_execute(ctx, actor, run, "session_manage", {"action": "pin", "session_id": sid})
    assert res_pin["session"]["pinned"] is True

    res_unpin = session_execute(ctx, actor, run, "session_manage", {"action": "unpin", "session_id": sid})
    assert res_unpin["session"]["pinned"] is False

    # Fork
    res_fork = session_execute(ctx, actor, run, "session_manage", {"action": "fork", "session_id": sid, "title": "Forked Branch"})
    assert res_fork["status"] == "forked"
    child_id = res_fork["session"]["id"]

    # Get & Lineage
    res_get = session_execute(ctx, actor, run, "session_manage", {"action": "get", "session_id": child_id})
    assert res_get["lineage"]["parent_id"] == sid

    # Policy disabled error
    with pytest.raises(ValidationError, match="Session management tools are not enabled"):
        session_execute(ctx, actor, {}, "session_manage", {"action": "list"})
