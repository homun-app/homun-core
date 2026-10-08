"""H26/H27: due heartbeat/loop prompts enter the agent_run steering queue."""
from __future__ import annotations

from homun.application.automation_dispatch import inject_due_automation
from homun.application.automation_store import AutomationStore, set_automation_store
from homun.application.goal_manager import GoalManager
from homun.application.heartbeat_manager import HeartbeatManager
from homun.application.loop_manager import LoopManager


def test_due_heartbeat_injects_steering(tmp_path):
    set_automation_store(AutomationStore(tmp_path / "auto.sqlite"))
    run = {"id": "run-hb-1", "_protocol": "native-v1", "_messages": [], "_steering": []}
    HeartbeatManager("run-hb-1", min_seconds=1).set("check inbox", interval_seconds=10)
    # Force due by backdating
    mgr = HeartbeatManager("run-hb-1", min_seconds=1)
    assert mgr.state is not None
    mgr.state.created_at = 100.0
    mgr.state.last_fired_at = 100.0
    from homun.application.heartbeat_manager import save_heartbeat

    save_heartbeat("run-hb-1", mgr.state)

    fired = inject_due_automation(run, actor_id="actor-1", now=200.0)
    assert fired == ["heartbeat"]
    assert run["_steering"]
    assert "check inbox" in run["_steering"][0]["text"]
    assert run["_steering"][0]["source"] == "heartbeat"
    set_automation_store(None)


def test_pending_user_input_blocks_heartbeat(tmp_path):
    set_automation_store(AutomationStore(tmp_path / "auto.sqlite"))
    run = {"id": "run-hb-2", "_messages": [], "status": "waiting_input"}
    HeartbeatManager("run-hb-2", min_seconds=1).set("ping", interval_seconds=5)
    mgr = HeartbeatManager("run-hb-2", min_seconds=1)
    mgr.state.created_at = 1.0
    mgr.state.last_fired_at = 1.0
    from homun.application.heartbeat_manager import save_heartbeat

    save_heartbeat("run-hb-2", mgr.state)
    assert inject_due_automation(run, actor_id="a", now=100.0) == []
    set_automation_store(None)


def test_active_goal_blocks_loop_but_not_after_clear(tmp_path):
    set_automation_store(AutomationStore(tmp_path / "auto.sqlite"))
    from homun.application.goal_store import GoalStore, set_goal_store

    set_goal_store(GoalStore(tmp_path / "goals.sqlite"))
    run = {"id": "run-loop-1", "_messages": []}
    LoopManager("run-loop-1", min_interval=1).set("watch metrics", interval_seconds=10)
    loop = LoopManager("run-loop-1", min_interval=1)
    loop.state.next_due_at = 50.0
    from homun.application.loop_manager import save_loop

    save_loop("run-loop-1", loop.state)

    GoalManager("run-loop-1").set("finish the report")
    assert inject_due_automation(run, actor_id="a", now=100.0) == []

    GoalManager("run-loop-1").clear()
    run2 = {"id": "run-loop-1", "_messages": []}
    fired = inject_due_automation(run2, actor_id="a", now=100.0)
    assert fired == ["loop"]
    assert "watch metrics" in run2["_steering"][0]["text"]
    set_goal_store(None)
    set_automation_store(None)
