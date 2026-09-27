"""Inject due heartbeat/loop prompts into the canonical agent_run steering queue (H26/H27).

Owns the product link between durable AutomationStore state and agent_run_execution._claim.
Goals preempt loop ticks; human pending input and in-flight tool calls preempt heartbeats.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import uuid4

from homun.application import agent_native
from homun.application.goal_manager import GoalManager
from homun.application.heartbeat_manager import HeartbeatManager
from homun.application.loop_manager import LoopManager


def automation_session_id(run: Dict[str, Any]) -> str:
    """Canonical goal and automation key; work identity survives run epochs."""
    return str(run.get("work_id") or run.get("_automation_session_id") or run.get("session_id") or run.get("id") or "")


def inject_due_automation(
    run: Dict[str, Any],
    *,
    actor_id: str,
    now: Optional[float] = None,
    has_pending_user_input: bool = False,
) -> List[str]:
    """Drain due automation into run['_steering']. Returns sources that fired."""
    session_id = automation_session_id(run)
    if not session_id:
        return []

    pending_tool = agent_native.enabled(run) and agent_native.pending(run) is not None
    has_steering = bool(run.get("_steering"))
    busy = pending_tool or has_steering
    if run.get("status") == "waiting_input":
        has_pending_user_input = True

    fired: List[str] = []

    hb = HeartbeatManager(session_id)
    prompt = hb.due_prompt(
        now=now,
        has_pending_user_input=has_pending_user_input,
        is_session_busy=busy,
    )
    if prompt:
        run.setdefault("_steering", []).append(
            {
                "text": prompt,
                "command_id": f"heartbeat-{uuid4().hex[:10]}",
                "actor_id": actor_id,
                "source": "heartbeat",
            }
        )
        fired.append("heartbeat")
        busy = True

    if not busy and not has_pending_user_input:
        goal_mgr = GoalManager(session_id)
        loop = LoopManager(session_id)
        tick = loop.fire_tick(goal_manager=goal_mgr, now=now)
        if tick:
            run.setdefault("_steering", []).append(
                {
                    "text": tick,
                    "command_id": f"loop-{uuid4().hex[:10]}",
                    "actor_id": actor_id,
                    "source": "loop",
                }
            )
            fired.append("loop")

    return fired
