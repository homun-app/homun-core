"""Tests for durable idle session heartbeats, user priority, and boundary isolation (H26)."""
import time
import pytest

from homun.application.heartbeat_manager import (
    HeartbeatManager,
    HeartbeatState,
    clear_heartbeat,
    format_interval,
    load_heartbeat,
    migrate_heartbeat_to_session,
    parse_interval,
    reset_session_heartbeats,
    save_heartbeat,
)


def test_parse_and_format_interval():
    assert parse_interval("10m") == 600
    assert parse_interval("every 2h") == 7200
    assert parse_interval("every 90 seconds") == 90
    assert parse_interval("30s", min_seconds=60) == -1
    assert parse_interval("invalid") is None
    assert format_interval(600) == "10m"
    assert format_interval(3600) == "1h"
    assert format_interval(45) == "45s"


def test_heartbeat_manager_lifecycle():
    mgr = HeartbeatManager("session-hb-1", min_seconds=10)
    state = mgr.set("Poll deployment health", interval_seconds=10)
    assert state.status == "active"
    assert mgr.is_active()
    assert mgr.has_heartbeat()

    # Pause
    mgr.pause()
    assert mgr.state.status == "paused"
    assert not mgr.is_active()

    # Resume re-anchors last_fired_at
    mgr.resume()
    assert mgr.is_active()

    # Clear
    assert mgr.clear() is True
    assert mgr.state is None
    assert not mgr.has_heartbeat()


def test_heartbeat_due_prompt_and_coalescing():
    mgr = HeartbeatManager("session-hb-due", min_seconds=10)
    t0 = 1000.0
    mgr.set("Periodic check", interval_seconds=60)
    mgr.state.created_at = t0
    mgr.state.last_fired_at = 0.0

    # Not due before 60s
    assert mgr.due_prompt(now=t0 + 30) is None

    # Due at t0 + 60: claims immediately
    prompt = mgr.due_prompt(now=t0 + 65)
    assert prompt is not None
    assert "Periodic check" in prompt
    assert mgr.state.fire_count == 1
    assert mgr.state.last_fired_at == t0 + 65

    # Immediately polling again does NOT double-fire
    assert mgr.due_prompt(now=t0 + 70) is None

    # Missed ticks coalesce: at t0 + 500, fires once and resets anchor to NOW
    prompt2 = mgr.due_prompt(now=t0 + 500)
    assert prompt2 is not None
    assert mgr.state.fire_count == 2
    assert mgr.state.last_fired_at == t0 + 500


def test_heartbeat_abandon_fire_rewinds_claim():
    mgr = HeartbeatManager("session-hb-abandon", min_seconds=10)
    t0 = 1000.0
    mgr.set("Deploy watchdog", interval_seconds=60)
    mgr.state.created_at = t0

    # Claim tick
    prompt = mgr.due_prompt(now=t0 + 60)
    assert prompt is not None
    assert mgr.state.fire_count == 1

    # If admission is cancelled or execution rejected before starting, abandon_fire rewinds the claim
    assert mgr.abandon_fire() is True
    assert mgr.state.fire_count == 0
    assert mgr.state.last_fired_at == 0.0

    # It remains due on the next poll
    prompt_retry = mgr.due_prompt(now=t0 + 61)
    assert prompt_retry is not None
    assert mgr.state.fire_count == 1


def test_human_input_preempts_heartbeat():
    mgr = HeartbeatManager("session-hb-user-win", min_seconds=10)
    t0 = 1000.0
    mgr.set("Status update", interval_seconds=60)
    mgr.state.created_at = t0

    # Due by clock, but user has pending input or session is busy -> suppressed / waits
    assert mgr.due_prompt(now=t0 + 70, has_pending_user_input=True) is None
    assert mgr.state.fire_count == 0

    assert mgr.due_prompt(now=t0 + 70, is_session_busy=True) is None
    assert mgr.state.fire_count == 0

    # When idle without pending input, it fires
    assert mgr.due_prompt(now=t0 + 70, has_pending_user_input=False, is_session_busy=False) is not None
    assert mgr.state.fire_count == 1


def test_heartbeat_session_boundaries_and_reset():
    parent = "session-conv-parent"
    child = "session-conv-child"
    replacement = "session-conv-replacement"

    mgr = HeartbeatManager(parent, min_seconds=10)
    mgr.set("Active monitor", interval_seconds=60)

    # Compression rotation: migrates from parent to child
    assert migrate_heartbeat_to_session(parent, child) is True
    assert load_heartbeat(parent) is None
    child_mgr = HeartbeatManager(child, min_seconds=10)
    assert child_mgr.is_active()

    # Reset clears the departing conversation's heartbeat so it never enters the replacement conversation
    reset_session_heartbeats(child)
    assert load_heartbeat(child) is None
    assert load_heartbeat(replacement) is None
