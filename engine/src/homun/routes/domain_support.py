"""Shared actor parsing and typed error mapping for domain routes."""
from fastapi import HTTPException
from homun.domain.models import Actor
from homun.domain.errors import DomainError

def _actor_from_headers(
    workspace_id: str,
    actor_id: str | None,
    actor_name: str | None,
) -> Actor:
    if not actor_id:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "unauthorized",
                "message": "Missing X-Homun-Actor-Id header",
            },
        )
    return Actor(
        id=actor_id,
        workspace_id=workspace_id,
        display_name=actor_name or actor_id,
        kind="person",
    )


def _http_error(exc: DomainError) -> HTTPException:
    status = {
        "validation_error": 400,
        "invalid_transition": 400,
        "version_conflict": 409,
        "command_in_progress": 409,
        "budget_exhausted": 429,
        "permission_denied": 403,
        "not_found": 404,
    }.get(exc.code, 400)
    return HTTPException(
        status_code=status,
        detail={"code": exc.code, "message": exc.message},
    )


