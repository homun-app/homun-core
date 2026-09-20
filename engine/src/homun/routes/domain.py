"""Domain HTTP API — commands, reads, events (F2)."""

from __future__ import annotations

from typing import Any
from homun.storage.errors import StorageError

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from homun.application.command_types import CommandRequest, CommandResponse
from homun.application.command_delivery import admit, complete
from homun.application.followup_views import conversation_followups

from homun.context import get_context
from homun.domain.errors import (
    ConflictError,
    DomainError,
    InvalidTransitionError,
    NotFoundError,
    PermissionDeniedError,
    ValidationError,
)
from homun.policy import (
    has_project_capability,
    list_readable_project_ids,
    require_project_capability,
)
from homun.policy.grants import can_read_grant
from homun.routes.sse import sse_event
from homun.routes.errors import storage_error_payload
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.routes.materials import router as materials_router
from homun.routes.reads import router as reads_router

router = APIRouter(prefix="/v1/workspaces/{workspace_id}", tags=["domain"])
router.include_router(materials_router)
router.include_router(reads_router)


@router.post("/commands", response_model=CommandResponse)
def post_command(
    workspace_id: str,
    body: CommandRequest,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> CommandResponse:
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Workspace not hosted on this node"},
        )
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        delivery = admit(ctx, actor, body)
        result = complete(ctx, delivery)
    except (ValidationError, InvalidTransitionError, ConflictError, PermissionDeniedError, NotFoundError) as exc:
        raise _http_error(exc) from exc
    except DomainError as exc:
        raise _http_error(exc) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "provider_unavailable", "message": str(exc)},
        ) from exc
    return CommandResponse(command_id=body.command_id, type=body.type, result=result)


@router.post("/commands/stream")
def post_command_stream(
    workspace_id: str,
    body: CommandRequest,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> StreamingResponse:
    """SSE stream for post_message: phase → tokens → result (F3.5 slice C)."""
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Workspace not hosted on this node"},
        )
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)

    def generate():
        yield sse_event("phase", {"phase": "accepted", "command_id": body.command_id})
        try:
            delivery = admit(ctx, actor, body)
            # Do not suspend the generator with a claimed model attempt. A
            # disconnect must not strand it before generation/commit begins.
            result = complete(ctx, delivery)
            yield sse_event("phase", {"phase": "persisted"})
            # This is presentation streaming of an already committed response.
            # Disconnection cannot discard the assistant result.
            display = str(result.get("assistant_text") or "")
            if display:
                yield sse_event("phase", {"phase": "streaming", "source": "modelport"})
                for token in ctx.models.stream_known_text(display):
                    yield sse_event("token", {"text": token, "source": "modelport"})
            payload = CommandResponse(
                command_id=body.command_id,
                type=body.type,
                result=result,
            ).model_dump(mode="json")
            yield sse_event("result", payload)
        except (ValidationError, InvalidTransitionError, ConflictError, PermissionDeniedError, NotFoundError) as exc:
            yield sse_event("error", {"code": exc.code, "message": exc.message})
        except DomainError as exc:
            yield sse_event("error", {"code": exc.code, "message": exc.message})
        except StorageError:
            yield sse_event("error", storage_error_payload())
        except RuntimeError as exc:
            yield sse_event("error", {"code": "provider_unavailable", "message": str(exc)})
        except Exception as exc:  # noqa: BLE001
            yield sse_event("error", {"code": "stream_error", "message": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/conversations")
def list_conversations(
    workspace_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    items = []
    for conversation in sorted(ctx.service.store.conversations.values(), key=lambda c: c.created_at):
        if conversation.project_id and not has_project_capability(ctx.service.store, actor.id, conversation.project_id, 'read'):
            continue
        payload = conversation.model_dump(mode='json')
        payload['followups'] = conversation_followups(ctx.service.store, conversation.id, actor)
        items.append(payload)
    return {"items": items}


@router.get("/agents")
def list_agents(workspace_id: str) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    items = [a.model_dump(mode="json") for a in ctx.service.store.agents.values()]
    return {"items": items}


@router.get("/agents/{agent_id}")
def get_agent(workspace_id: str, agent_id: str) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    try:
        agent = ctx.service.get_agent(agent_id)
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    return agent.model_dump(mode="json")


@router.get("/projects")
def list_projects(
    workspace_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    readable = list_readable_project_ids(ctx.service.store, actor.id)
    items = [
        p.model_dump(mode="json")
        for p in ctx.service.store.projects.values()
        if p.id in readable
    ]
    return {"items": items}


@router.get("/projects/{project_id}")
def get_project(
    workspace_id: str,
    project_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        require_project_capability(ctx.service.store, actor, project_id, "read")
        project = ctx.service.get_project(project_id)
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    except PermissionDeniedError as exc:
        raise _http_error(exc) from exc
    return project.model_dump(mode="json")


@router.get("/grants")
def list_grants(
    workspace_id: str,
    project_id: str | None = Query(default=None),
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    """List grants: admins see project grants; anyone sees their own grants."""
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    items = []
    for grant in ctx.service.store.grants.values():
        if project_id is not None and grant.resource_id != project_id:
            continue
        if can_read_grant(ctx.service.store, actor, grant):
            items.append(grant.model_dump(mode="json"))
    return {"items": items}


@router.get("/teams")
def list_teams(workspace_id: str) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    items = [t.model_dump(mode="json") for t in ctx.service.store.teams.values()]
    return {"items": items}


@router.get("/teams/{team_id}")
def get_team(workspace_id: str, team_id: str) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    try:
        team = ctx.service.get_team(team_id)
    except NotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": str(exc)},
        ) from exc
    return team.model_dump(mode="json")
