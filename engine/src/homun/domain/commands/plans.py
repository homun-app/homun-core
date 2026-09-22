"""Plans domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, PlanRevision, PlanStep, utc_now
from homun.domain.states import StepStatus, WorkStatus, assert_work_transition

from homun.domain.command_context import CommandContext


def _plan_propose(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    if work.status not in {WorkStatus.DRAFT, WorkStatus.READY}:
        raise ValidationError("Plan can only be proposed while draft or ready")
    steps_raw = payload.get("steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise ValidationError("Plan requires at least one step")
    steps: list[PlanStep] = []
    for item in steps_raw:
        if not isinstance(item, dict):
            raise ValidationError("Each step must be an object")
        step_id = str(item.get("id") or new_id("step"))
        title = str(item.get("title", "")).strip()
        assignee_id = str(item.get("assignee_id", "")).strip()
        if not title or not assignee_id:
            raise ValidationError("Each step needs title and assignee_id")
        steps.append(
            PlanStep(
                id=step_id,
                title=title,
                assignee_id=assignee_id,
                depends_on=[str(x) for x in item.get("depends_on", [])],
                output_expected=str(item.get("output_expected", "")),
                capability=str(item.get("capability", "general")) or "general",
            )
        )
    revision_number = work.current_plan_revision + 1
    plan = PlanRevision(
        id=new_id("plan"),
        work_id=work.id,
        revision=revision_number,
        steps=steps,
        created_by=actor.id,
    )
    ctx.store.plans[ctx.store.plan_key(work.id, revision_number)] = plan
    work.current_plan_revision = revision_number
    work.version += 1
    work.updated_at = utc_now()
    if work.status == WorkStatus.READY:
        # New plan while ready returns to draft until accepted again.
        assert_work_transition(work.status, WorkStatus.DRAFT)
        work.status = WorkStatus.DRAFT
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="plan.proposed",
        payload={"revision": revision_number, "step_count": len(steps)},
    )
    return {
        "work_id": work.id,
        "plan_revision": revision_number,
        "plan_id": plan.id,
        "version": work.version,
        "status": work.status,
    }


def _plan_accept(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    plan = ctx.current_plan(work)
    if plan is None:
        raise ValidationError("No plan to accept")
    if not all(step.assignee_id and step.title for step in plan.steps):
        raise ValidationError("Plan incomplete")
    assert_work_transition(work.status, WorkStatus.READY)
    work.status = WorkStatus.READY
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="plan.accepted",
        payload={"revision": plan.revision},
    )
    return {"work_id": work.id, "status": work.status, "version": work.version}


def _plan_revise(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Insert or reorder steps; never rewrite succeeded steps in place."""
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    current = ctx.current_plan(work)
    if current is None:
        raise ValidationError("No plan to revise")

    # Copy previous steps; succeeded ones stay historical with same ids/status.
    new_steps: list[PlanStep] = [step.model_copy(deep=True) for step in current.steps]
    for step in new_steps:
        if step.status == StepStatus.RUNNING:
            step.status = StepStatus.CANCELLED

    insert_after = payload.get("insert_after_step_id")
    new_step_payload = payload.get("new_step")
    if new_step_payload is not None:
        if not isinstance(new_step_payload, dict):
            raise ValidationError("new_step must be an object")
        title = str(new_step_payload.get("title", "")).strip()
        assignee_id = str(new_step_payload.get("assignee_id", "")).strip()
        if not title or not assignee_id:
            raise ValidationError("new_step needs title and assignee_id")
        step = PlanStep(
            id=str(new_step_payload.get("id") or new_id("step")),
            title=title,
            assignee_id=assignee_id,
            depends_on=[str(x) for x in new_step_payload.get("depends_on", [])],
            output_expected=str(new_step_payload.get("output_expected", "")),
        )
        if insert_after:
            index = next((i for i, s in enumerate(new_steps) if s.id == insert_after), None)
            if index is None:
                raise ValidationError(f"Unknown insert_after_step_id: {insert_after}")
            # Cannot insert "into" a succeeded step's identity; append after it.
            if new_steps[index].status == StepStatus.SUCCEEDED:
                new_steps.insert(index + 1, step)
            else:
                new_steps.insert(index + 1, step)
        else:
            new_steps.append(step)

    remove_step_id = payload.get("remove_step_id")
    if remove_step_id is not None:
        remove_step_id = str(remove_step_id)
        target = next((s for s in new_steps if s.id == remove_step_id), None)
        if target is None:
            raise ValidationError("Step to remove not found")
        if target.status == StepStatus.SUCCEEDED:
            raise ValidationError("Cannot remove a succeeded step; supersede via new revision only")
        new_steps = [s for s in new_steps if s.id != remove_step_id]

    if not new_steps:
        raise ValidationError("Revised plan would be empty")

    revision_number = work.current_plan_revision + 1
    plan = PlanRevision(
        id=new_id("plan"),
        work_id=work.id,
        revision=revision_number,
        steps=new_steps,
        created_by=actor.id,
    )
    ctx.store.plans[ctx.store.plan_key(work.id, revision_number)] = plan
    work.current_plan_revision = revision_number
    if work.status == WorkStatus.REVIEW:
        assert_work_transition(work.status, WorkStatus.READY)
        work.status = WorkStatus.READY
    elif work.status == WorkStatus.RUNNING:
        assert_work_transition(work.status, WorkStatus.PAUSED)
        work.status = WorkStatus.PAUSED
        assert_work_transition(work.status, WorkStatus.READY)
        work.status = WorkStatus.READY
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="plan.revised",
        payload={"revision": revision_number},
    )
    return {
        "work_id": work.id,
        "plan_revision": revision_number,
        "plan_id": plan.id,
        "version": work.version,
        "status": work.status,
        "step_ids": [s.id for s in new_steps],
    }

