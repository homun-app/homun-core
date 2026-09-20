"""Typed transport for approved local CSV comparisons."""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from homun.application.price_comparisons import approve, list_proposals, propose
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.price_comparison_models import ComparisonProposal, ComparisonList
from homun.routes.domain_support import _actor_from_headers, _http_error

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['price-comparisons'])


class ProposalRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    left_material_id: str
    right_material_id: str
    expected_version: int = Field(ge=1)
    max_rows: int = Field(default=10000, ge=1, le=10000)


class ApprovalRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    digest: str
    expected_version: int = Field(ge=1)


def request_context(workspace_id, actor_id, actor_name):
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(404, detail={'code': 'not_found', 'message': 'Unknown workspace'})
    return ctx, _actor_from_headers(workspace_id, actor_id, actor_name)


@router.post('/works/{work_id}/price-comparisons', response_model=ComparisonProposal, response_model_exclude_none=True)
def create_proposal(workspace_id: str, work_id: str, body: ProposalRequest,
                    x_homun_actor_id: str | None = Header(default=None),
                    x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return propose(ctx, actor, work_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/works/{work_id}/price-comparisons', response_model=ComparisonList, response_model_exclude_none=True)
def get_proposals(workspace_id: str, work_id: str,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return list_proposals(ctx, actor, work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('/works/{work_id}/price-comparisons/{proposal_id}/approve', response_model=ComparisonProposal, response_model_exclude_none=True)
def approve_proposal(workspace_id: str, work_id: str, proposal_id: str, body: ApprovalRequest,
                     x_homun_actor_id: str | None = Header(default=None),
                     x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return approve(ctx, actor, work_id, proposal_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc
