"""Execution domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import NotFoundError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, ContributionRequest, utc_now
from homun.domain.states import StepStatus, WorkStatus, assert_work_transition
from homun.policy import require_project_capability
from homun.domain import effects

from homun.domain.command_context import CommandContext


def _work_start(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    plan = ctx.current_plan(work)
    if plan is None:
        raise ValidationError("Cannot start work without a plan")
    assert_work_transition(work.status, WorkStatus.RUNNING)
    work.status = WorkStatus.RUNNING
    # A clarification can resume an already-running phase. Do not start its
    # successor until that phase has delivered and been reviewed.
    first_step = next((step for step in plan.steps if step.status == StepStatus.RUNNING), None)
    if first_step is None:
        for step in plan.steps:
            if step.status == StepStatus.PENDING:
                step.status = StepStatus.RUNNING
                first_step = step
                break
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="work.state_changed",
        payload={"status": work.status},
    )
    result: dict[str, Any] = {
        "work_id": work.id,
        "status": work.status,
        "version": work.version,
    }
    durable = bool(payload.get("durable", ctx._durable_runtime))
    if durable:
        if first_step is None:
            raise ValidationError("Durable start requires at least one pending plan step")
        if ctx._data_dir is None:
            raise ValidationError("Durable runtime requires engine data_dir")
        request = ContributionRequest(
            id=new_id("req"),
            work_id=work.id,
            step_id=first_step.id,
            to_actor_id=str(payload.get("to_actor_id") or work.requester_id or actor.id),
            need=str(payload.get("need") or f"Contributo richiesto per: {first_step.title}"),
        )
        ctx.store.contributions[request.id] = request
        assert_work_transition(work.status, WorkStatus.WAITING_INPUT)
        work.status = WorkStatus.WAITING_INPUT
        work.version += 1
        work.updated_at = utc_now()
        ctx._emit(
            actor=actor,
            command_id=command_id,
            aggregate_id=work.id,
            aggregate_type="work",
            aggregate_version=work.version,
            event_type="contribution.requested",
            payload={"request_id": request.id, "durable": True},
        )
        run = effects.prepare_run(
            ctx.store,
            command_id=command_id,
            work_id=work.id,
            step_id=first_step.id,
            contribution_request_id=request.id,
            effect_command_id=str(payload.get("effect_command_id") or f"fx_{command_id}"),
            crash_after_effect=bool(payload.get("crash_after_effect", False)),
        )
        result.update(
            {
                "status": work.status,
                "version": work.version,
                "run_id": run.id,
                "workflow_id": run.workflow_id,
                "request_id": request.id,
                "durable": True,
            }
        )
    return result


def _work_request_contribution(
    ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    assert_work_transition(work.status, WorkStatus.WAITING_INPUT)
    step_id = str(payload.get("step_id", ""))
    to_actor_id = str(payload.get("to_actor_id", ""))
    need = str(payload.get("need", "")).strip()
    if not step_id or not to_actor_id or not need:
        raise ValidationError("step_id, to_actor_id and need are required")
    from homun.domain.clarification import validate_form
    questions = validate_form(payload.get("questions"))
    request = ContributionRequest(
        id=new_id("req"),
        work_id=work.id,
        step_id=step_id,
        to_actor_id=to_actor_id,
        need=need,
        questions=questions,
    )
    ctx.store.contributions[request.id] = request
    work.status = WorkStatus.WAITING_INPUT
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="contribution.requested",
        payload={"request_id": request.id},
    )
    return {"request_id": request.id, "status": work.status, "version": work.version}


def _work_provide_contribution(
    ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    request_id = str(payload.get("request_id", ""))
    request = ctx.store.contributions.get(request_id)
    if request is None:
        raise NotFoundError(f"Contribution request not found: {request_id}")
    if request.to_actor_id != actor.id:
        raise ValidationError("Only the requested actor may provide this contribution")
    if request.status != "pending":
        raise ValidationError("Contribution already resolved")
    raw_ids = payload.get("material_ids") or []
    if not isinstance(raw_ids, list):
        raise ValidationError("material_ids must be a list")
    material_ids = [str(mid).strip() for mid in raw_ids if str(mid).strip()]
    text = str(payload.get("text", "")).strip()
    if not text and not material_ids:
        raise ValidationError("Contribution text or material_ids required")
    titles: list[str] = []
    for mid in material_ids:
        material = ctx.get_material(mid)
        require_project_capability(ctx.store, actor, material.project_id, "read")
        titles.append(material.title)
    if not text:
        text = f"Materials: {', '.join(titles)}"
    work = ctx.get_work(request.work_id)
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    assert_work_transition(work.status, WorkStatus.READY)
    if request.questions:
        from homun.domain.clarification import parse_answers
        parse_answers(request.questions, text)
    from homun.domain.contribution_resolution import resolve_contribution
    return resolve_contribution(ctx, actor, command_id, request, payload, text, material_ids)
