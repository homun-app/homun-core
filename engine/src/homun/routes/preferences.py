"""Workspace language preference transport.

PUT is called by the web client when the user changes language (best-effort:
a down engine never blocks the UI switch). The value drives only the texts
the engine generates by itself.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from homun.application.ops.preferences import get_language, set_language
from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error

router = APIRouter(prefix="/v1/workspaces/{workspace_id}", tags=["preferences"])


class LanguageRequest(BaseModel):
    language: str


def _require_workspace(workspace_id: str):
    ctx = get_context()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "not_found",
                "reason": "workspace.unknown",
                "message": "Unknown workspace",
            },
        )
    return ctx


@router.get("/language")
def read_language(workspace_id: str) -> dict[str, str]:
    return {"language": get_language(_require_workspace(workspace_id))}


@router.put("/language")
def write_language(workspace_id: str, body: LanguageRequest) -> dict[str, str]:
    ctx = _require_workspace(workspace_id)
    language = body.language.strip().lower()
    try:
        set_language(ctx, language)
    except DomainError as exc:
        raise _http_error(exc) from exc
    return {"language": language}
