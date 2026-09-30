"""Policy-driven auto-approval for autonomous agents.

An AgentProfile with autonomy_mode='autonomous' executes its staged gates
without a per-action human click-through, inside the sandbox guarantees:
terminal proposals are auto-approved only on the offline docker policy —
host execution (local-private-v1) always keeps the human gate. Every
auto-approval still flows through the canonical approve() paths (digests,
authority, journal) and is stamped with the policy channel for audit, so a
supervisor can tell policy decisions from human clicks.
"""
from __future__ import annotations

from homun.domain.errors import DomainError
from homun.domain.models import Actor

POLICY_CHANNEL = "policy:autonomy_mode=autonomous"


def owner_actor(ctx, work) -> Actor:
    """The person owner of the work, as required by approval authority."""
    return Actor(id=work.owner_id, workspace_id=ctx.workspace_id, display_name="Work owner")


def autonomous_assignee(store, run) -> bool:
    agent = store.agents.get(run.get("assignee_id"))
    return agent is not None and agent.status == "active" and agent.autonomy_mode == "autonomous"


def _stamp(ctx, record_id: str) -> None:
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            record = store.commands.get(record_id)
            if record is not None:
                record.result["_approval_channel"] = POLICY_CHANNEL
        ctx.service.store = store


def _approve_terminal(ctx, actor, work, run) -> bool:
    from homun.application import terminal_jobs
    proposal_id = run.get("terminal_request_id")
    if not proposal_id:
        return False
    proposal = ctx.repository.load().commands.get(proposal_id)
    if proposal is None:
        return False
    gate = proposal.result
    if gate.get("status") != "pending_approval" or gate.get("policy") == "local-private-v1":
        return False
    try:
        terminal_jobs.approve(ctx, actor, work.id, proposal_id, {"digest": gate["digest"]})
    except DomainError:
        return False
    _stamp(ctx, proposal_id)
    return True


def _approve_file_edit(ctx, actor, work, run) -> bool:
    from homun.application import workspace_file_edits
    proposal_id = run.get("file_edit_request_id")
    if not proposal_id:
        return False
    proposal = ctx.repository.load().commands.get(proposal_id)
    if proposal is None or proposal.result.get("status") != "pending_approval":
        return False
    try:
        workspace_file_edits.approve(ctx, actor, work.id, proposal_id, {"digest": proposal.result["digest"]})
    except DomainError:
        return False
    _stamp(ctx, proposal_id)
    return True


def sweep(ctx, run_id: str) -> bool:
    """Auto-approve staged gates for autonomous assignees. Idempotent.

    Returns True when any gate transitioned. Failures leave the human gate
    in place; they never raise into the delivery loop.
    """
    from homun.application import agent_runs
    store = ctx.repository.load()
    record = store.commands.get(run_id)
    if record is None or record.type != agent_runs.PROPOSAL_TYPE:
        return False
    run = record.result
    if not autonomous_assignee(store, run):
        return False
    work = store.works.get(run.get("work_id"))
    if work is None:
        return False
    actor = owner_actor(ctx, work)
    changed = False
    if run.get("status") == "pending_approval":
        try:
            agent_runs.approve(ctx, actor, work.id, run_id, {
                "command_id": f"{run_id}:auto",
                "expected_version": run["expected_version"],
                "digest": run["digest"],
            })
        except DomainError:
            return changed
        _stamp(ctx, run_id)
        changed = True
        run = ctx.repository.load().commands[run_id].result
    if run.get("status") == "waiting_external":
        changed = _approve_terminal(ctx, actor, work, run) or changed
        changed = _approve_file_edit(ctx, actor, work, run) or changed
    return changed
