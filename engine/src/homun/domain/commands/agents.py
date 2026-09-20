"""Agents domain commands and validation."""

from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, AgentProfile, utc_now

AGENT_STATUSES = frozenset({"draft", "active", "paused", "retired"})

from homun.domain.command_context import CommandContext


def _validate_connection_id(ctx: CommandContext, connection_id: str | None) -> str | None:
    if connection_id is None:
        return None
    cid = str(connection_id).strip()
    if not cid:
        return None
    if ctx._known_connection_ids is not None:
        known = set(ctx._known_connection_ids())
        if cid not in known:
            raise ValidationError(f"Unknown model connection: {cid}")
    return cid


def _parse_agent_status(ctx: CommandContext, raw: Any, *, default: str = "active") -> str:
    if raw is None:
        return default
    status = str(raw).strip() or default
    if status not in AGENT_STATUSES:
        raise ValidationError(f"Invalid agent status: {status}")
    return status


def _agent_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValidationError("Agent name is required")
    connection_id = _validate_connection_id(ctx, payload.get("preferred_connection_id"))
    avatar_raw = payload.get("avatar")
    avatar = str(avatar_raw).strip() if avatar_raw is not None and str(avatar_raw).strip() else None
    agent = AgentProfile(
        id=new_id("agent"),
        workspace_id=ctx.store.workspace_id,
        name=name,
        role=str(payload.get("role", "") or ""),
        avatar=avatar,
        instructions=str(payload.get("instructions", "") or ""),
        preferred_connection_id=connection_id,
        status=_parse_agent_status(ctx, payload.get("status"), default="active"),
    )
    ctx.store.agents[agent.id] = agent
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=agent.id,
        aggregate_type="agent",
        aggregate_version=agent.revision,
        event_type="agent.created",
        payload={"name": agent.name, "status": agent.status},
    )
    return {
        "agent_id": agent.id,
        "revision": agent.revision,
        "name": agent.name,
        "status": agent.status,
    }


def _agent_rename(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    agent_id = str(payload.get("agent_id", ""))
    agent = ctx.get_agent(agent_id)
    ctx._require_expected_version(agent.revision, payload.get("expected_version"))
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValidationError("Agent name is required")
    agent.name = name
    agent.revision += 1
    agent.updated_at = utc_now()
    ctx.store.agents[agent.id] = agent
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=agent.id,
        aggregate_type="agent",
        aggregate_version=agent.revision,
        event_type="agent.renamed",
        payload={"name": agent.name},
    )
    return {"agent_id": agent.id, "revision": agent.revision, "name": agent.name}


def _agent_update(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    agent_id = str(payload.get("agent_id", ""))
    agent = ctx.get_agent(agent_id)
    ctx._require_expected_version(agent.revision, payload.get("expected_version"))
    if "role" in payload:
        agent.role = str(payload.get("role") or "")
    if "instructions" in payload:
        agent.instructions = str(payload.get("instructions") or "")
    if "avatar" in payload:
        avatar_raw = payload.get("avatar")
        agent.avatar = (
            str(avatar_raw).strip() if avatar_raw is not None and str(avatar_raw).strip() else None
        )
    if "preferred_connection_id" in payload:
        agent.preferred_connection_id = _validate_connection_id(ctx, 
            payload.get("preferred_connection_id")
        )
    if "status" in payload:
        agent.status = _parse_agent_status(ctx, payload.get("status"), default=agent.status)
    agent.revision += 1
    agent.updated_at = utc_now()
    ctx.store.agents[agent.id] = agent
    ctx._emit(
        actor=actor,
        command_id=command_id,
        aggregate_id=agent.id,
        aggregate_type="agent",
        aggregate_version=agent.revision,
        event_type="agent.updated",
        payload={
            "role": agent.role,
            "status": agent.status,
            "preferred_connection_id": agent.preferred_connection_id,
        },
    )
    return {
        "agent_id": agent.id,
        "revision": agent.revision,
        "name": agent.name,
        "role": agent.role,
        "instructions": agent.instructions,
        "preferred_connection_id": agent.preferred_connection_id,
        "status": agent.status,
        "avatar": agent.avatar,
    }

