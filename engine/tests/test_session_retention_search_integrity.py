import json
import pytest
from homun.application import session_runtime as canonical_runtime
from homun.application.session_import_bridge import bridge_import_snapshot
from homun.application.session_storage import SessionStorage
from homun.application.session_manager import SessionManager
from homun.context import create_context
from homun.domain.models import Actor
from homun.domain.errors import ConflictError, ValidationError


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / "ws.db", data_dir=tmp_path, for_tests=True)
    actor = Actor(id="person_a", workspace_id=ctx.workspace_id, display_name="A")
    project = ctx.service.apply(actor, "p", "project.create", {"name": "Progetto"})["project_id"]
    conv = ctx.service.apply(actor, "c", "conversation.create", {"title": "Conversazione", "project_id": project})["conversation_id"]
    work = ctx.service.apply(actor, "w", "work.create", {"conversation_id": conv, "title": "Lavoro", "objective": "Obiettivo"})["work_id"]
    ctx.persist()
    ctx.models.set_active("openai_compatible")
    yield ctx, actor, work
    ctx.close()


def test_retention_preview_excludes_active_pinned_and_referenced(setup):
    ctx, actor, work = setup
    storage = SessionStorage(":memory:")
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=storage)

    # 1. Closed session A
    sA = mgr.create_session(title="Completed Session A")
    mgr.add_message(sA.id, role="user", content="Task A")
    mgr.add_message(sA.id, role="assistant", content="Done A")

    # 2. Pinned session B
    sB = mgr.create_session(title="Pinned Session B")
    mgr.add_message(sB.id, role="user", content="Task B")
    mgr.add_message(sB.id, role="assistant", content="Done B")

    # 3. Referenced session C (parent of fork D)
    sC = mgr.create_session(title="Parent Session C")
    mgr.add_message(sC.id, role="user", content="Task C")
    mgr.add_message(sC.id, role="assistant", content="Done C")

    # Import all into canonical repository
    bridge_import_snapshot(ctx, actor, work, storage, sA.id, command_id="snap_A")
    bridge_import_snapshot(ctx, actor, work, storage, sB.id, command_id="snap_B")
    bridge_import_snapshot(ctx, actor, work, storage, sC.id, command_id="snap_C")

    # Pin snap_B
    canonical_runtime.execute(ctx, actor, work, {"action": "pin", "session_id": "snap_B", "command_id": "pin_B"})

    # Fork snap_C into snap_D (so snap_C is referenced by lineage)
    canonical_runtime.execute(ctx, actor, work, {"action": "fork", "session_id": "snap_C", "command_id": "snap_D"})

    # Preview retention
    prev = canonical_runtime.execute(ctx, actor, work, {"action": "retention_preview"})
    assert prev["status"] == "preview"
    assert prev["eligible_count"] >= 1

    eligible_ids = [e["session_id"] for e in prev["eligible"]]
    excluded_map = {ex["session_id"]: ex["reason"] for ex in prev["excluded"]}

    # snap_A is eligible
    assert "snap_A" in eligible_ids
    # snap_B is excluded because it's pinned
    assert excluded_map.get("snap_B") == "pinned"
    # snap_C is excluded because it's referenced by snap_D
    assert excluded_map.get("snap_C") == "referenced_by_lineage"


def test_retention_prune_reclaims_payload_preserves_audit_and_handles_reopen(setup):
    ctx, actor, work = setup
    storage = SessionStorage(":memory:")
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=storage)

    s1 = mgr.create_session(title="Eligible session for pruning")
    mgr.add_message(s1.id, role="user", content="Heavy payload content data " * 50)
    mgr.add_message(s1.id, role="assistant", content="Completed processing heavy data")

    bridge_import_snapshot(ctx, actor, work, storage, s1.id, command_id="snap_prunable")

    # 1. Preview
    prev = canonical_runtime.execute(ctx, actor, work, {"action": "prune", "preview": True})
    assert prev["status"] == "preview"
    digest = prev["selection_digest"]
    assert digest

    # 2. Prune with valid digest
    res = canonical_runtime.execute(
        ctx, actor, work,
        {
            "action": "prune",
            "command_id": "cmd_prune_apply_1",
            "selection_digest": digest,
        }
    )
    assert res["status"] == "applied"
    assert "snap_prunable" in res["pruned_session_ids"]
    assert res["reclaimed_bytes"] > 0

    # 3. Verify session in repository is now tombstoned and payload empty
    view = canonical_runtime.execute(ctx, actor, work, {"action": "get", "session_id": "snap_prunable"})
    sess = view["session"]
    assert sess["pruned"] is True
    assert sess["tombstone"]["reclaimed_bytes"] > 0
    assert len(sess["messages"]) == 0

    # 4. Verify audit command is preserved in repository
    store = ctx.repository.load()
    assert "cmd_prune_apply_1" in store.commands
    assert "snap_prunable" in store.commands

    # 5. Stale digest rejection
    with pytest.raises(ConflictError, match="Retention preview is stale"):
        canonical_runtime.execute(
            ctx, actor, work,
            {
                "action": "prune",
                "command_id": "cmd_prune_stale",
                "selection_digest": "stale_invalid_digest_12345",
            }
        )


def test_canonical_search_fts_and_rebuild_equivalence(setup):
    ctx, actor, work = setup
    storage = SessionStorage(":memory:")
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=storage)

    s1 = mgr.create_session(title="Alpha Session")
    mgr.add_message(s1.id, role="user", content="Searchable term: QuantumSuperposition")
    mgr.add_message(s1.id, role="assistant", content="Understood, discussing entanglement.")

    s2 = mgr.create_session(title="Beta Session")
    mgr.add_message(s2.id, role="user", content="Discussing general relativity.")

    bridge_import_snapshot(ctx, actor, work, storage, s1.id, command_id="snap_alpha")
    bridge_import_snapshot(ctx, actor, work, storage, s2.id, command_id="snap_beta")

    # 1. Search for QuantumSuperposition
    search_res = canonical_runtime.execute(
        ctx, actor, work,
        {"action": "search", "query": "QuantumSuperposition"}
    )
    assert search_res["count"] == 1
    assert search_res["results"][0]["session_id"] == "snap_alpha"
    assert "[MATCH]QuantumSuperposition[/MATCH]" in search_res["results"][0]["snippet"]

    # 2. Rebuild index and verify equivalence
    rebuild_res = canonical_runtime.execute(ctx, actor, work, {"action": "repair", "preview": False})
    assert rebuild_res["status"] == "repaired"
    assert rebuild_res["fts_rebuilt"] is True

    search_after_rebuild = canonical_runtime.execute(
        ctx, actor, work,
        {"action": "search", "query": "QuantumSuperposition"}
    )
    assert search_after_rebuild["count"] == 1
    assert search_after_rebuild["results"][0]["session_id"] == "snap_alpha"


def test_integrity_check_and_repair_preview(setup):
    ctx, actor, work = setup
    storage = SessionStorage(":memory:")
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=storage)

    s1 = mgr.create_session(title="Healthy Session")
    mgr.add_message(s1.id, role="user", content="Test integrity")
    bridge_import_snapshot(ctx, actor, work, storage, s1.id, command_id="snap_healthy")

    # 1. Healthy check
    integ = canonical_runtime.execute(ctx, actor, work, {"action": "check_integrity"})
    assert integ["status"] == "checked"
    assert integ["healthy"] is True
    assert integ["issue_count"] == 0

    # 2. Repair in preview mode does not mutate
    repair_prev = canonical_runtime.execute(ctx, actor, work, {"action": "repair", "preview": True})
    assert repair_prev["status"] == "preview"
    assert repair_prev["healthy"] is True

    # 3. Simulate corrupted missing payload without tombstone
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            store.commands["snap_healthy"].result.pop("messages")
        ctx.service.store = store

    corrupt_check = canonical_runtime.execute(ctx, actor, work, {"action": "check_integrity"})
    assert corrupt_check["healthy"] is False
    assert corrupt_check["issue_count"] == 1
    assert corrupt_check["issues"][0]["issue"] == "corrupted_missing_payload"


def test_pruned_session_excluded_from_fts_and_reopen_persists_tombstone(setup):
    ctx, actor, work = setup
    storage = SessionStorage(":memory:")
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=storage)

    s1 = mgr.create_session(title="Secret Prune Target")
    mgr.add_message(s1.id, role="user", content="ClassifiedKeywordToPrune")
    bridge_import_snapshot(ctx, actor, work, storage, s1.id, command_id="snap_to_prune")

    # 1. Search finds it before pruning
    s_before = canonical_runtime.execute(ctx, actor, work, {"action": "search", "query": "ClassifiedKeywordToPrune"})
    assert s_before["count"] == 1

    # 2. Prune
    prev = canonical_runtime.execute(ctx, actor, work, {"action": "prune", "preview": True, "session_id": "snap_to_prune"})
    digest = prev["selection_digest"]
    canonical_runtime.execute(
        ctx, actor, work,
        {"action": "prune", "command_id": "cmd_prune_keyword", "selection_digest": digest, "session_id": "snap_to_prune"}
    )

    # 3. Search excludes it after pruning
    s_after = canonical_runtime.execute(ctx, actor, work, {"action": "search", "query": "ClassifiedKeywordToPrune"})
    assert s_after["count"] == 0

    # 4. Reopen context and assert tombstone survives
    store_reopened = ctx.repository.load()
    tomb = store_reopened.commands["snap_to_prune"].result.get("tombstone")
    assert tomb is not None
    assert tomb["reclaimed_bytes"] > 0
    assert tomb["message_count"] == 1


def test_search_enforces_acl_and_rejects_unauthorized_actor(setup):
    from homun.domain.errors import PermissionDeniedError
    ctx, actor, work = setup
    storage = SessionStorage(":memory:")
    mgr = SessionManager(workspace_id=ctx.workspace_id, storage=storage)

    s1 = mgr.create_session(title="Confidential Work")
    mgr.add_message(s1.id, role="user", content="SuperSecretContent")
    bridge_import_snapshot(ctx, actor, work, storage, s1.id, command_id="snap_confidential")

    # Unauthorized outsider actor
    stranger = Actor(id="person_stranger", workspace_id=ctx.workspace_id, display_name="Stranger")
    with pytest.raises(PermissionDeniedError):
        canonical_runtime.execute(ctx, stranger, work, {"action": "search", "query": "SuperSecretContent"})
