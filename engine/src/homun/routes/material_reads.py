"""Typed transport for approved local material reads."""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from homun.application.material_reads import approve, list_proposals, propose
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}', tags=['material-reads'])


class ReadRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    material_id: str
    expected_version: int = Field(ge=1)


class ReadApprovalRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    digest: str
    expected_version: int = Field(ge=1)


class ReadProposal(BaseModel):
    id: str
    status: str
    work_id: str
    expected_version: int
    digest: str
    tool_version: str
    material: dict
    limits: dict
    artifact_id: str | None = None
    error_code: str | None = None
    extract: str | None = None


class ReadList(BaseModel):
    items: list[ReadProposal]


@router.post('/works/{work_id}/material-reads', response_model=ReadProposal, response_model_exclude_none=True)
def create_read(workspace_id: str, work_id: str, body: ReadRequest,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return propose(ctx, actor, work_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/works/{work_id}/material-reads', response_model=ReadList, response_model_exclude_none=True)
def get_reads(workspace_id: str, work_id: str,
              x_homun_actor_id: str | None = Header(default=None),
              x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return list_proposals(ctx, actor, work_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('/works/{work_id}/material-reads/{proposal_id}/approve', response_model=ReadProposal, response_model_exclude_none=True)
def approve_read(workspace_id: str, work_id: str, proposal_id: str, body: ReadApprovalRequest,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return approve(ctx, actor, work_id, proposal_id, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc
