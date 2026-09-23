"""Typed transport for supervised model synthesis phases."""
from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from homun.application.synthesis import approve, list_proposals, propose
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['synthesis'])


class SynthesisRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    material_ids: list[str] = Field(default_factory=list, max_length=6)
    expected_version: int = Field(ge=1)
    language: str | None = Field(default=None, max_length=8)


class SynthesisApprovalRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    digest: str
    expected_version: int = Field(ge=1)


class SynthesisProposal(BaseModel):
    id: str
    status: str
    work_id: str
    expected_version: int
    digest: str
    tool_version: str
    materials: list[dict]
    assignee_id: str
    step_title: str
    limits: dict
    artifact_id: str | None = None
    error_code: str | None = None
    summary: dict | None = None


class SynthesisList(BaseModel):
    items: list[SynthesisProposal]


@router.post('/works/{work_id}/syntheses', response_model=SynthesisProposal, response_model_exclude_none=True)
def create_synthesis(workspace_id: str, work_id: str, body: SynthesisRequest,
                     x_homun_actor_id: str | None = Header(default=None),
                     x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return propose(ctx, actor, work_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/works/{work_id}/syntheses', response_model=SynthesisList, response_model_exclude_none=True)
def get_syntheses(workspace_id: str, work_id: str,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return list_proposals(ctx, actor, work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('/works/{work_id}/syntheses/{proposal_id}/approve', response_model=SynthesisProposal, response_model_exclude_none=True)
def approve_synthesis(workspace_id: str, work_id: str, proposal_id: str, body: SynthesisApprovalRequest,
                      x_homun_actor_id: str | None = Header(default=None),
                      x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return approve(ctx, actor, work_id, proposal_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc
