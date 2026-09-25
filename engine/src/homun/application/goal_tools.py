"""Execution of persistent goal tools for agent runs (H25).

Homun provides agents with explicit control over multi-turn goals, subgoals,
quality gates, and wait barriers without implicit Kanban board manipulation.
"""
from __future__ import annotations

from typing import Any, Dict

from homun.application.goal_contracts import GoalContract
from homun.application.goal_manager import GoalManager
from homun.domain.errors import ValidationError


def execute(ctx, actor, run, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if run.get("goals", {}).get("policy") != "persistent-goals-v1":
        raise ValidationError("Goal tools are not enabled for this run")

    session_id = run.get("work_id") or run.get("id")
    mgr = GoalManager(session_id=session_id)

    if tool == "goal_set":
        goal_text = str(args.get("goal") or "").strip()
        if not goal_text:
            raise ValidationError("goal text cannot be empty")
        contract = GoalContract(
            outcome=str(args.get("outcome") or "").strip(),
            verification=str(args.get("verification") or "").strip(),
            constraints=str(args.get("constraints") or "").strip(),
            boundaries=str(args.get("boundaries") or "").strip(),
            stop_when=str(args.get("stop_when") or "").strip(),
        )
        max_turns = int(args["max_turns"]) if args.get("max_turns") is not None else None
        state = mgr.set(goal_text, max_turns=max_turns, contract=contract)
        # Store in run['_goals'] as durable run snapshot
        run.setdefault("_goals", {})["state"] = state.to_dict()
        return {
            "status": state.status,
            "goal": state.goal,
            "max_turns": state.max_turns,
            "contract": state.contract.to_dict(),
            "status_line": mgr.status_line(),
        }

    if tool == "goal_status":
        state = mgr.state
        if state is None:
            return {"has_goal": False, "status_line": mgr.status_line()}
        return {
            "has_goal": True,
            "status": state.status,
            "goal": state.goal,
            "turns_used": state.turns_used,
            "max_turns": state.max_turns,
            "subgoals": state.subgoals,
            "gates_count": len(state.gates),
            "waiting_on_pid": state.waiting_on_pid,
            "waiting_on_session": state.waiting_on_session,
            "waiting_until": state.waiting_until,
            "status_line": mgr.status_line(),
        }

    if tool == "goal_pause":
        reason = str(args.get("reason") or "user-paused").strip()
        state = mgr.pause(reason=reason)
        if state is None:
            raise ValidationError("No active goal to pause")
        run.setdefault("_goals", {})["state"] = state.to_dict()
        return {"status": state.status, "paused_reason": state.paused_reason, "status_line": mgr.status_line()}

    if tool == "goal_resume":
        reset_budget = bool(args.get("reset_budget", True))
        state = mgr.resume(reset_budget=reset_budget)
        if state is None:
            raise ValidationError("No goal to resume")
        run.setdefault("_goals", {})["state"] = state.to_dict()
        return {"status": state.status, "turns_used": state.turns_used, "status_line": mgr.status_line()}

    if tool == "subgoal_add":
        subgoal = str(args.get("subgoal") or "").strip()
        if not subgoal:
            raise ValidationError("subgoal text cannot be empty")
        try:
            added = mgr.add_subgoal(subgoal)
        except RuntimeError as exc:
            raise ValidationError(str(exc))
        run.setdefault("_goals", {})["state"] = mgr.state.to_dict()
        return {"added": added, "subgoals_count": len(mgr.state.subgoals), "status_line": mgr.status_line()}

    if tool == "subgoal_remove":
        idx = int(args.get("index") or 0)
        try:
            removed = mgr.remove_subgoal(idx)
        except (RuntimeError, IndexError) as exc:
            raise ValidationError(str(exc))
        run.setdefault("_goals", {})["state"] = mgr.state.to_dict()
        return {"removed": removed, "subgoals_count": len(mgr.state.subgoals), "status_line": mgr.status_line()}

    if tool == "goal_gate_add":
        command = str(args.get("command") or "").strip()
        if not command:
            raise ValidationError("gate command cannot be empty")
        try:
            gate = mgr.add_gate(
                command,
                timeout_seconds=args.get("timeout_seconds"),
                max_retries=args.get("max_retries"),
            )
        except RuntimeError as exc:
            raise ValidationError(str(exc))
        run.setdefault("_goals", {})["state"] = mgr.state.to_dict()
        return {"command": gate.command, "timeout_seconds": gate.timeout_seconds, "max_retries": gate.max_retries}

    if tool == "goal_gate_remove":
        idx = int(args.get("index") or 0)
        try:
            removed = mgr.remove_gate(idx)
        except (RuntimeError, IndexError) as exc:
            raise ValidationError(str(exc))
        run.setdefault("_goals", {})["state"] = mgr.state.to_dict()
        return {"removed_command": removed, "gates_count": len(mgr.state.gates)}

    if tool == "goal_wait":
        reason = str(args.get("reason") or "").strip()
        try:
            if args.get("pid"):
                mgr.wait_on(int(args["pid"]), reason=reason)
            elif args.get("session_id"):
                mgr.wait_on_session(str(args["session_id"]), reason=reason)
            elif args.get("seconds"):
                mgr.wait_for_seconds(int(args["seconds"]), reason=reason)
            else:
                raise ValidationError("Must specify pid, session_id, or seconds to wait")
        except (RuntimeError, ValueError) as exc:
            raise ValidationError(str(exc))
        run.setdefault("_goals", {})["state"] = mgr.state.to_dict()
        return {"waiting": True, "status_line": mgr.status_line()}

    raise ValidationError(f"Unknown goal tool: {tool}")
