"""Agents domain commands and validation."""
from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, AgentProfile, utc_now

AGENT_STATUSES = frozenset({"draft", "active", "paused", "retired"})
AUTONOMY_MODES = frozenset({"supervised", "autonomous"})

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


def _parse_autonomy(raw: Any) -> str:
    if raw is None:
        return "supervised"
    mode = str(raw).strip() or "supervised"
    if mode not in AUTONOMY_MODES:
        raise ValidationError(f"Invalid autonomy mode: {mode}")
    return mode


def _parse_specializations(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError("specializations must be a list")
    items = []
    for item in raw:
        text = str(item).strip()
        if text and len(text) <= 200 and text not in items:
            items.append(text)
        if len(items) >= 12:
            break
    return items


def _parse_capabilities(raw: Any) -> list[str]:
    """Capability ids must exist in the registry; declarations grant nothing."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValidationError("capabilities must be a list")
    from homun.domain.capabilities import REGISTRY
    items = []
    for item in raw:
        text = str(item).strip()
        if not text:
            continue
        if text not in REGISTRY:
            raise ValidationError(f"Unknown capability: {text}")
        if text not in items:
            items.append(text)
        if len(items) >= 8:
            break
    return items


def _identity_from_payload(payload: dict[str, Any], agent: AgentProfile, *, create: bool) -> None:
    """Apply professional identity fields; absent keys leave existing values."""
    if create or "responsibility" in payload:
        agent.responsibility = str(payload.get("responsibility") or "").strip()[:500]
    if create or "specializations" in payload:
        agent.specializations = _parse_specializations(payload.get("specializations"))
    if create or "method" in payload:
        agent.method = str(payload.get("method") or "").strip()[:500]
    if create or "tone" in payload:
        agent.tone = str(payload.get("tone") or "").strip()[:120]
    if create or "autonomy_mode" in payload:
        agent.autonomy_mode = _parse_autonomy(payload.get("autonomy_mode"))
    if create or "capabilities" in payload:
        agent.capabilities = _parse_capabilities(payload.get("capabilities"))


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
    _identity_from_payload(payload, agent, create=True)
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
    _identity_from_payload(payload, agent, create=False)
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
        "responsibility": agent.responsibility,
        "specializations": agent.specializations,
        "method": agent.method,
        "tone": agent.tone,
        "autonomy_mode": agent.autonomy_mode,
    }
