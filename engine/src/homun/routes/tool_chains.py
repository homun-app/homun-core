"""Typed transport for approved tool chains."""
from typing import Any

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from homun.application.tool_chains import approve, list_chains, propose
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['tool-chains'])


class ChainStepRequest(BaseModel):
    capability: str
    material_id: str | None = None
    left_material_id: str | None = None
    right_material_id: str | None = None


class ChainRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    steps: list[ChainStepRequest] = Field(min_length=2, max_length=8)
    expected_version: int = Field(ge=1)


class ChainApprovalRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    digest: str
    expected_version: int = Field(ge=1)


class ChainProposal(BaseModel):
    id: str
    status: str
    work_id: str
    expected_version: int
    digest: str
    steps: list[dict[str, Any]]
    error_code: str | None = None


class ChainList(BaseModel):
    items: list[ChainProposal]


@router.post('/works/{work_id}/tool-chains', response_model=ChainProposal, response_model_exclude_none=True)
def create_chain(workspace_id: str, work_id: str, body: ChainRequest,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return propose(ctx, actor, work_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/works/{work_id}/tool-chains', response_model=ChainList, response_model_exclude_none=True)
def get_chains(workspace_id: str, work_id: str,
               x_homun_actor_id: str | None = Header(default=None),
               x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return list_chains(ctx, actor, work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('/works/{work_id}/tool-chains/{chain_id}/approve', response_model=ChainProposal, response_model_exclude_none=True)
def approve_chain(workspace_id: str, work_id: str, chain_id: str, body: ChainApprovalRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return approve(ctx, actor, work_id, chain_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc
