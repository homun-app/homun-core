"""Tests for proactive loops, self-paced backoff, and goal precedence (H27)."""
import time
import pytest

from homun.application.goal_manager import GoalManager
from homun.application.loop_manager import (
    DEFAULT_SELF_PACED_CEILING_SECONDS,
    DEFAULT_SELF_PACED_FLOOR_SECONDS,
    LOOP_COMPLETE_MARKER,
    LoopManager,
    goal_blocks_loop_tick,
    migrate_loop_to_session,
    parse_interval_token,
    parse_loop_args,
    response_signals_complete,
)


def test_parse_loop_arguments():
    # 1. Fixed interval with times and until
    res1 = parse_loop_args("5m check queue --times 10 --until queue is empty")
    assert res1["interval_seconds"] == 300
    assert res1["prompt"] == "check queue"
    assert res1["times"] == 10
    assert res1["until"] == "queue is empty"

    # 2. Leading 'every'
    res2 = parse_loop_args("every 10m /recap")
    assert res2["interval_seconds"] == 600
    assert res2["prompt"] == "/recap"

    # 3. Self-paced mode (no interval token)
    res3 = parse_loop_args("fix unit tests until all pass")
    assert res3["interval_seconds"] is None
    assert res3["prompt"] == "fix unit tests until all pass"

    # 4. Interval token parsing
    assert parse_interval_token("30s") == 30
    assert parse_interval_token("1h30m") == 5400


def test_loop_completion_marker_detection():
    assert response_signals_complete(f"All files repaired.\n{LOOP_COMPLETE_MARKER}") is True
    assert response_signals_complete(f"Work in progress\n{LOOP_COMPLETE_MARKER}.") is True
    assert response_signals_complete("Work in progress without sentinel") is False


def test_loop_manager_lifecycle_and_caps():
    mgr = LoopManager("session-loop-1", min_interval=10)
    t0 = 1000.0
    state = mgr.set("Poll build", interval_seconds=10, times=2, now=t0)
    assert state.status == "active"
    assert mgr.is_active()

    # Tick 1: fires
    assert mgr.is_due(now=t0) is True
    msg1 = mgr.fire_tick(now=t0)
    assert msg1 is not None
    assert "Poll build" in msg1
    assert mgr.state.ticks_fired == 1
    assert mgr.state.awaiting_response is True

    # Complete tick 1: still looping
    res1 = mgr.complete_tick("Build step 1 finished.", now=t0 + 2)
    assert res1["status"] == "active"
    assert res1["stopped"] is False

    # Tick 2: fires
    assert mgr.is_due(now=t0 + 20) is True
    msg2 = mgr.fire_tick(now=t0 + 20)
    assert msg2 is not None
    assert mgr.state.ticks_fired == 2

    # Complete tick 2: times cap reached (2/2) -> done!
    res2 = mgr.complete_tick("Build step 2 finished.", now=t0 + 22)
    assert res2["status"] == "done"
    assert res2["stopped"] is True
    assert "completed 2 runs" in res2["reason"]


def test_loop_agent_self_stop_marker():
    mgr = LoopManager("session-loop-marker", min_interval=10)
    mgr.set("Watch file until changed", interval_seconds=15)
    mgr.fire_tick()
    res = mgr.complete_tick(f"File changed and processed.\n{LOOP_COMPLETE_MARKER}")
    assert res["status"] == "done"
    assert res["stopped"] is True
    assert "complete" in res["reason"]


def test_loop_evidence_until_judge():
    mgr = LoopManager("session-loop-until", min_interval=10)
    mgr.set("Run tests", interval_seconds=15, until="all tests pass")
    mgr.fire_tick()

    # Judge returns done
    res = mgr.complete_tick(
        "Pytest passed 12/12.",
        until_judge=lambda cond, resp: ("done", "tests are green"),
    )
    assert res["status"] == "done"
    assert "stop condition met" in res["reason"]


def test_loop_self_paced_exponential_backoff():
    mgr = LoopManager("session-loop-selfpaced", min_interval=10)
    mgr.set("Monitor background worker")  # self-paced
    assert mgr.state.mode == "self_paced"
    assert mgr.state.current_delay == float(DEFAULT_SELF_PACED_FLOOR_SECONDS)

    # First turn
    mgr.fire_tick()
    mgr.complete_tick("No new jobs in queue at 10:00:01.")
    assert mgr.state.current_delay == float(DEFAULT_SELF_PACED_FLOOR_SECONDS)

    # Second turn with unchanged output (timestamp difference stripped) -> doubles delay
    mgr.state.next_due_at = 0.0  # make due
    mgr.fire_tick()
    mgr.complete_tick("No new jobs in queue at 10:01:02.")
    assert mgr.state.current_delay == float(DEFAULT_SELF_PACED_FLOOR_SECONDS * 2)

    # Third turn with changed output -> snaps back to floor
    mgr.state.next_due_at = 0.0
    mgr.fire_tick()
    mgr.complete_tick("Found 5 new jobs, starting processing.")
    assert mgr.state.current_delay == float(DEFAULT_SELF_PACED_FLOOR_SECONDS)


def test_goal_precedence_over_loop():
    session_id = "session-precedence"
    goal_mgr = GoalManager(session_id)
    loop_mgr = LoopManager(session_id, min_interval=10)
    loop_mgr.set("Background health check", interval_seconds=10)

    # Case 1: No goal -> loop is not blocked
    assert goal_blocks_loop_tick(None) is False
    assert loop_mgr.is_due(goal_manager=goal_mgr) is True

    # Case 2: Active running goal -> DEFERS loop tick!
    goal_mgr.set("Active refactoring goal")
    assert goal_mgr.is_active() and not goal_mgr.is_waiting()
    assert goal_blocks_loop_tick(goal_mgr) is True
    assert loop_mgr.is_due(goal_manager=goal_mgr) is False

    # Case 3: Goal is parked / waiting on a barrier -> PERMITS loop tick!
    goal_mgr.wait_for_seconds(300, reason="waiting for build")
    assert goal_mgr.is_waiting() is True
    assert goal_blocks_loop_tick(goal_mgr) is False
    assert loop_mgr.is_due(goal_manager=goal_mgr) is True

    # Case 4: Goal paused -> PERMITS loop tick!
    goal_mgr.pause()
    assert goal_blocks_loop_tick(goal_mgr) is False
    assert loop_mgr.is_due(goal_manager=goal_mgr) is True


def test_loop_session_migration():
    assert migrate_loop_to_session("session-loop-old", "session-loop-new") is False  # nothing to migrate
    mgr = LoopManager("session-loop-old", min_interval=10)
    mgr.set("Recurring poller", interval_seconds=30)
    assert migrate_loop_to_session("session-loop-old", "session-loop-new") is True

    new_mgr = LoopManager("session-loop-new", min_interval=10)
    assert new_mgr.is_active()
    assert new_mgr.state.prompt == "Recurring poller"
