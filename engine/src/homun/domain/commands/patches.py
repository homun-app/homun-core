"""Patches domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, PlanRevision, PlanStep, utc_now
from homun.domain.patch import WorkPatchChange, build_preview
from homun.domain.states import WorkStatus, assert_work_transition

from homun.domain.command_context import CommandContext


def _parse_patch_changes(ctx: CommandContext, payload: dict[str, Any]) -> list[WorkPatchChange]:
    raw = payload.get("changes")
    if not isinstance(raw, list) or not raw:
        raise ValidationError("Patch requires a non-empty changes list")
    return [WorkPatchChange.model_validate(item) for item in raw]


def _roster_ids_from_payload(ctx: CommandContext, payload: dict[str, Any], actor: Actor) -> set[str]:
    raw = payload.get("roster_ids")
    if isinstance(raw, list) and raw:
        return {str(item) for item in raw}
    # Default: actor + known agents in the workspace.
    ids = {actor.id}
    ids.update(ctx.store.agents.keys())
    return ids


def _work_preview_patch(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    changes = _parse_patch_changes(ctx, payload)
    proposal = build_preview(
        work,
        ctx.current_plan(work),
        changes,
        roster_ids=_roster_ids_from_payload(ctx, payload, actor),
    )
    return {"proposal": proposal.model_dump(mode="json")}


def _work_apply_patch(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    changes = _parse_patch_changes(ctx, payload)
    roster_ids = _roster_ids_from_payload(ctx, payload, actor)
    proposal = build_preview(work, ctx.current_plan(work), changes, roster_ids=roster_ids)
    if proposal.missing_or_ambiguous:
        raise ValidationError(
            "Patch invalid: " + "; ".join(proposal.missing_or_ambiguous)
        )

    plan_touched = False
    plan = ctx.current_plan(work)
    new_steps: list[PlanStep] | None = None
    if any(c.field == "step_assignee" for c in proposal.changes):
        if plan is None:
            raise ValidationError("No plan to patch")
        new_steps = [step.model_copy(deep=True) for step in plan.steps]

    for change in proposal.changes:
        if change.field == "objective":
            work.objective = str(change.to_value or "")
        elif change.field == "owner_id":
            work.owner_id = str(change.to_value or "")
        elif change.field == "step_assignee":
            assert new_steps is not None
            step = next((s for s in new_steps if s.id == change.step_id), None)
            if step is None:
                raise ValidationError(f"Unknown step_id: {change.step_id}")
            step.assignee_id = str(change.to_value or "")
            plan_touched = True
        else:
            raise ValidationError(f"Unsupported patch field: {change.field}")

    plan_revision = work.current_plan_revision
    if plan_touched and new_steps is not None:
        revision_number = work.current_plan_revision + 1
        revised = PlanRevision(
            id=new_id("plan"),
            work_id=work.id,
            revision=revision_number,
            steps=new_steps,
            created_by=actor.id,
        )
        ctx.store.plans[ctx.store.plan_key(work.id, revision_number)] = revised
        work.current_plan_revision = revision_number
        plan_revision = revision_number
        if work.status == WorkStatus.READY:
            assert_work_transition(work.status, WorkStatus.DRAFT)
            work.status = WorkStatus.DRAFT

    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="work.patched",
        payload={
            "changes": [c.model_dump(mode="json") for c in proposal.changes],
            "plan_revision": plan_revision,
        },
    )
    return {
        "work_id": work.id,
        "version": work.version,
        "status": work.status,
        "plan_revision": plan_revision,
        "proposal": proposal.model_dump(mode="json"),
    }

