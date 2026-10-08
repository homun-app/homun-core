"""Tests for persistent goals, contracts, quality gates, wait barriers, and judging (H25)."""
import os
import subprocess
import time
import pytest

from homun.application.goal_contracts import (
    GoalContract,
    GoalGate,
    parse_contract,
    run_gate,
)
from homun.application.goal_manager import (
    GoalManager,
    extract_json_object,
    migrate_goal_to_session,
    parse_judge_response,
)
from homun.application.goal_tools import execute as execute_goal_tools
from homun.domain.errors import ValidationError
from homun.application.goal_store import GoalStore, set_goal_store


@pytest.fixture(autouse=True)
def _isolated_goal_store(tmp_path, monkeypatch):
    """Keep H25 goal tests off the product goals.sqlite file."""
    db = tmp_path / "goals-test.sqlite"
    store = GoalStore(db)
    set_goal_store(store)
    monkeypatch.setenv("HOMUN_GOAL_DB", str(db))
    yield store
    store.close()
    set_goal_store(None)



def test_goal_contract_parsing():
    raw = (
        "Refactor authentication flow\n"
        "Outcome: Single unified auth handler across API and Web\n"
        "Verification: pytest tests/test_auth.py passes\n"
        "Constraints: Do not change public JWT format\n"
        "Boundaries: src/auth and tests/test_auth.py only\n"
        "Stop when: External IdP credential is required\n"
    )
    headline, contract = parse_contract(raw)
    assert headline == "Refactor authentication flow"
    assert contract.outcome == "Single unified auth handler across API and Web"
    assert contract.verification == "pytest tests/test_auth.py passes"
    assert contract.constraints == "Do not change public JWT format"
    assert contract.boundaries == "src/auth and tests/test_auth.py only"
    assert contract.stop_when == "External IdP credential is required"
    assert not contract.is_empty()

    block = contract.render_block()
    assert "- Outcome:" in block
    assert "- Verification:" in block


def test_quality_gate_execution():
    gate = GoalGate(command="echo 'test gate output'", max_retries=2)
    passed, code, output = run_gate(gate)
    assert passed is True
    assert code == 0
    assert "test gate output" in output

    failing = GoalGate(command="exit 42", max_retries=2)
    passed_fail, code_fail, _ = run_gate(failing)
    assert passed_fail is False
    assert code_fail == 42


def test_judge_response_parsing():
    # 1. Valid done verdict
    verdict, reason, parse_failed, wait_dir = parse_judge_response('{"verdict": "done", "reason": "all tests green"}')
    assert verdict == "done"
    assert reason == "all tests green"
    assert parse_failed is False
    assert wait_dir is None

    # 2. Blocked verdict
    verdict, reason, parse_failed, _ = parse_judge_response('{"verdict": "blocked", "reason": "missing API secret"}')
    assert verdict == "blocked"
    assert parse_failed is False

    # 3. Wait on PID
    verdict, reason, parse_failed, wait_dir = parse_judge_response('{"verdict": "wait", "wait_on_pid": 1234, "reason": "waiting for build"}')
    assert verdict == "wait"
    assert wait_dir == {"pid": 1234}

    # 4. Wait for seconds
    verdict, reason, parse_failed, wait_dir = parse_judge_response('{"verdict": "wait", "wait_for_seconds": 60, "reason": "rate limit"}')
    assert verdict == "wait"
    assert wait_dir == {"seconds": 60}

    # 5. Legacy done shape
    verdict, reason, parse_failed, _ = parse_judge_response('{"done": true, "reason": "legacy done"}')
    assert verdict == "done"

    # 6. Unparseable fail-open
    verdict, reason, parse_failed, _ = parse_judge_response('not json at all')
    assert verdict == "continue"
    assert parse_failed is True


def test_goal_manager_lifecycle_and_turn_budget():
    mgr = GoalManager("session-goal-lifecycle", default_max_turns=3)
    state = mgr.set("Deploy backend service", max_turns=3)
    assert state.status == "active"
    assert mgr.is_active()

    # Turn 1: continues
    res1 = mgr.evaluate_after_turn("I have prepared the configs.", judge_fn=lambda **kw: ("continue", "needs deploy step", False, None, False))
    assert res1["status"] == "active"
    assert res1["should_continue"] is True
    assert mgr.state.turns_used == 1

    # Turn 2: continues
    res2 = mgr.evaluate_after_turn("I deployed to staging.", judge_fn=lambda **kw: ("continue", "needs prod step", False, None, False))
    assert res2["should_continue"] is True
    assert mgr.state.turns_used == 2

    # Turn 3: exhausts budget -> paused (budget backstop without implicit kanban creation)
    res3 = mgr.evaluate_after_turn("Deploying to prod.", judge_fn=lambda **kw: ("continue", "verifying", False, None, False))
    assert res3["status"] == "paused"
    assert res3["should_continue"] is False
    assert "budget exhausted" in mgr.state.paused_reason

    # Resume with reset budget
    resumed = mgr.resume(reset_budget=True)
    assert resumed.status == "active"
    assert resumed.turns_used == 0

    # Done verdict terminates goal
    res_done = mgr.evaluate_after_turn("Everything verified.", judge_fn=lambda **kw: ("done", "prod live and healthy", False, None, False))
    assert res_done["status"] == "done"
    assert res_done["should_continue"] is False


def test_goal_manager_quality_gates():
    mgr = GoalManager("session-goal-gates", default_max_turns=10)
    mgr.set("Implement feature")
    mgr.add_gate("false", max_retries=1)  # Command will fail with exit 1

    # First turn: gate fails -> returns continuation prompt with gate failure evidence without calling judge
    res1 = mgr.evaluate_after_turn("Finished implementation.")
    assert res1["verdict"] == "gate_failed"
    assert res1["should_continue"] is True
    assert "quality gate failed" in res1["message"].lower()

    # Second turn: gate still fails and exhausts retries -> auto-pauses
    res2 = mgr.evaluate_after_turn("Attempted repair.")
    assert res2["status"] == "paused"
    assert res2["should_continue"] is False
    assert "exhausted" in mgr.state.paused_reason


def test_goal_wait_barrier():
    mgr = GoalManager("session-goal-wait")
    mgr.set("Long build task")
    mgr.wait_for_seconds(300, reason="waiting for async compiler")
    assert mgr.is_waiting()

    # While waiting, evaluate_after_turn does not burn turns
    res = mgr.evaluate_after_turn("still compiling")
    assert res["status"] == "active"
    assert res["should_continue"] is False
    assert res["verdict"] == "waiting"
    assert mgr.state.turns_used == 0

    # Stop waiting manually or automatically lifts barrier
    assert mgr.stop_waiting() is True
    assert not mgr.is_waiting()


def test_goal_tools_execution():
    run = {
        "id": "run-goal-test",
        "work_id": "session-tool-test",
        "goals": {"policy": "persistent-goals-v1", "version": 1},
    }

    # Set goal via tool
    res_set = execute_goal_tools(None, None, run, "goal_set", {
        "goal": "Migrate database",
        "outcome": "Postgres schema migrated",
        "verification": "alembic current is head",
        "max_turns": 15,
    })
    assert res_set["status"] == "active"
    assert res_set["max_turns"] == 15
    assert "_goals" in run

    # Add subgoal
    res_sub = execute_goal_tools(None, None, run, "subgoal_add", {"subgoal": "Back up existing tables"})
    assert res_sub["added"] == "Back up existing tables"

    # Status tool
    res_status = execute_goal_tools(None, None, run, "goal_status", {})
    assert res_status["has_goal"] is True
    assert res_status["subgoals"] == ["Back up existing tables"]

    # Pause tool
    res_pause = execute_goal_tools(None, None, run, "goal_pause", {"reason": "waiting for operator"})
    assert res_pause["status"] == "paused"

    # Resume tool
    res_resume = execute_goal_tools(None, None, run, "goal_resume", {"reset_budget": True})
    assert res_resume["status"] == "active"


def test_goal_session_migration():
    from homun.application.goal_manager import load_goal

    mgr1 = GoalManager("session-old")
    mgr1.set("Persistent migration goal")
    assert migrate_goal_to_session("session-old", "session-new", reason="test-compaction") is True
    # Store is authoritative after migration; in-memory manager may be stale until reload.
    assert load_goal("session-old").status == "cleared"
    mgr1_reloaded = GoalManager("session-old")
    assert mgr1_reloaded.state.status == "cleared"

    mgr2 = GoalManager("session-new")
    assert mgr2.is_active()
    assert mgr2.state.goal == "Persistent migration goal"


def test_goal_survives_store_reopen(tmp_path, monkeypatch):
    """Goals must reload from SQLite after a new GoalStore instance (restart)."""
    from homun.application.goal_store import GoalStore, set_goal_store

    db = tmp_path / "goals.sqlite"
    store1 = GoalStore(db)
    set_goal_store(store1)
    mgr = GoalManager("session-persist")
    mgr.set("Survive engine restart")
    assert mgr.is_active()
    store1.close()

    store2 = GoalStore(db)
    set_goal_store(store2)
    mgr2 = GoalManager("session-persist")
    assert mgr2.is_active()
    assert mgr2.state.goal == "Survive engine restart"
    set_goal_store(None)
