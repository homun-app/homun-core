"""F5.1 — rotte identità: persone, inviti, riscatto sessione."""
from __future__ import annotations

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from homun.context import get_context
from homun.domain.errors import DomainError
from homun.routes.domain_support import _http_error
from homun.routes.price_comparisons import request_context

router = APIRouter(prefix="/v1", tags=["identity"])


class InviteRequest(BaseModel):
    command_id: str | None = None
    role: str = Field(default="member", pattern="^(admin|member)$")
    note: str = Field(default="", max_length=200)


class RedeemRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    display_name: str = Field(min_length=1, max_length=120)
    device_name: str = Field(default="", max_length=120)


@router.get("/workspaces/{workspace_id}/people")
def list_people(workspace_id: str,
                x_homun_actor_id: str | None = Header(default=None),
                x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity import list_people as _list
    try:
        return _list(ctx, actor)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/workspaces/{workspace_id}/people/invites")
def create_invite(workspace_id: str, body: InviteRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity import issue_person_invite
    try:
        return issue_person_invite(ctx, actor, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get("/workspaces/{workspace_id}/people/invites")
def list_invites(workspace_id: str,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity import list_invites as _list
    try:
        return _list(ctx, actor)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/workspaces/{workspace_id}/people/invites/{invite_id}/revoke")
def revoke_invite(workspace_id: str, invite_id: str,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity import revoke_invite as _revoke
    try:
        return _revoke(ctx, actor, invite_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/workspaces/{workspace_id}/people/{person_id}/revoke")
def revoke_person(workspace_id: str, person_id: str,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity import revoke_person as _revoke
    try:
        return _revoke(ctx, actor, person_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/workspaces/{workspace_id}/devices/{device_id}/revoke")
def revoke_device(workspace_id: str, device_id: str,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity import revoke_device as _revoke
    try:
        return _revoke(ctx, actor, device_id)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/session/redeem")
def redeem_session(body: RedeemRequest):
    """Riscatta un invito persona: apre la sessione. Senza sessione attiva:
    l'invito stesso è la prova, come il portale contributi."""
    ctx = get_context()
    from homun.identity import redeem_invite
    try:
        return redeem_invite(ctx, body.token, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc

class PairPresentRequest(BaseModel):
    invite_token: str = Field(min_length=10, max_length=200)
    display_name: str = Field(min_length=1, max_length=120)
    device_name: str = Field(default="", max_length=120)
    public_key: str = Field(min_length=40, max_length=400)
    protocol_version: int = Field(ge=1, le=99)


class PairConfirmRequest(BaseModel):
    pairing_id: str = Field(min_length=4, max_length=80)
    signature: str = Field(min_length=8, max_length=200)


@router.post("/remote/pair")
def remote_pair_present(body: PairPresentRequest):
    """Passo 1 del pairing remoto: presentazione con chiave pubblica."""
    ctx = get_context()
    from homun.identity.pairing import present_pairing
    try:
        return present_pairing(ctx, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/remote/pair/confirm")
def remote_pair_confirm(body: PairConfirmRequest):
    """Passo 2: firma della nonce → sessione di trasporto del dispositivo."""
    ctx = get_context()
    from homun.identity.pairing import confirm_pairing
    try:
        return confirm_pairing(ctx, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc
