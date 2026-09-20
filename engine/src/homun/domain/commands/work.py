"""Work domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.effects import cancel_work_intents
from homun.domain.models import Actor, Work, utc_now
from homun.domain.states import WorkStatus, assert_work_transition

from homun.domain.command_context import CommandContext


def _work_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    conversation_id = str(payload.get("conversation_id", ""))
    conversation = ctx.get_conversation(conversation_id)
    title = str(payload.get("title", "")).strip()
    objective = str(payload.get("objective", "")).strip()
    if not title or not objective:
        raise ValidationError("Work title and objective are required")
    owner_id = str(payload.get("owner_id", actor.id))
    reviewer_id = payload.get("reviewer_id")
    work = Work(
        id=new_id("work"),
        workspace_id=ctx.store.workspace_id,
        title=title,
        objective=objective,
        primary_conversation_id=conversation.id,
        conversation_ids=[conversation.id],
        project_id=conversation.project_id,
        requester_id=actor.id,
        owner_id=owner_id,
        reviewer_id=str(reviewer_id) if reviewer_id else None,
    )
    ctx.store.works[work.id] = work
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="work.created",
        payload={"conversation_id": conversation.id},
    )
    return {"work_id": work.id, "status": work.status, "version": work.version}


def _work_link_conversation(
    ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    conversation = ctx.get_conversation(str(payload.get("conversation_id", "")))
    if conversation.id not in work.conversation_ids:
        work.conversation_ids.append(conversation.id)
    work.version += 1
    work.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=work.id,
        aggregate_type="work",
        aggregate_version=work.version,
        event_type="work.conversation_linked",
        payload={"conversation_id": conversation.id},
    )
    return {"work_id": work.id, "conversation_ids": list(work.conversation_ids), "version": work.version}


def _work_pause(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    assert_work_transition(work.status, WorkStatus.PAUSED)
    work.status = WorkStatus.PAUSED
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
    return {"work_id": work.id, "status": work.status, "version": work.version}


def _work_cancel(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    work = ctx.get_work(str(payload.get("work_id", "")))
    ctx._require_expected_version(work.version, payload.get("expected_version"))
    assert_work_transition(work.status, WorkStatus.CANCELLED)
    work.status = WorkStatus.CANCELLED
    uncertain = cancel_work_intents(ctx.store, work.id)
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
    result = {"work_id": work.id, "status": work.status, "version": work.version}
    if uncertain:
        result["runtime_error"] = "runtime_cancellation_uncertain"
    return result

