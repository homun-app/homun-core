"""Authenticated approval of exact workspace file edits."""
from fastapi import APIRouter, Header
from pydantic import BaseModel, Field
from homun.application import workspace_file_edits
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}/works/{work_id}/file-edits', tags=['file-edits'])


class FileEdit(BaseModel):
    id: str
    work_id: str
    path: str
    operation: str
    status: str
    digest: str
    before_sha256: str | None = None
    after_sha256: str | None = None
    diff_preview: str | None = None
    diagnostics: dict | None = None
    strategy: str | None = None
    byte_size: int | None = None
    error_code: str | None = None
    error: str | None = None
    agent_run_id: str | None = None


class FileEditList(BaseModel):
    items: list[FileEdit]


class FileEditApproval(BaseModel):
    digest: str = Field(min_length=64, max_length=64)


def _call(operation, workspace_id, actor_id, actor_name, *args):
    ctx, actor = request_context(workspace_id, actor_id, actor_name)
    try:
        return operation(ctx, actor, *args)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('', response_model=FileEditList, response_model_exclude_none=True)
def list_edits(workspace_id: str, work_id: str,
               x_homun_actor_id: str | None = Header(default=None),
               x_homun_actor_name: str | None = Header(default=None)):
    return _call(workspace_file_edits.list_for_work, workspace_id, x_homun_actor_id, x_homun_actor_name, work_id)


@router.post('/{proposal_id}/approve', response_model=FileEdit, response_model_exclude_none=True)
def approve(workspace_id: str, work_id: str, proposal_id: str, body: FileEditApproval,
            x_homun_actor_id: str | None = Header(default=None),
            x_homun_actor_name: str | None = Header(default=None)):
    return _call(workspace_file_edits.approve, workspace_id, x_homun_actor_id, x_homun_actor_name,
                 work_id, proposal_id, body.model_dump())
