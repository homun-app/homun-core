"""HTTP routes for MemoryPort (F3.5a slice A)."""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from homun.context import get_context
from homun.domain.errors import DomainError, NotFoundError, ValidationError
from homun.memory.types import MemoryNote

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/memories", tags=["memory"])


class AddMemoryRequest(BaseModel):
    text: str
    work_id: str | None = None
    project_id: str | None = None


class RectifyMemoryRequest(BaseModel):
    text: str


class MemoryListResponse(BaseModel):
    memories: list[MemoryNote] = Field(default_factory=list)


def _require_workspace(workspace_id: str) -> None:
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Unknown workspace"},
        )


def _actor_id(x_homun_actor_id: str | None) -> str:
    return (x_homun_actor_id or "person_local").strip() or "person_local"


def _http_error(exc: DomainError) -> HTTPException:
    status = {
        "validation_error": 400,
        "not_found": 404,
    }.get(exc.code, 400)
    return HTTPException(
        status_code=status,
        detail={"code": exc.code, "message": exc.message},
    )


@router.get("", response_model=MemoryListResponse)
def list_memories(
    workspace_id: str,
    work_id: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    include_deleted: bool = Query(default=False),
) -> MemoryListResponse:
    _require_workspace(workspace_id)
    ctx = get_context()
    notes = ctx.memory.list(
        work_id=work_id,
        project_id=project_id,
        include_deleted=include_deleted,
    )
    return MemoryListResponse(memories=notes)


@router.get("/recall", response_model=MemoryListResponse)
def recall_memories(
    workspace_id: str,
    q: str = Query(min_length=1),
    project_id: str | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=50),
) -> MemoryListResponse:
    _require_workspace(workspace_id)
    ctx = get_context()
    return MemoryListResponse(
        memories=ctx.memory.recall(q, project_id=project_id, limit=limit),
    )


@router.get("/export", response_model=MemoryListResponse)
def export_memories(
    workspace_id: str,
    project_id: str | None = Query(default=None),
) -> MemoryListResponse:
    _require_workspace(workspace_id)
    ctx = get_context()
    return MemoryListResponse(memories=ctx.memory.export(project_id=project_id))


@router.post("", response_model=MemoryNote)
def add_memory(
    workspace_id: str,
    body: AddMemoryRequest,
    x_homun_actor_id: str | None = Header(default=None),
) -> MemoryNote:
    _require_workspace(workspace_id)
    ctx = get_context()
    try:
        return ctx.memory.add_approved(
            text=body.text,
            actor_id=_actor_id(x_homun_actor_id),
            work_id=body.work_id,
            project_id=body.project_id,
        )
    except (ValidationError, NotFoundError) as exc:
        raise _http_error(exc) from exc


@router.post("/{memory_id}/rectify", response_model=MemoryNote)
def rectify_memory(
    workspace_id: str,
    memory_id: str,
    body: RectifyMemoryRequest,
    x_homun_actor_id: str | None = Header(default=None),
) -> MemoryNote:
    _require_workspace(workspace_id)
    ctx = get_context()
    try:
        return ctx.memory.rectify(
            memory_id,
            text=body.text,
            actor_id=_actor_id(x_homun_actor_id),
        )
    except (ValidationError, NotFoundError) as exc:
        raise _http_error(exc) from exc


@router.delete("/{memory_id}", response_model=MemoryNote)
def delete_memory(
    workspace_id: str,
    memory_id: str,
    x_homun_actor_id: str | None = Header(default=None),
) -> MemoryNote:
    _require_workspace(workspace_id)
    ctx = get_context()
    try:
        return ctx.memory.delete(memory_id, actor_id=_actor_id(x_homun_actor_id))
    except (ValidationError, NotFoundError) as exc:
        raise _http_error(exc) from exc
