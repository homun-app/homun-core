"""Inviti persona e loro riscatto (F5.1)."""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from homun.domain.ids import new_id
from homun.domain.models import Actor, utc_now

INVITE_TTL_DAYS = 7
SESSION_TTL_DAYS = 30


def issue_person_invite(ctx, actor: Actor, body: dict[str, Any]) -> dict[str, Any]:
    """Invito monouso: token ``id.secret`` restituito una sola volta."""
    secret = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=INVITE_TTL_DAYS)).isoformat()
    command_id = f"invite:{new_id('pinv')}"
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, "person.invite", {
                "role": body.get("role") or "member",
                "note": body.get("note") or "",
                "expires_at": expires_at,
                "secret_hash": hashlib.sha256(secret.encode()).hexdigest(),
            })
        ctx.service.store = store
    return {**result, "token": f"{command_id}.{secret}",
            "expires_at": expires_at}


def _bootstrap_owner_if_empty(ctx, actor: Actor) -> None:
    store = ctx.repository.snapshot()
    if store.persons:
        return
    from homun.domain.ids import new_id
    with ctx.repository.locked():
        with ctx.repository.transaction() as write_store:
            ctx.service.for_store(write_store).apply(
                actor, f"bootstrap:{new_id('cmd')}", "person.bootstrap", {})
        ctx.service.store = write_store


def list_people(ctx, actor: Actor) -> dict[str, Any]:
    _bootstrap_owner_if_empty(ctx, actor)
    store = ctx.repository.snapshot()
    admin = store.persons.get(actor.id)
    if admin is None or admin.status != "active" or admin.role not in ("owner", "admin"):
        from homun.domain.errors import PermissionDeniedError
        raise PermissionDeniedError("Only an owner or admin can list people")
    people = []
    for person in sorted(store.persons.values(), key=lambda p: p.created_at):
        if person.status == "active" or True:  # i revocati restano visibili con stato esplicito
            people.append({
                "id": person.id, "display_name": person.display_name,
                "role": person.role, "status": person.status,
                "created_at": person.created_at.isoformat(),
                "devices": [
                    {"id": d.id, "name": d.name, "status": d.status,
                     "last_seen_at": d.last_seen_at.isoformat() if d.last_seen_at else None}
                    for d in sorted(store.person_devices.values(), key=lambda d: d.created_at)
                    if d.person_id == person.id
                ],
            })
    return {"items": people}


def list_invites(ctx, actor: Actor) -> dict[str, Any]:
    from homun.domain.commands.identity import PERSON_INVITE_KIND
    _bootstrap_owner_if_empty(ctx, actor)
    store = ctx.repository.snapshot()
    admin = store.persons.get(actor.id)
    if admin is None or admin.status != "active" or admin.role not in ("owner", "admin"):
        from homun.domain.errors import PermissionDeniedError
        raise PermissionDeniedError("Only an owner or admin can list invites")
    invites = []
    for record in store.commands.values():
        if record.type != PERSON_INVITE_KIND:
            continue
        result = record.result
        expired = bool(result.get("expires_at")) and datetime.fromisoformat(
            str(result["expires_at"])) <= datetime.now(timezone.utc)
        invites.append({
            "id": result["id"], "role": result.get("role"),
            "note": result.get("note"), "status": result.get("status"),
            "expired": expired,
            "expires_at": result.get("expires_at"),
            "person_id": result.get("person_id"),
        })
    return {"items": sorted(invites, key=lambda i: str(i["id"]))}


def revoke_invite(ctx, actor: Actor, invite_id: str) -> dict[str, Any]:
    from homun.domain.commands.identity import PERSON_INVITE_KIND
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            person = store.persons.get(actor.id)
            if person is None or person.status != "active" or person.role not in ("owner", "admin"):
                from homun.domain.errors import PermissionDeniedError
                raise PermissionDeniedError("Only an owner or admin can revoke invites")
            record = store.commands.get(invite_id)
            if record is None or record.type != PERSON_INVITE_KIND:
                from homun.domain.errors import NotFoundError
                raise NotFoundError("Invitation not found")
            record.result["status"] = "revoked"
        ctx.service.store = store
    return {"id": invite_id, "status": "revoked"}


def redeem_invite(ctx, token: str, body: dict[str, Any]) -> dict[str, Any]:
    """Riscatta l'invito: crea persona+dispositivo e apre la sessione."""
    from homun.domain.commands.identity import PERSON_INVITE_KIND
    from homun.identity.sessions import PersonSessionStore
    invite_id, _, secret = token.partition(".")
    display_name = str(body.get("display_name") or "").strip()[:120]
    device_name = str(body.get("device_name") or "").strip()[:120]
    person_id = new_id("person")
    device_id = new_id("pdev")
    command_id = f"confirm:{invite_id}"
    system_actor = Actor(id="homun_engine", workspace_id=ctx.workspace_id,
                         display_name="Homun", kind="agent")
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).apply(system_actor, command_id, "person.confirm", {
                "invite_id": invite_id,
                "secret": secret,
                "person_id": person_id,
                "display_name": display_name,
                "device_id": device_id,
                "device_name": device_name,
            })
        ctx.service.store = store
    store = ctx.repository.snapshot()
    person = store.persons[person_id]
    session_token = secrets.token_urlsafe(48)
    session_store = PersonSessionStore(ctx.repository.connection(), ctx.repository.lock)
    session = session_store.create(
        person_id=person.id, device_id=device_id, token=session_token,
        expires_delta_days=SESSION_TTL_DAYS)
    return {
        "person_id": person.id, "display_name": person.display_name,
        "role": person.role, "device_id": device_id,
        "session_token": session_token,
        "expires_at": session["expires_at"],
    }


def revoke_person(ctx, actor: Actor, person_id: str) -> dict[str, Any]:
    from homun.identity.sessions import PersonSessionStore
    command_id = f"prevoke:{new_id('cmd')}"
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).apply(actor, command_id, "person.revoke", {
                "person_id": person_id})
        ctx.service.store = store
    PersonSessionStore(ctx.repository.connection(), ctx.repository.lock).revoke_person(person_id)
    return {"person_id": person_id, "status": "revoked"}


def revoke_device(ctx, actor: Actor, device_id: str) -> dict[str, Any]:
    from homun.identity.sessions import PersonSessionStore
    command_id = f"drevoke:{new_id('cmd')}"
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).apply(actor, command_id, "device.revoke", {
                "device_id": device_id})
        ctx.service.store = store
    PersonSessionStore(ctx.repository.connection(), ctx.repository.lock).revoke_device(device_id)
    return {"device_id": device_id, "status": "revoked"}
