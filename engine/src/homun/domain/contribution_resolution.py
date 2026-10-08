"""One canonical contribution resolution; expiration never satisfies a plan step."""
from typing import Any
from homun.domain import effects
from homun.domain.errors import ValidationError
from homun.domain.models import utc_now
from homun.domain.states import StepStatus, WorkStatus, assert_work_transition


def resolve_contribution(ctx, actor, command_id, request, payload, text, material_ids, *, resolution="answered"):
    work = ctx.get_work(request.work_id)
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    if request.status != "pending":
        raise ValidationError("Contribution already resolved")
    assert_work_transition(work.status, WorkStatus.READY)
    request.resolution = resolution
    request.status = "resolved"
    request.response_text = text
    request.response_material_ids = material_ids
    request.resolved_at = utc_now()
    # The contribution satisfied its phase: record it on the plan so the ladder
    # stays truthful, then tell the person what comes next.
    plan = ctx.current_plan(work)
    step = next((s for s in plan.steps if s.id == request.step_id), None) if plan else None
    if resolution == "answered" and step is not None and step.status == StepStatus.RUNNING:
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
        event_type="contribution.expired" if resolution == "expired" else "contribution.resolved",
        payload={"request_id": request.id, "material_ids": material_ids,
                 "step_id": request.step_id, "resolution": resolution},
    )
    if resolution == "answered" and step is not None and step.status == StepStatus.SUCCEEDED:
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
    if resolution == "answered" and run is not None and run.contribution_request_id == request.id:
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

