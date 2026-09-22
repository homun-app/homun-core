"""Routine commands: the person creates, pauses, resumes and stops automations."""
from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, Routine, utc_now
from homun.domain.states import StepStatus
from homun.domain.command_context import CommandContext

ROUTINE_STATUSES = {"active", "paused", "stopped"}
WEEKDAY_CRON = {
    "lunedì": 1, "martedì": 2, "mercoledì": 3, "giovedì": 4,
    "venerdì": 5, "sabato": 6, "domenica": 0,
}


def validate_cron(cron: str) -> str:
    """Structural validation only; the croniter check lives in the runtime layer."""
    parts = cron.split()
    if len(parts) != 5:
        raise ValidationError("cron must have 5 fields (m h dom mon dow)")
    if not all(part and not part.startswith("/") for part in parts):
        raise ValidationError("cron fields must be plain cron tokens")
    return cron



def _validate_template(template: dict[str, Any], store) -> dict[str, Any]:
    title = str(template.get("title") or "").strip()
    objective = str(template.get("objective") or "").strip()
    if not title or not objective:
        raise ValidationError("Routine template needs title and objective")
    steps_raw = template.get("plan_steps")
    if not isinstance(steps_raw, list) or not steps_raw:
        raise ValidationError("Routine template needs at least one plan step")
    steps: list[dict[str, Any]] = []
    for item in steps_raw:
        if not isinstance(item, dict):
            raise ValidationError("Each plan step must be an object")
        assignee_id = str(item.get("assignee_id") or "").strip()
        step_title = str(item.get("title") or "").strip()
        if not step_title or not assignee_id or assignee_id not in store.agents:
            raise ValidationError("Each plan step needs a title and an active roster assignee")
        if store.agents[assignee_id].status != "active":
            raise ValidationError("Plan step assignee is not active")
        steps.append({
            "title": step_title,
            "assignee_id": assignee_id,
            "capability": str(item.get("capability") or "general"),
            "output_expected": str(item.get("output_expected") or ""),
        })
    return {"title": title, "objective": objective, "plan_steps": steps}


def _routine_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip() or "Routine"
    cron = validate_cron(str(payload.get("cron") or ""))
    cron_timezone = str(payload.get("cron_timezone") or "Europe/Rome")
    from zoneinfo import ZoneInfo
    try:
        ZoneInfo(cron_timezone)
    except Exception:
        raise ValidationError("unknown cron_timezone") from None
    conversation = ctx.get_conversation(str(payload.get("conversation_id") or ""))
    template = _validate_template(payload.get("template") or {}, ctx.store)
    routine = Routine(
        id=new_id("routine"),
        workspace_id=ctx.store.workspace_id,
        name=name[:80],
        cron=cron,
        cron_timezone=cron_timezone,
        conversation_id=conversation.id,
        template=template,
    )
    ctx.store.routines[routine.id] = routine
    ctx._emit(
        actor=actor, command_id=command_id, aggregate_id=routine.id,
        aggregate_type="routine", aggregate_version=routine.revision,
        event_type="routine.created",
        payload={"name": routine.name, "cron": routine.cron},
    )
    return {"routine_id": routine.id, "status": routine.status, "revision": routine.revision}


def _routine_transition(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any], target: str) -> dict[str, Any]:
    routine = ctx.store.routines.get(str(payload.get("routine_id") or ""))
    if routine is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Routine not found")
    ctx._require_expected_version(routine.revision, payload.get("expected_version"))
    allowed = {"active": {"paused", "stopped"}, "paused": {"active", "stopped"}, "stopped": set()}
    if target not in allowed.get(routine.status, set()):
        raise ValidationError(f"Cannot go from {routine.status} to {target}")
    routine.status = target
    routine.revision += 1
    routine.updated_at = utc_now()
    ctx._emit(
        actor=actor, command_id=command_id, aggregate_id=routine.id,
        aggregate_type="routine", aggregate_version=routine.revision,
        event_type=f"routine.{target}",
        payload={"name": routine.name},
    )
    return {"routine_id": routine.id, "status": routine.status, "revision": routine.revision}


def _routine_pause(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _routine_transition(ctx, actor, command_id, payload, "paused")


def _routine_resume(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _routine_transition(ctx, actor, command_id, payload, "active")


def _routine_stop(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _routine_transition(ctx, actor, command_id, payload, "stopped")
