"""Routine transport: honest automation endpoints (create, act, preview, list)."""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from homun.application import routines
from homun.context import get_context
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.routes.price_comparisons import request_context
from homun.domain.errors import DomainError

router = APIRouter(prefix="/v1/workspaces/{workspace_id}", tags=["routines"])


class RoutineCreateRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    name: str = Field(default="", max_length=80)
    cron: str = Field(min_length=9, max_length=120)
    cron_timezone: str = Field(default="Europe/Rome", max_length=60)
    conversation_id: str = Field(min_length=1, max_length=80)
    template: dict[str, Any]


class RoutineActionRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    expected_version: int = Field(ge=1)


@router.get("/routines")
def list_routines(workspace_id: str,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return routines.list_routines(ctx, actor)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/routines")
def create_routine(workspace_id: str, body: RoutineCreateRequest,
                   x_homun_actor_id: str | None = Header(default=None),
                   x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return routines.create_routine(ctx, actor, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/routines/{routine_id}/pause")
def pause_routine(workspace_id: str, routine_id: str, body: RoutineActionRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    return _action(workspace_id, routine_id, "pause", body, x_homun_actor_id, x_homun_actor_name)


@router.post("/routines/{routine_id}/resume")
def resume_routine(workspace_id: str, routine_id: str, body: RoutineActionRequest,
                   x_homun_actor_id: str | None = Header(default=None),
                   x_homun_actor_name: str | None = Header(default=None)):
    return _action(workspace_id, routine_id, "resume", body, x_homun_actor_id, x_homun_actor_name)


@router.post("/routines/{routine_id}/stop")
def stop_routine(workspace_id: str, routine_id: str, body: RoutineActionRequest,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    return _action(workspace_id, routine_id, "stop", body, x_homun_actor_id, x_homun_actor_name)


def _action(workspace_id: str, routine_id: str, action: str, body: RoutineActionRequest,
            actor_id: str | None, actor_name: str | None):
    ctx, actor = request_context(workspace_id, actor_id, actor_name)
    payload = body.model_dump()
    payload["routine_id"] = routine_id
    try:
        return routines.routine_action(ctx, actor, action, payload)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get("/routines/preview")
def preview_cron(workspace_id: str, cron: str, tz: str = "Europe/Rome"):
    """Next three occurrences of a cron in its timezone; invalid cron is a 400."""
    from dbos._scheduler import croniter
    from zoneinfo import ZoneInfo
    from datetime import datetime
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    try:
        zone = ZoneInfo(tz)
        iterator = croniter(cron, datetime.now(zone), second_at_beginning=True)
        upcoming = [iterator.get_next(datetime).isoformat() for _ in range(3)]
    except Exception:
        raise HTTPException(
            status_code=400,
            detail={"code": "validation_error", "message": "cron o fuso non validi"},
        ) from None
    return {"cron": cron, "timezone": tz, "next": upcoming}
