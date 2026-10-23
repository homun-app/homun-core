"""Typed transport for starting a confirmed work: one route, engine-chosen executor."""
from typing import Literal

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from homun.application.work import work_start
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['work-start'])


class WorkStartRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    mode: Literal['autonomous', 'guarded', 'supervised'] = 'guarded'
    material_ids: list[str] = Field(default_factory=list, max_length=12)
    language: str | None = Field(default=None, max_length=8)


class ExecutionApprovalRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    digest: str
    expected_version: int = Field(ge=1)


class ExecutionView(BaseModel):
    id: str
    kind: str
    status: str
    digest: str | None = None
    expected_version: int | None = None
    error_code: str | None = None
    material_ids: list[str] = Field(default_factory=list)
    auto_started: bool | None = None


class ExecutionArtifact(BaseModel):
    id: str
    version: int
    title: str
    content: str


class CurrentExecution(BaseModel):
    work_id: str
    work_status: str
    work_version: int
    agreement_status: str | None = None
    id: str | None = None
    kind: str | None = None
    status: str
    digest: str | None = None
    expected_version: int | None = None
    error_code: str | None = None
    material_ids: list[str] = Field(default_factory=list)
    artifact: ExecutionArtifact | None = None


@router.post('/works/{work_id}/start', response_model=ExecutionView, response_model_exclude_none=True)
def start_work(workspace_id: str, work_id: str, body: WorkStartRequest,
               x_homun_actor_id: str | None = Header(default=None),
               x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return work_start.start(ctx, actor, work_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('/works/{work_id}/executions/{execution_id}/approve', response_model=ExecutionView,
             response_model_exclude_none=True)
def approve_execution(workspace_id: str, work_id: str, execution_id: str, body: ExecutionApprovalRequest,
                      x_homun_actor_id: str | None = Header(default=None),
                      x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return work_start.approve(ctx, actor, work_id, execution_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/works/{work_id}/execution', response_model=CurrentExecution)
def current_execution(workspace_id: str, work_id: str,
                      x_homun_actor_id: str | None = Header(default=None),
                      x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return work_start.current(ctx, actor, work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc
