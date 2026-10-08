"""F5.1 — rotte identità: persone, inviti, riscatto sessione."""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
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
def redeem_session(body: RedeemRequest, request: Request):
    """Riscatta un invito persona: apre la sessione. Solo dal localhost:
    senza prova di possesso della chiave del dispositivo è il percorso di
    bootstrap locale; dalla rete si passa da /v1/remote/pair (2 passaggi)."""
    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "localhost", "testclient"}:
        raise HTTPException(403, detail={"code": "local_only",
                                         "message": "Il riscatto locale è consentito solo dal localhost: dalla rete usare il pairing remoto"})
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
    invite_token: str = Field(min_length=10, max_length=200)


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

@router.get("/workspaces/{workspace_id}/remote/events")
def remote_events(workspace_id: str, project_id: str, cursor: int = 0, limit: int = 200,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    """Feed replica per peer autorizzato: eventi del progetto dopo il cursor."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity.remote_feed import remote_events as _feed
    try:
        return _feed(ctx, actor, project_id=project_id, cursor=cursor, limit=limit)
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.get("/workspaces/{workspace_id}/remote/snapshot")
def remote_snapshot(workspace_id: str, project_id: str,
                    x_homun_actor_id: str | None = Header(default=None),
                    x_homun_actor_name: str | None = Header(default=None)):
    """Bootstrap del peer: proiezione corrente del progetto + cursor."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity.remote_feed import remote_snapshot as _snapshot
    try:
        return _snapshot(ctx, actor, project_id=project_id)
    except DomainError as exc:
        raise _http_error(exc) from exc

class RemoteCommandRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    type: str = Field(min_length=1, max_length=80)
    payload: dict = Field(default_factory=dict)


@router.post("/workspaces/{workspace_id}/remote/commands")
def remote_commands(workspace_id: str, body: RemoteCommandRequest,
                    x_homun_actor_id: str | None = Header(default=None),
                    x_homun_actor_name: str | None = Header(default=None)):
    """Comando dal peer: ricevuto ≠ accettato ≠ completato."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.identity.remote_commands import submit_remote_command
    try:
        return submit_remote_command(ctx, actor, body.model_dump())
    except DomainError as exc:
        raise _http_error(exc) from exc

@router.get("/workspaces/{workspace_id}/remote/assignments")
def remote_assignments(workspace_id: str,
                       x_homun_actor_id: str | None = Header(default=None),
                       x_homun_actor_name: str | None = Header(default=None)):
    """Le deleghe offerte alla persona autenticata."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.domain.commands.delegation import list_assignments_for
    return {"items": list_assignments_for(ctx, ctx.repository.snapshot(), actor.id)}


class AssignmentActionRequest(BaseModel):
    command_id: str = Field(min_length=1, max_length=160)
    result: dict = Field(default_factory=dict)
    model_attempts_used: int | None = Field(default=None, ge=0)


@router.post("/workspaces/{workspace_id}/remote/assignments/{assignment_id}/accept")
def remote_assignment_accept(workspace_id: str, assignment_id: str,
                             x_homun_actor_id: str | None = Header(default=None),
                             x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    from homun.domain.ids import new_id
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                out = ctx.service.for_store(store).apply(
                    actor, f"racc:{new_id('cmd')}", "delegation.accept",
                    {"assignment_id": assignment_id})
            ctx.service.store = store
        return out
    except DomainError as exc:
        raise _http_error(exc) from exc


@router.post("/workspaces/{workspace_id}/remote/assignments/{assignment_id}/return")
def remote_assignment_return(workspace_id: str, assignment_id: str,
                             body: AssignmentActionRequest,
                             x_homun_actor_id: str | None = Header(default=None),
                             x_homun_actor_name: str | None = Header(default=None)):
    """Ritorno con ricevuta: idempotente sullo stesso risultato."""
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                out = ctx.service.for_store(store).apply(
                    actor, body.command_id, "delegation.return",
                    {"assignment_id": assignment_id, "result": body.result,
                     "model_attempts_used": body.model_attempts_used})
            ctx.service.store = store
        return out
    except DomainError as exc:
        raise _http_error(exc) from exc

@router.get("/peers/connections")
def peers_connections():
    """Le connessioni remote di QUESTA installazione (lato peer)."""
    ctx = get_context()
    from homun.peers.store import PeerConnections
    return {"items": PeerConnections(ctx.data_dir).list()}


@router.get("/peers/projections")
def peers_projections():
    """Le proiezioni remote sincronizzate (Fonte: motore remoto)."""
    ctx = get_context()
    from homun.peers.store import list_projections
    return {"items": list_projections(ctx.data_dir)}

class PeerConnectRequest(BaseModel):
    host: str = Field(min_length=8, max_length=200)
    invite_token: str = Field(min_length=10, max_length=200)
    display_name: str = Field(min_length=1, max_length=120)
    device_name: str = Field(default="", max_length=120)


class PeerSyncRequest(BaseModel):
    project_id: str = Field(min_length=4, max_length=80)


@router.post("/peers/connect")
def peers_connect(body: PeerConnectRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)):
    """Onboarding guidato: QUESTA installazione entra in uno spazio remoto
    riscattando l'invito con la chiave del proprio dispositivo."""
    request_context(get_context().workspace_id, x_homun_actor_id, x_homun_actor_name)
    ctx = get_context()
    from homun.peers import pair_with_host
    from homun.peers.store import PeerConnections, device_key_path
    try:
        connection = pair_with_host(body.host, body.invite_token, body.display_name,
                                    body.device_name or "Homun di questo Mac",
                                    device_key_path(ctx.data_dir))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, detail={"code": "remote_unavailable",
                                         "message": f"Pairing fallito: {exc}"}) from exc
    PeerConnections(ctx.data_dir).upsert(
        host=connection.host, workspace_id=connection.workspace_id,
        person_id=connection.person_id, device_id=connection.device_id,
        device_token=connection.device_token,
        key_fingerprint=connection.key_fingerprint, display_name=body.display_name)
    return {"host": connection.host, "workspace_id": connection.workspace_id,
            "person_id": connection.person_id, "device_id": connection.device_id,
            "key_fingerprint": connection.key_fingerprint}


