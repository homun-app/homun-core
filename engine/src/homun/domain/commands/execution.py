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
    # Mark first pending step running.
    first_step = None
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
    request = ContributionRequest(
        id=new_id("req"),
        work_id=work.id,
        step_id=step_id,
        to_actor_id=to_actor_id,
        need=need,
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
    request.status = "resolved"
    request.response_text = text
    request.response_material_ids = material_ids
    request.resolved_at = utc_now()
    # The contribution satisfied its phase: record it on the plan so the ladder
    # stays truthful, then tell the person what comes next.
    plan = ctx.current_plan(work)
    step = next((s for s in plan.steps if s.id == request.step_id), None) if plan else None
    if step is not None and step.status == StepStatus.RUNNING:
        step.status = StepStatus.SUCCEEDED
    pending_steps = [s for s in plan.steps if s.status == StepStatus.PENDING] if plan else []
    work.status = WorkStatus.READY
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="contribution.resolved",
        payload={"request_id": request.id, "material_ids": material_ids,
                 "step_id": request.step_id},
    )
    if step is not None and step.status == StepStatus.SUCCEEDED:
        from homun.domain.commands.conversations import append_engine_message
        if pending_steps:
            append_engine_message(
                ctx, actor=actor, command_id=f"{command_id}:phase",
                conversation_id=work.primary_conversation_id, author_id="homun_engine",
                text=(f"Fase «{step.title}» registrata. Prossima: «{pending_steps[0].title}»: "
                      "l'avvio è nel riepilogo del lavoro."),
                event_payload={"work_id": work.id, "next_step_id": pending_steps[0].id},
            )
        else:
            append_engine_message(
                ctx, actor=actor, command_id=f"{command_id}:phase",
                conversation_id=work.primary_conversation_id, author_id="homun_engine",
                text=(f"Fase «{step.title}» registrata: tutte le fasi hanno il loro input. "
                      "Consegna il risultato dal riepilogo del lavoro per la verifica finale."),
                event_payload={"work_id": work.id, "step_id": step.id},
            )
    result: dict[str, Any] = {
        "request_id": request.id,
        "status": work.status,
        "version": work.version,
        "material_ids": material_ids,
    }
    run = effects.current_run_for_work(ctx.store, work.id)
    if run is not None and run.contribution_request_id == request.id:
        material_ref = (
            str(payload.get("material_ref") or "").strip()
            or (material_ids[0] if material_ids else None)
        )
        effects.stage_intent(ctx.store, command_id, run, "contribution", {
            "step_id": request.step_id, "request_id": request.id,
            "note": text, "material_ref": material_ref,
        })
        run.status = "running"
        run.updated_at = utc_now()
        result["run_id"] = run.id
        result["run_status"] = run.status
        result["effect_status"] = run.effect_status
    return result

