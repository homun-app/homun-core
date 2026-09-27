"""Scoped HTTP entry point for repository-backed native conversation sessions."""
from fastapi import APIRouter, Header
from homun.application import session_runtime
from homun.application.session_contracts import SessionManageArguments
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix='/v1/workspaces/{workspace_id}/works/{work_id}/sessions', tags=['sessions'])


@router.get('')
def list_sessions(workspace_id: str, work_id: str, query: str | None = None,
                  include_archived: bool = False, x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return session_runtime.execute(ctx, actor, work_id, {
            'action': 'list', 'query': query, 'include_archived': include_archived})
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get('/{session_id}')
def get_session(workspace_id: str, work_id: str, session_id: str,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return session_runtime.get(ctx, actor, work_id, session_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post('')
def operate_session(workspace_id: str, work_id: str, body: SessionManageArguments,
                    x_homun_actor_id: str | None = Header(default=None),
                    x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return session_runtime.execute(ctx, actor, work_id, body.model_dump(exclude_none=True))
    except DomainError as exc:
        raise _http_error(exc) from exc