@router.post("/peers/connections/{host_path:path}/sync")
def peers_sync(host_path: str, body: PeerSyncRequest,
               x_homun_actor_id: str | None = Header(default=None),
               x_homun_actor_name: str | None = Header(default=None)):
    """Sincronizza ORA la proiezione di un progetto condiviso."""
    request_context(get_context().workspace_id, x_homun_actor_id, x_homun_actor_name)
    ctx = get_context()
    from homun.peers import sync_remote_project
    from homun.peers.store import PeerConnections, peers_db_path
    connection = PeerConnections(ctx.data_dir).connection(host_path)
    if connection is None:
        raise HTTPException(404, detail={"code": "not_found",
                                         "message": "Unknown remote host"})
    try:
        view = sync_remote_project(connection, peers_db_path(ctx.data_dir),
                                   body.project_id)
    except Exception as exc:
        raise HTTPException(502, detail={"code": "remote_unavailable",
                                         "message": f"Sync fallito: {exc}"}) from exc
    return {"host": view["host"], "project": view["snapshot"].get("project"),
            "cursor": view["cursor"],
            "conversations": len(view["snapshot"].get("conversations", [])),
            "works": len(view["snapshot"].get("works", []))}

@router.get("/peers/projection")
def peers_projection(host: str, project_id: str):
    """Il contenuto letto della proiezione remota: conversazioni con messaggi
    e lavori del progetto condiviso, read-only (Fonte: motore remoto)."""
    pass
    ctx = get_context()
    from pathlib import Path as _Path
    from homun.peers.replication import RemoteProjection
    projection = RemoteProjection(_Path(ctx.data_dir) / "remote-peers.db",
                                  host, project_id)
    view = projection.view()
    if not view["snapshot"]:
        raise HTTPException(404, detail={"code": "not_found",
                                         "message": "Proiezione mai sincronizzata: prima 'sync'"})
    return view
