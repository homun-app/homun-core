"""External MCP server declarations and skills: person-approved, never silent."""
from __future__ import annotations
from typing import Any
from homun.domain.errors import ValidationError
from homun.domain.ids import new_id
from homun.domain.models import Actor, ExternalServer, Skill, utc_now
from homun.domain.command_context import CommandContext

SERVER_TRANSPORTS = {"stdio", "http"}
SKILL_STATUSES = {"staged", "approved", "archived"}


def _validate_server_payload(payload: dict[str, Any]) -> None:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValidationError("Server name is required")
    transport = str(payload.get("transport") or "stdio")
    if transport not in SERVER_TRANSPORTS:
        raise ValidationError("transport must be stdio or http")
    if transport == "stdio":
        if not str(payload.get("command") or "").strip():
            raise ValidationError("stdio servers need a command")
    else:
        url = str(payload.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValidationError("http servers need an http(s) url")
    env = payload.get("env") or {}
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ValidationError("env must be a string map")
    headers = payload.get("headers") or {}
    if not isinstance(headers, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in headers.items()):
        raise ValidationError("headers must be a string map")


def _external_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    _validate_server_payload(payload)
    server = ExternalServer(
        id=new_id("mcp"),
        workspace_id=ctx.store.workspace_id,
        name=str(payload["name"]).strip()[:80],
        transport=str(payload.get("transport") or "stdio"),
        command=str(payload.get("command") or "").strip(),
        args=[str(a) for a in (payload.get("args") or [])],
        env={str(k): str(v) for k, v in (payload.get("env") or {}).items()},
        url=str(payload.get("url") or "").strip(),
        headers={str(k): str(v) for k, v in (payload.get("headers") or {}).items()},
        tools_include=[str(t) for t in (payload.get("tools_include") or [])],
        tools_exclude=[str(t) for t in (payload.get("tools_exclude") or [])],
        status="enabled" if str(payload.get("status") or "enabled") == "enabled" else "disabled",
    )
    ctx.store.external_servers[server.id] = server
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=server.id,
              aggregate_type="external_server", aggregate_version=server.revision,
              event_type="external_server.created", payload={"name": server.name})
    return {"server_id": server.id, "status": server.status, "revision": server.revision}


def _external_update(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    server = ctx.store.external_servers.get(str(payload.get("server_id") or ""))
    if server is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("External server not found")
    ctx._require_expected_version(server.revision, payload.get("expected_version"))
    merged = {**server.model_dump(), **{k: v for k, v in payload.items()
              if k in ("name", "transport", "command", "args", "env", "url", "headers",
                       "tools_include", "tools_exclude", "status")}}
    _validate_server_payload(merged)
    for key in ("name", "transport", "command", "url", "status"):
        if key in payload:
            setattr(server, key, str(payload[key]).strip() if key != "transport" else str(payload[key]))
    if "name" in payload:
        server.name = str(payload["name"]).strip()[:80]
    for key in ("args", "tools_include", "tools_exclude"):
        if key in payload:
            setattr(server, key, [str(t) for t in (payload.get(key) or [])])
    for key in ("env", "headers"):
        if key in payload:
            setattr(server, key, {str(k): str(v) for k, v in (payload.get(key) or {}).items()})
    if str(payload.get("status") or server.status) not in ("enabled", "disabled"):
        raise ValidationError("status must be enabled or disabled")
    server.revision += 1
    server.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=server.id,
              aggregate_type="external_server", aggregate_version=server.revision,
              event_type="external_server.updated", payload={"name": server.name})
    return {"server_id": server.id, "status": server.status, "revision": server.revision}


def _external_remove(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    server = ctx.store.external_servers.get(str(payload.get("server_id") or ""))
    if server is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("External server not found")
    ctx._require_expected_version(server.revision, payload.get("expected_version"))
    del ctx.store.external_servers[server.id]
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=server.id,
              aggregate_type="external_server", aggregate_version=server.revision,
              event_type="external_server.removed", payload={"name": server.name})
    return {"server_id": server.id, "removed": True}


def _validate_skill_payload(payload: dict[str, Any]) -> str:
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValidationError("Skill name is required")
    description = str(payload.get("description") or "").strip()
    if len(description) > 60:
        raise ValidationError("Skill description must be at most 60 characters")
    return name


def _skill_create(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    name = _validate_skill_payload(payload)
    author_type = str(payload.get("author_type") or "person")
    if author_type not in ("person", "agent"):
        raise ValidationError("author_type must be person or agent")
    requested = str(payload.get("status") or "staged")
    # Staging invariant: an agent's write is never approved on arrival;
    # only the person can create an already-approved skill.
    status = "approved" if (requested == "approved" and author_type == "person") else "staged"
    skill = Skill(
        id=new_id("skill"),
        workspace_id=ctx.store.workspace_id,
        name=name[:80],
        description=str(payload.get("description") or "").strip()[:120],
        body=str(payload.get("body") or ""),
        tags=[str(t) for t in (payload.get("tags") or [])],
        status=status,
        author_type=author_type,
        author_id=str(payload.get("author_id") or actor.id),
    )
    ctx.store.skills[skill.id] = skill
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=skill.id,
              aggregate_type="skill", aggregate_version=skill.revision,
              event_type="skill.created", payload={"name": skill.name, "status": skill.status})
    return {"skill_id": skill.id, "status": skill.status, "revision": skill.revision}


def _skill_patch(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    skill = ctx.store.skills.get(str(payload.get("skill_id") or ""))
    if skill is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Skill not found")
    ctx._require_expected_version(skill.revision, payload.get("expected_version"))
    if skill.status == "archived":
        raise ValidationError("An archived skill cannot be edited")
    if "name" in payload or "description" in payload:
        _validate_skill_payload({"name": payload.get("name", skill.name),
                                 "description": payload.get("description", skill.description)})
    if "name" in payload:
        skill.name = str(payload["name"]).strip()[:80]
    if "description" in payload:
        skill.description = str(payload["description"]).strip()[:120]
    if "body" in payload:
        skill.body = str(payload["body"] or "")
    if "tags" in payload:
        skill.tags = [str(t) for t in (payload.get("tags") or [])]
    # An agent edit of an approved skill returns it to staging.
    if skill.status == "approved" and str(payload.get("author_type") or "person") == "agent":
        skill.status = "staged"
    skill.revision += 1
    skill.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=skill.id,
              aggregate_type="skill", aggregate_version=skill.revision,
              event_type="skill.patched", payload={"name": skill.name, "status": skill.status})
    return {"skill_id": skill.id, "status": skill.status, "revision": skill.revision}


def _skill_transition(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any], target: str) -> dict[str, Any]:
    skill = ctx.store.skills.get(str(payload.get("skill_id") or ""))
    if skill is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Skill not found")
    ctx._require_expected_version(skill.revision, payload.get("expected_version"))
    if skill.status == "archived":
        raise ValidationError("An archived skill cannot change status")
    skill.status = target
    skill.revision += 1
    skill.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=skill.id,
              aggregate_type="skill", aggregate_version=skill.revision,
              event_type=f"skill.{target}", payload={"name": skill.name})
    return {"skill_id": skill.id, "status": skill.status, "revision": skill.revision}


def _skill_approve(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _skill_transition(ctx, actor, command_id, payload, "approved")


def _skill_reject(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _skill_transition(ctx, actor, command_id, payload, "archived")


def _skill_archive(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _skill_transition(ctx, actor, command_id, payload, "archived")
