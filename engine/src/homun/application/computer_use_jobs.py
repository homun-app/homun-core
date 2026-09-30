"""Computer-use actions with digest-gated approval, mirroring terminal jobs.

Propose classifies the action through the three-tier policy and either
refuses (blocked), stages a pending human gate (sensitive or not
allowlisted), or executes immediately (allowlisted autonomous agent).
Approval recomputes the digest — a changed action can never be approved
with a stale consent — and stamps ``_approval_channel`` like every other
gate so relay/policy/human decisions stay distinguishable in the journal.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Optional

from copy import deepcopy

from homun.application import computer_use_backend
from homun.application.computer_use_policy import classify, gate_required
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.domain.models import CommandRecord, utc_now
from homun.execution.identity import digest

PROPOSAL_TYPE = "computer_use.action"


def consent(action: Dict[str, Any]) -> str:
    """The exact content a human approves; changing anything invalidates it."""
    bound = {k: action.get(k) for k in (
        "run_id", "action", "app", "text", "keys", "element", "x", "y")}
    return digest(json.dumps(bound, sort_keys=True, ensure_ascii=False))


def _human_owner(store, actor, work) -> None:
    if getattr(actor, "kind", "person") != "person" or actor.id not in {
            work.owner_id, work.reviewer_id}:
        raise PermissionDeniedError("Only the work owner or reviewer decides")


def _autonomous_assignee(store, run: Dict[str, Any]) -> bool:
    agent = store.agents.get(run.get("assignee_id"))
    return agent is not None and agent.status == "active" and agent.autonomy_mode == "autonomous"


def _allowlist(store, run: Dict[str, Any]) -> list[str]:
    agent = store.agents.get(run.get("assignee_id"))
    return list(getattr(agent, "computer_use_apps", None) or []) if agent else []


def propose(ctx, actor, work_id: str, run_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
    """Classify one action; stage a gate or execute when the policy allows."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = store.commands.get(run_id)
            run = record.result if record is not None else None
            work = store.works.get(work_id)
            if work is None or not isinstance(run, dict) or run.get("work_id") != work_id:
                raise NotFoundError(f"Run not found: {run_id}")
            verdict = classify(action, app=action.get("app"),
                               allowlist=_allowlist(store, run))
            if verdict["tier"] == "blocked":
                raise ValidationError(f"Computer-use refused: {verdict['reason']}")
            gate = {
                "work_id": work_id, "run_id": run_id,
                "action": {**action, "run_id": run_id},
                "verdict": verdict, "status": "", "created_by": actor.id,
                "created_at": utc_now().isoformat(),
            }
            gate["id"] = "cu:" + consent(gate["action"])[:24]
            gate["digest"] = consent(gate["action"])
            prior = store.commands.get(gate["id"])
            if prior is not None:
                if prior.type != PROPOSAL_TYPE or prior.result.get("digest") != gate["digest"]:
                    raise ConflictError("Command id is already bound to another request")
                return deepcopy(prior.result)
            if not gate_required(verdict, autonomous=_autonomous_assignee(store, run)):
                gate["status"] = "executed_inline"
                gate["result"] = _execute(gate)
            else:
                gate["status"] = "pending_approval"
            store.commands[gate["id"]] = CommandRecord(
                command_id=gate["id"], type=PROPOSAL_TYPE,
                actor_id=actor.id, workspace_id=store.workspace_id, result=gate)
        ctx.service.store = store
    return deepcopy(gate)


def _execute(gate: Dict[str, Any]) -> Dict[str, Any]:
    action = gate["action"]
    name = str(action.get("action"))
    mapping = {
        "capture": ("get_window_state", {"app": action.get("app")}),
        "screenshot": ("screenshot", {}),
        "click": ("click", {"element_token": action.get("element"),
                            "x": action.get("x"), "y": action.get("y")}),
        "type": ("type", {"text": action.get("text")}),
        "key": ("press_key", {"keys": action.get("keys")}),
        "scroll": ("scroll", {"direction": action.get("direction") or "down"}),
    }
    tool, arguments = mapping.get(name, ("get_window_state", {"app": action.get("app")}))
    return computer_use_backend.call_tool(tool, arguments)


def approve(ctx, actor, work_id: str, proposal_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Human decision on a staged computer-use action (digest-pinned)."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = store.works.get(work_id)
            record = store.commands.get(proposal_id)
            gate = getattr(record, "result", None) if record else None
            if work is None or not isinstance(gate, dict) or gate.get("work_id") != work_id:
                raise NotFoundError(f"Proposal not found: {proposal_id}")
            _human_owner(store, actor, work)
            if body.get("digest") != gate["digest"] or consent(gate["action"]) != gate["digest"]:
                raise ValidationError("Approval does not match the proposed action")
            if gate["status"] == "pending_approval":
                gate["result"] = _execute(gate)
                gate["status"] = "executed"
                gate["_approval_channel"] = str(body.get("channel") or "human:desktop")
        ctx.service.store = store
    return deepcopy(gate)


def reject(ctx, actor, work_id: str, proposal_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = store.works.get(work_id)
            record = store.commands.get(proposal_id)
            gate = getattr(record, "result", None) if record else None
            if work is None or not isinstance(gate, dict) or gate.get("work_id") != work_id:
                raise NotFoundError(f"Proposal not found: {proposal_id}")
            _human_owner(store, actor, work)
            if body.get("digest") != gate["digest"]:
                raise ValidationError("Rejection does not match the proposed action")
            if gate["status"] == "pending_approval":
                gate["status"] = "rejected"
        ctx.service.store = store
    return deepcopy(gate)


def list_for_work(ctx, actor, work_id: str) -> Dict[str, Any]:
    store = ctx.repository.load()
    from homun.policy.work import require_work_access
    require_work_access(store, actor, work_id, "read")
    items = [record.result for record in store.commands.values()
             if record.type == PROPOSAL_TYPE
             and isinstance(record.result, dict)
             and record.result.get("work_id") == work_id
             and record.result.get("status") in {"pending_approval", "executed", "rejected"}]
    return {"items": items}


def list_pending_for_run(store, run_id: str) -> list[Dict[str, Any]]:
    return [record.result for record in store.commands.values()
            if record.type == PROPOSAL_TYPE
            and isinstance(record.result, dict)
            and record.result.get("run_id") == run_id
            and record.result.get("status") == "pending_approval"]
