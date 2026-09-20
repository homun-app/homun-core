"""Conversations domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import NotFoundError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, Conversation, Message, utc_now

from homun.domain.command_context import CommandContext


def _conversation_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    title = str(payload.get("title", "Nuova conversazione")).strip() or "Nuova conversazione"
    project_id = payload.get("project_id")
    if project_id is not None:
        project_id = str(project_id)
        if project_id not in ctx.store.projects:
            raise NotFoundError(f"Project not found: {project_id}")
    conversation = Conversation(
        id=new_id("conv"),
        workspace_id=ctx.store.workspace_id,
        title=title,
        project_id=project_id,
    )
    ctx.store.conversations[conversation.id] = conversation
    if project_id is not None:
        project = ctx.store.projects[project_id]
        project.conversation_ids.append(conversation.id)
        project.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=conversation.id,
        aggregate_type="conversation",
        aggregate_version=conversation.version,
        event_type="conversation.created",
        payload={"title": title, "project_id": project_id},
    )
    return {"conversation_id": conversation.id, "project_id": project_id}


def _conversation_post_message(
    ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    conversation_id = str(payload.get("conversation_id", ""))
    conversation = ctx.get_conversation(conversation_id)
    text = str(payload.get("text", "")).strip()
    if not text:
        raise ValidationError("Message text is required")
    message = Message(
        id=new_id("msg"),
        workspace_id=ctx.store.workspace_id,
        conversation_id=conversation.id,
        author_id=actor.id,
        text=text,
    )
    ctx.store.messages[message.id] = message
    conversation.version += 1
    conversation.updated_at = utc_now()
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=conversation.id,
        aggregate_type="conversation",
        aggregate_version=conversation.version,
        event_type="message.created",
        payload={"message_id": message.id},
    )
    return {"message_id": message.id, "conversation_version": conversation.version}


def append_engine_message(
    ctx: CommandContext,
    *,
    actor: Actor,
    command_id: str,
    conversation_id: str,
    author_id: str,
    text: str,
    event_type: str = "message.created",
    event_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append a message without LLM logic (used by interpret orchestration)."""
    conversation = ctx.get_conversation(conversation_id)
    body = text.strip()
    if not body:
        raise ValidationError("Message text is required")
    message = Message(
        id=new_id("msg"),
        workspace_id=ctx.store.workspace_id,
        conversation_id=conversation.id,
        author_id=author_id,
        text=body,
    )
    ctx.store.messages[message.id] = message
    conversation.version += 1
    conversation.updated_at = utc_now()
    payload = {"message_id": message.id}
    if event_payload:
        payload.update(event_payload)
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=conversation.id,
        aggregate_type="conversation",
        aggregate_version=conversation.version,
        event_type=event_type,
        payload=payload,
    )
    return {"message_id": message.id, "conversation_version": conversation.version}

