"""Language preference transport: the person first, the workspace as default.

The web client PUTs the language of the CURRENT session person when the user
changes language (best-effort: a down engine never blocks the UI switch).
The workspace language — the default for people without their own preference —
is reserved to workspace authority, checked with the existing identity
controls (require_owner_or_admin), never a hand-written check.
"""
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from homun.application.ops.preferences import (
    person_language,
    resolve_language,
    set_person_language,
    set_workspace_language,
    workspace_language,
)
from homun.context import get_context
from homun.domain.errors import DomainError, NotFoundError
from homun.i18n import DEFAULT_LANGUAGE
from homun.identity.invites import require_owner_or_admin
from homun.routes.domain_support import _actor_from_headers, _http_error

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


def _require_active_person(ctx, person_id: str):
    person = ctx.repository.snapshot().persons.get(person_id)
    if person is None or person.status != "active":
        raise NotFoundError(f"Unknown person: {person_id}",
                            reason="preferences.person_unknown")
    return person


@router.get("/language")
def read_workspace_language(workspace_id: str) -> dict[str, str]:
    return {"language": workspace_language(_require_workspace(workspace_id)) or DEFAULT_LANGUAGE}


@router.put("/language")
def write_workspace_language(workspace_id: str, body: LanguageRequest,
                             x_homun_actor_id: str | None = Header(default=None),
                             x_homun_actor_name: str | None = Header(default=None)) -> dict[str, str]:
    ctx = _require_workspace(workspace_id)
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    language = body.language.strip().lower()
    try:
        require_owner_or_admin(ctx, actor)
        set_workspace_language(ctx, language)
    except DomainError as exc:
        raise _http_error(exc) from exc
    return {"language": language}


@router.get("/people/{person_id}/language")
def read_person_language(workspace_id: str, person_id: str) -> dict[str, str]:
    ctx = _require_workspace(workspace_id)
    _require_active_person(ctx, person_id)
    return {"language": resolve_language(ctx, person_id=person_id)}


@router.put("/people/{person_id}/language")
def write_person_language(workspace_id: str, person_id: str, body: LanguageRequest,
                          x_homun_actor_id: str | None = Header(default=None),
                          x_homun_actor_name: str | None = Header(default=None)) -> dict[str, str]:
    ctx = _require_workspace(workspace_id)
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    language = body.language.strip().lower()
    try:
        # Own language for oneself; anyone else's needs workspace authority.
        # Either way the target person must exist and be active.
        _require_active_person(ctx, person_id)
        if actor.id != person_id:
            require_owner_or_admin(ctx, actor)
        set_person_language(ctx, person_id, language)
    except DomainError as exc:
        raise _http_error(exc) from exc
    return {"language": language}
