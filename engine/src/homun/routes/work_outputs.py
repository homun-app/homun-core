"""Download immutable work outputs with the same authenticated work authority."""
from urllib.parse import quote
from fastapi import APIRouter,Header
from fastapi.responses import Response
from pydantic import BaseModel
from homun.application import work_outputs
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router=APIRouter(prefix='/v1/workspaces/{workspace_id}/works/{work_id}/outputs',tags=['work-outputs'])


class OutputView(BaseModel):
    id: str
    work_id: str
    run_id: str
    filename: str
    source_path: str
    sha256: str
    byte_size: int
    created_at: str
    review_status: str


class OutputList(BaseModel):
    items: list[OutputView]


@router.get('',response_model=OutputList)
def list_outputs(workspace_id: str,work_id: str,
                 x_homun_actor_id: str | None=Header(default=None),
                 x_homun_actor_name: str | None=Header(default=None)):
    ctx,actor=request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    try:return work_outputs.list_for_work(ctx,actor,work_id)
    except DomainError as exc:raise _http_error(exc) from exc


@router.get('/{output_id}/download')
def download_output(workspace_id: str,work_id: str,output_id: str,
                    x_homun_actor_id: str | None=Header(default=None),
                    x_homun_actor_name: str | None=Header(default=None)):
    ctx,actor=request_context(workspace_id,x_homun_actor_id,x_homun_actor_name)
    try:metadata,data=work_outputs.download(ctx,actor,work_id,output_id)
    except DomainError as exc:raise _http_error(exc) from exc
    return Response(data,media_type='application/octet-stream',headers={
        'Content-Disposition':"attachment; filename*=UTF-8''"+quote(metadata['filename'],safe=''),
        'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','X-Homun-SHA256':metadata['sha256']})
