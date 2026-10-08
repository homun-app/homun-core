"""Tests for C3c5: Cross-profile session handoff with two-sided authorization."""
from pathlib import Path
from types import SimpleNamespace
import pytest

from homun.application import agent_runs, session_runtime, session_usage
from homun.application.agent_run_execution import advance
from homun.application.profile_operations import ProfileOperationsManager, ProfileNotFoundError
from homun.context import create_context
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.domain.models import Actor
from homun.execution.contracts import LocalJobSpec
from homun.execution.local_jobs import LocalJobs
from homun.models.native_turn import NativeMessage
from test_local_jobs import finished


@pytest.fixture
def multi_profile_env(tmp_path: Path):
    profiles_dir = tmp_path / "profiles"
    mgr = ProfileOperationsManager(profiles_dir)
    assert mgr.get_active_profile_name() == "default"
    mgr.create_profile(name="ops", description="Operations profile", config_overrides={"model": "ops-model"})
    assert mgr.get_active_profile_name() == "default"

    source_root = tmp_path / "source_data"
    source_root.mkdir(parents=True)
    source_ctx = create_context(workspace_id="ws_source", db_path=source_root / "homun.db", data_dir=source_root, for_tests=True)
    source_ctx.profile_name = "default"
    (source_root / "profiles").symlink_to(profiles_dir, target_is_directory=True)

    target_root = tmp_path / "target_data"
    target_root.mkdir(parents=True)
    target_ctx = create_context(workspace_id="ws_ops", db_path=target_root / "homun.db", data_dir=target_root, for_tests=True)
    target_ctx.profile_name = "ops"

    source_ctx.models.set_active("openai_compatible")
    target_ctx.models.set_active("openai_compatible")

    def resolver(profile_name: str):
        if profile_name == "ops":
            return target_ctx
        raise ProfileNotFoundError(f"Unknown profile: {profile_name}")

    source_ctx.profile_context_resolver = resolver
    source_actor = Actor(id="person_alice", workspace_id="ws_source", display_name="Alice", kind="person")
    with source_ctx.repository.transaction() as store:
        svc = source_ctx.service.for_store(store)
        p = svc.apply(source_actor, "p1", "project.create", {"name": "Source Project"})
        c = svc.apply(source_actor, "c1", "conversation.create", {"project_id": p["project_id"], "title": "Conv"})
        w = svc.apply(source_actor, "w1", "work.create", {
            "conversation_id": c["conversation_id"], "title": "Source Work", "objective": "Artifacts",
            "owner_id": source_actor.id, "reviewer_id": source_actor.id,
        })
        source_work_id = w["work_id"]
        source_ctx.service.store = store

    target_actor = Actor(id="person_bob", workspace_id="ws_ops", display_name="Bob", kind="person")
    with target_ctx.repository.transaction() as store:
        svc = target_ctx.service.for_store(store)
        p = svc.apply(target_actor, "tp1", "project.create", {"name": "Target Project"})
        c = svc.apply(target_actor, "tc1", "conversation.create", {"project_id": p["project_id"], "title": "Conv"})
        w = svc.apply(target_actor, "tw1", "work.create", {
            "conversation_id": c["conversation_id"], "title": "Target Ops Work", "objective": "Receive handoffs",
            "owner_id": target_actor.id, "reviewer_id": target_actor.id,
        })
        target_work_id = w["work_id"]
        target_ctx.service.store = store

    return {
        "mgr": mgr, "source_ctx": source_ctx, "target_ctx": target_ctx,
        "source_actor": source_actor, "target_actor": target_actor,
        "source_work_id": source_work_id, "target_work_id": target_work_id,
    }


def test_target_continuation_reads_approved_bytes_and_attributes_usage(multi_profile_env):
    env = multi_profile_env
    source_ctx, target_ctx = env["source_ctx"], env["target_ctx"]
    source_actor, target_actor = env["source_actor"], env["target_actor"]
    source_work_id, target_work_id = env["source_work_id"], env["target_work_id"]
    mgr = env["mgr"]

    prop = agent_runs.propose(source_ctx, source_actor, source_work_id, {"command_id": "run-source", "expected_version": 1, "terminal_backend": "local"})
    agent_runs.approve(source_ctx, source_actor, source_work_id, "run-source", {"command_id": "approve-source", "digest": prop["digest"], "expected_version": prop["expected_version"]})
    jobs = LocalJobs(source_ctx.data_dir.resolve() / "execution")
    spec = LocalJobSpec(workspace_id=source_ctx.workspace_id, run_id="run-source", call_id="write-artifact",
                        command="mkdir nested && printf 'approved-cross-profile-bytes' > nested/data.txt")
    jobs.start(spec)
    assert finished(jobs, spec)["exit_code"] == 0
    source_ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role="assistant", content="Finished"), usage=None)
    assert advance(source_ctx, "run-source") == "completed"

    handoff_res = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "session_id": "run-source", "command_id": "handoff-cmd-1",
        "target_profile": "ops", "target_actor": target_actor, "target_work_id": target_work_id,
        "instruction": "Process transferred data", "workspace_mode": "current_files", "execution_cwd": "nested",
        "proposal": {"terminal_backend": "local", "connection_id": "openai_compatible"},
    })

    assert handoff_res["status"] == "proposed" and handoff_res["requires_fresh_approval"] is True
    assert mgr.get_active_profile_name() == "default"

    target_prop = handoff_res["proposal"]
    target_run_id = target_prop["id"]
    target_jobs = LocalJobs(target_ctx.data_dir.resolve() / "execution")
    target_spec = spec.model_copy(update={"workspace_id": target_ctx.workspace_id, "run_id": target_run_id})
    target_root = target_jobs.workspace(target_spec)
    assert not (target_root / "nested/data.txt").exists()

    agent_runs.approve(target_ctx, target_actor, target_work_id, target_run_id, {
        "command_id": "approve-target-run", "digest": target_prop["digest"], "expected_version": target_prop["expected_version"],
    })

    def target_model(*args, **kwargs):
        assert (target_root / "nested/data.txt").read_bytes() == b"approved-cross-profile-bytes"
        return SimpleNamespace(message=NativeMessage(role="assistant", content="Target ok"),
                               usage={"input_tokens": 150, "output_tokens": 50, "estimated_cost": 0.004, "currency": "USD"})

    target_ctx.models.complete_tools = target_model
    assert advance(target_ctx, target_run_id) == "completed"

    with target_ctx.repository.transaction() as target_store:
        target_run_rec = target_store.commands[target_run_id].result
        assert target_run_rec["status"] == "completed"
        receipts = [r for r in target_store.budget_usage_receipts.values() if r.work_id == target_work_id and r.run_id == target_run_id]
        assert len(receipts) >= 1 and receipts[0].input_tokens == 150 and receipts[0].output_tokens == 50

    target_usage = session_usage.query(target_ctx, target_actor, target_work_id, session_id=target_run_id)
    assert target_usage["totals"]["known_input_tokens"] == 150 and target_usage["totals"]["known_output_tokens"] == 50

    with source_ctx.repository.transaction() as source_store:
        assert len([r for r in source_store.budget_usage_receipts.values() if r.run_id == target_run_id]) == 0


def test_idempotent_handoff_yields_exactly_one_target_proposal(multi_profile_env):
    env = multi_profile_env
    source_ctx, source_actor = env["source_ctx"], env["source_actor"]
    target_actor, source_work_id, target_work_id = env["target_actor"], env["source_work_id"], env["target_work_id"]

    snap = session_runtime.execute(source_ctx, source_actor, source_work_id, {"action": "create", "command_id": "source-snap-1", "title": "Snap"})
    source_session_id = snap["session"]["id"]
    args = {
        "action": "handoff", "session_id": source_session_id, "command_id": "handoff-idem-1",
        "target_profile": "ops", "target_actor": target_actor, "target_work_id": target_work_id,
        "instruction": "Idempotent transfer", "proposal": {"terminal_backend": "local", "connection_id": "openai_compatible"},
    }
    res1 = session_runtime.execute(source_ctx, source_actor, source_work_id, args)
    res2 = session_runtime.execute(source_ctx, source_actor, source_work_id, args)
    assert res1["proposal"]["id"] == res2["proposal"]["id"] and res1["handoff_id"] == res2["handoff_id"]


def test_two_phase_prepare_and_accept_with_tamper_conflict(multi_profile_env):
    env = multi_profile_env
    source_ctx, source_actor = env["source_ctx"], env["source_actor"]
    target_actor, source_work_id, target_work_id = env["target_actor"], env["source_work_id"], env["target_work_id"]

    snap = session_runtime.execute(source_ctx, source_actor, source_work_id, {"action": "create", "command_id": "snap-phase-1", "title": "Phase"})
    packet = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "phase": "prepare", "session_id": snap["session"]["id"],
        "command_id": "phase-handoff-1", "target_profile": "ops", "instruction": "Phase 1 instruction",
    })
    assert packet["status"] == "prepared" and "handoff_digest" in packet

    tampered = dict(packet)
    tampered["instruction"] = "Tampered instruction"
    with pytest.raises(ConflictError, match="Handoff digest conflict"):
        session_runtime.execute(source_ctx, source_actor, source_work_id, {
            "action": "handoff", "phase": "accept", "target_profile": "ops", "handoff_packet": tampered,
            "target_actor": target_actor, "target_work_id": target_work_id,
        })

    accepted = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "phase": "accept", "target_profile": "ops", "handoff_packet": packet,
        "target_actor": target_actor, "target_work_id": target_work_id,
    })
    assert accepted["status"] == "proposed" and accepted["requires_fresh_approval"] is True


def test_source_and_target_access_denials(multi_profile_env):
    env = multi_profile_env
    source_ctx, source_actor = env["source_ctx"], env["source_actor"]
    source_work_id, target_work_id = env["source_work_id"], env["target_work_id"]
    snap = session_runtime.execute(source_ctx, source_actor, source_work_id, {"action": "create", "command_id": "snap-denial-1", "title": "Denial"})

    rogue_actor = Actor(id="person_rogue", workspace_id="ws_source", display_name="Rogue", kind="person")
    with pytest.raises(PermissionDeniedError):
        session_runtime.execute(source_ctx, rogue_actor, source_work_id, {
            "action": "handoff", "session_id": snap["session"]["id"], "command_id": "denied-src-1",
            "target_profile": "ops", "instruction": "Unauthorized export",
        })

    packet = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "phase": "prepare", "session_id": snap["session"]["id"],
        "command_id": "legit-packet-1", "target_profile": "ops", "instruction": "Legitimate export",
    })
    rogue_target_actor = Actor(id="person_rogue_t", workspace_id="ws_ops", display_name="Rogue Target", kind="person")
    with pytest.raises(PermissionDeniedError):
        session_runtime.execute(source_ctx, source_actor, source_work_id, {
            "action": "handoff", "phase": "accept", "target_profile": "ops", "handoff_packet": packet,
            "target_actor": rogue_target_actor, "target_work_id": target_work_id,
        })


def test_target_connection_denial(multi_profile_env):
    env = multi_profile_env
    source_ctx, source_actor = env["source_ctx"], env["source_actor"]
    target_actor, source_work_id, target_work_id = env["target_actor"], env["source_work_id"], env["target_work_id"]
    snap = session_runtime.execute(source_ctx, source_actor, source_work_id, {"action": "create", "command_id": "snap-conn-1", "title": "Conn"})

    with pytest.raises(ConflictError, match="Target profile does not authorize connection"):
        session_runtime.execute(source_ctx, source_actor, source_work_id, {
            "action": "handoff", "session_id": snap["session"]["id"], "command_id": "conn-denial-1",
            "target_profile": "ops", "target_actor": target_actor, "target_work_id": target_work_id,
            "instruction": "Unavailable connection", "proposal": {"connection_id": "non_existent_provider_conn"},
        })


def test_reopen_durability_across_both_repositories(multi_profile_env):
    env = multi_profile_env
    source_ctx, source_actor = env["source_ctx"], env["source_actor"]
    target_ctx, target_actor = env["target_ctx"], env["target_actor"]
    source_work_id, target_work_id = env["source_work_id"], env["target_work_id"]
    snap = session_runtime.execute(source_ctx, source_actor, source_work_id, {"action": "create", "command_id": "snap-reopen-1", "title": "Reopen"})

    result = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "session_id": snap["session"]["id"], "command_id": "reopen-handoff-1",
        "target_profile": "ops", "target_actor": target_actor, "target_work_id": target_work_id, "instruction": "Durability",
    })
    target_prop_id = result["proposal"]["id"]

    source_ctx.close()
    target_ctx.close()
    source_reopened = create_context(workspace_id=source_ctx.workspace_id, db_path=source_ctx.data_dir / "homun.db", data_dir=source_ctx.data_dir, for_tests=True)
    target_reopened = create_context(workspace_id=target_ctx.workspace_id, db_path=target_ctx.data_dir / "homun.db", data_dir=target_ctx.data_dir, for_tests=True)

    with source_reopened.repository.transaction() as s_store:
        assert s_store.commands["reopen-handoff-1"].type == "session.handoff"
    with target_reopened.repository.transaction() as t_store:
        assert t_store.commands["reopen-handoff-1"].type == "session.handoff"
        assert t_store.commands[target_prop_id].result["status"] == "pending_approval"


def test_live_source_drift_conflict_and_offline_import_untrusted(multi_profile_env):
    env = multi_profile_env
    source_ctx, source_actor = env["source_ctx"], env["source_actor"]
    target_actor, source_work_id, target_work_id = env["target_actor"], env["source_work_id"], env["target_work_id"]

    snap = session_runtime.execute(source_ctx, source_actor, source_work_id, {"action": "create", "command_id": "snap-drift-1", "title": "Drift"})
    packet = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "phase": "prepare", "session_id": snap["session"]["id"],
        "command_id": "drift-packet-1", "target_profile": "ops", "instruction": "Drift instruction",
    })

    with source_ctx.repository.transaction() as store:
        store.commands[snap["session"]["id"]].result["messages"].append({"id": "new-msg", "message": {"role": "user", "content": "unexpected"}})
        source_ctx.service.store = store

    with pytest.raises(ConflictError, match="Live source session revision conflict"):
        session_runtime.execute(source_ctx, source_actor, source_work_id, {
            "action": "handoff", "phase": "accept", "target_profile": "ops", "handoff_packet": packet,
            "target_actor": target_actor, "target_work_id": target_work_id, "live_source": True,
        })

    offline_res = session_runtime.execute(source_ctx, source_actor, source_work_id, {
        "action": "handoff", "phase": "accept", "target_profile": "ops", "handoff_packet": packet,
        "target_actor": target_actor, "target_work_id": target_work_id, "live_source": False,
    })
    assert offline_res["status"] == "proposed"
    with env["target_ctx"].repository.transaction() as t_store:
        assert t_store.commands[packet["handoff_id"] + ":snapshot"].result["provenance"] == "handoff-untrusted"
