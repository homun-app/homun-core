"""MCP server declarations and skills transport."""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1/workspaces/{workspace_id}", tags=["mcp", "skills"])


class ServerCreateRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=80)
    transport: str = Field(default="stdio", max_length=10)
    command: str = Field(default="", max_length=300)
    args: list[str] = Field(default_factory=list, max_length=32)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = Field(default="", max_length=500)
    headers: dict[str, str] = Field(default_factory=dict)
    tools_include: list[str] = Field(default_factory=list, max_length=64)
    tools_exclude: list[str] = Field(default_factory=list, max_length=64)


class ServerActionRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)


def _server_public(server) -> dict[str, Any]:
    return {
        "id": server.id, "name": server.name, "transport": server.transport,
        "command": server.command, "args": server.args, "url": server.url,
        "tools_include": server.tools_include, "tools_exclude": server.tools_exclude,
        "status": server.status, "revision": server.revision,
    }


@router.get("/mcp/servers")
def list_servers(workspace_id: str,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    store = ctx.repository.load()
    from homun.policy import require_workspace_actor
    require_workspace_actor(actor, store.workspace_id)
    return {"items": [_server_public(s) for s in
                      sorted(store.external_servers.values(), key=lambda s: s.created_at)]}


@router.post("/mcp/servers")
def create_server(workspace_id: str, body: ServerCreateRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.policy.work import require_work_command_authority
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                require_work_command_authority(store, actor, "external.create", {})
                service = ctx.service.for_store(store)
                result = service.apply(actor, body.command_id, "external.create", body.model_dump())
            ctx.service.store = store
        return result
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/mcp/servers/{server_id}/remove")
def remove_server(workspace_id: str, server_id: str, body: ServerActionRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    return _server_action(workspace_id, server_id, "remove", body, x_homun_actor_id, x_homun_actor_name)


def _server_action(workspace_id: str, server_id: str, action: str, body: ServerActionRequest,
                   actor_id: str | None, actor_name: str | None):
    ctx, actor = request_context(workspace_id, actor_id, actor_name)
    from homun.policy.work import require_work_command_authority
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                require_work_command_authority(store, actor, f"external.{action}", {})
                service = ctx.service.for_store(store)
                result = service.apply(actor, body.command_id, f"external.{action}", {
                    "server_id": server_id, "expected_version": body.expected_version,
                })
            ctx.service.store = store
        return result
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/mcp/servers/{server_id}/test")
def test_server(workspace_id: str, server_id: str,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    """Probe: initialize + tools/list. Discovers the real surface; executes nothing."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    store = ctx.repository.load()
    from homun.policy import require_workspace_actor
    require_workspace_actor(actor, store.workspace_id)
    server = store.external_servers.get(server_id)
    if server is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Server not found"})
    from homun.application.mcp_client import probe_server
    try:
        return probe_server(server)
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "mcp_probe_failed", "message": str(exc)[:300]},
        ) from exc


class SkillCreateRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="")
    body: str = Field(default="", max_length=20000)
    tags: list[str] = Field(default_factory=list, max_length=12)
    author_type: str = Field(default="person", max_length=10)
    status: str = Field(default="staged", max_length=10)


class SkillActionRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)


@router.get("/skills")
def list_skills(workspace_id: str,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    store = ctx.repository.load()
    from homun.policy import require_workspace_actor
    require_workspace_actor(actor, store.workspace_id)
    return {"items": [{
        "id": skill.id, "name": skill.name, "description": skill.description,
        "tags": skill.tags, "status": skill.status,
        "author_type": skill.author_type, "revision": skill.revision,
        "body": skill.body if include_body else None,
    } for skill in sorted(store.skills.values(), key=lambda s: s.created_at)
        for include_body in [True]]}


@router.post("/skills")
def create_skill(workspace_id: str, body: SkillCreateRequest,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.policy.work import require_work_command_authority
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                require_work_command_authority(store, actor, "skill.create", {})
                service = ctx.service.for_store(store)
                result = service.apply(actor, body.command_id, "skill.create", body.model_dump())
            ctx.service.store = store
        return result
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/skills/{skill_id}/approve")
def approve_skill(workspace_id: str, skill_id: str, body: SkillActionRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    return _skill_action(workspace_id, skill_id, "approve", body, x_homun_actor_id, x_homun_actor_name)


@router.post("/skills/{skill_id}/reject")
def reject_skill(workspace_id: str, skill_id: str, body: SkillActionRequest,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    return _skill_action(workspace_id, skill_id, "reject", body, x_homun_actor_id, x_homun_actor_name)


@router.post("/skills/{skill_id}/archive")
def archive_skill(workspace_id: str, skill_id: str, body: SkillActionRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    return _skill_action(workspace_id, skill_id, "archive", body, x_homun_actor_id, x_homun_actor_name)


def _skill_action(workspace_id: str, skill_id: str, action: str, body: SkillActionRequest,
                  actor_id: str | None, actor_name: str | None):
    ctx, actor = request_context(workspace_id, actor_id, actor_name)
    from homun.policy.work import require_work_command_authority
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                require_work_command_authority(store, actor, f"skill.{action}", {})
                service = ctx.service.for_store(store)
                result = service.apply(actor, body.command_id, f"skill.{action}", {
                    "skill_id": skill_id, "expected_version": body.expected_version,
                })
            ctx.service.store = store
        return result
    except DomainError as exc:
        raise _http_error(exc) from exc
