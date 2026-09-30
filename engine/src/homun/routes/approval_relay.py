"""Approval relay bindings: link a person to their messaging channel."""
from fastapi import APIRouter, Header

from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/approval-relay", tags=["approval-relay"])


@router.get("")
def list_relay(workspace_id: str,
               x_homun_actor_id: str | None = Header(default=None),
               x_homun_actor_name: str | None = Header(default=None)):
    from homun.application import approval_relay
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    return {"bindings": [{"person_id": person, **data}
                         for person, data in approval_relay.bindings(ctx).items()],
            "pending_codes": approval_relay.pending_codes(ctx)}


@router.post("/enroll")
def start_enroll(workspace_id: str,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    """Generate the pairing code the person sends from their channel."""
    from homun.application import approval_relay
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return approval_relay.start_enroll(ctx, actor)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.delete("/{person_id}")
def unbind(workspace_id: str, person_id: str,
           x_homun_actor_id: str | None = Header(default=None),
           x_homun_actor_name: str | None = Header(default=None)):
    from homun.application import approval_relay
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    if actor.kind == "person" and actor.id != person_id:
        raise _http_error(DomainError("Una persona può scollegare solo il proprio canale"))
    try:
        return {"person_id": person_id, "unbound": approval_relay.unbind(ctx, person_id)}
    except DomainError as exc:
        raise _http_error(exc) from exc
