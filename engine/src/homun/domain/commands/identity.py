"""F5.1 — comandi identità: persone dello spazio, dispositivi, revoca.

L'invito monouso vive come CommandRecord (kind PERSON_INVITE_KIND) con
secret hash, come gli inviti di contribuzione: stesso pattern, nessun
segreto in chiaro nel database. Il bootstrap dell'owner è implicito alla
prima operazione di un attore amministrativo, così gli id e le grant
esistenti (es. person_fabio) restano continui."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from homun.domain.command_context import CommandContext
from homun.domain.models import Actor, Person, PersonDevice, utc_now
from homun.domain.peer_budget import release_assignment

PERSON_ROLES = ("owner", "admin", "member")
PERSON_INVITE_KIND = "person.invite"


def ensure_person(ctx, actor: Actor, *, role: str = "owner") -> Person:
    """La persona dell'attore, creandola al primo uso (bootstrap owner).

    Gli AccessGrant esistenti usano subject_id = actor id: creare la Person
    con lo stesso id mantiene la continuità dei permessi."""
    person = ctx.store.persons.get(actor.id)
    if person is not None:
        if person.status == "revoked":
            from homun.domain.errors import PermissionDeniedError
            raise PermissionDeniedError("This person has been revoked")
        return person
    person = Person(id=actor.id, workspace_id=ctx.store.workspace_id,
                    display_name=actor.display_name or actor.id, role=role)
    ctx.store.persons[person.id] = person
    return person


def _require_space_admin(ctx, actor: Actor) -> Person:
    person = ensure_person(ctx, actor)
    if person.role not in ("owner", "admin"):
        from homun.domain.errors import PermissionDeniedError
        raise PermissionDeniedError("Only an owner or admin can manage people")
    return person


def _person_invite(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Registra l'intento d'invito; il secret è dell'application layer."""
    _require_space_admin(ctx, actor)
    role = str(payload.get("role") or "member").strip()
    if role not in PERSON_ROLES or role == "owner":
        from homun.domain.errors import ValidationError
        raise ValidationError("Invite role must be admin or member")
    note = str(payload.get("note") or "").strip()[:200]
    expires_at = str(payload.get("expires_at") or "")
    result = {"id": command_id, "kind": PERSON_INVITE_KIND, "role": role, "note": note,
              "status": "active", "issuer_id": actor.id, "expires_at": expires_at,
              "secret_hash": str(payload.get("secret_hash") or ""), "person_id": None}
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=command_id,
              aggregate_type="person_invite", aggregate_version=1,
              event_type="person.invited", payload={"role": role, "note": note})
    return result


def _person_confirm(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Riscatto dell'invito: crea la persona e il suo dispositivo."""
    invite_id = str(payload.get("invite_id") or "")
    record = ctx.store.commands.get(invite_id)
    from homun.domain.errors import ValidationError
    if record is None or record.type != PERSON_INVITE_KIND:
        raise ValidationError("Unknown invitation")
    import secrets as _secrets
    invite = record.result
    if not _secrets.compare_digest(
            str(invite.get("secret_hash") or ""),
            __import__("hashlib").sha256(str(payload.get("secret") or "").encode()).hexdigest()):
        raise ValidationError("Invalid invitation token")
    if invite.get("status") != "active" or invite.get("person_id"):
        raise ValidationError("Invitation already used or revoked")
    if invite.get("expires_at"):
        try:
            if datetime.fromisoformat(str(invite["expires_at"])) <= datetime.now(timezone.utc):
                raise ValidationError("Invitation expired")
        except ValueError:
            raise ValidationError("Invitation expired")
    person_id = str(payload.get("person_id") or "")
    display_name = str(payload.get("display_name") or "").strip()[:120]
    if not person_id or not display_name:
        raise ValidationError("Person id and display name are required")
    person = Person(id=person_id, workspace_id=ctx.store.workspace_id,
                    display_name=display_name, role=str(invite.get("role") or "member"))
    device = PersonDevice(id=str(payload.get("device_id") or person_id + ":dev1"),
                          workspace_id=ctx.store.workspace_id, person_id=person_id,
                          name=str(payload.get("device_name") or "")[:120],
                          key_fingerprint=str(payload.get("key_fingerprint") or "") or None)
    ctx.store.persons[person.id] = person
    ctx.store.person_devices[device.id] = device
    invite["person_id"] = person.id
    invite["device_id"] = device.id
    invite["status"] = "used"
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=person.id,
              aggregate_type="person", aggregate_version=1,
              event_type="person.confirmed", payload={"role": person.role, "device_id": device.id})
    return {"person_id": person.id, "device_id": device.id, "role": person.role}


def _person_revoke(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Revoca la persona: grant off, dispositivi off, sessioni off (registry)."""
    admin = _require_space_admin(ctx, actor)
    person_id = str(payload.get("person_id") or "")
    person = ctx.store.persons.get(person_id)
    from homun.domain.errors import NotFoundError, ValidationError
    if person is None:
        raise NotFoundError("Person not found")
    if person.id == admin.id:
        raise ValidationError("A person cannot revoke themselves")
    if person.role == "owner" and not any(
            p.role == "owner" and p.status == "active" and p.id != person.id
            for p in ctx.store.persons.values()):
        raise ValidationError("The last owner cannot be revoked")
    person.status = "revoked"
    person.updated_at = utc_now()
    for grant in ctx.store.grants.values():
        if grant.subject_id == person.id and grant.status == "active":
            grant.status = "revoked"
    for device in ctx.store.person_devices.values():
        if device.person_id == person.id:
            device.status = "revoked"
    # Close open delegations to the revoked person and release their budget holds.
    for assignment in ctx.store.peer_assignments.values():
        if assignment.assignee_person_id == person.id and assignment.status in ("offered", "accepted"):
            assignment.status = "revoked"
            assignment.updated_at = utc_now()
            release_assignment(ctx.store, assignment, reason="peer_assignment_assignee_revoked")
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=person.id,
              aggregate_type="person", aggregate_version=2,
              event_type="person.revoked", payload={"person_id": person.id})
    return {"person_id": person.id, "status": person.status}


def _device_revoke(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Revoca un solo dispositivo: la persona resta, le sue sessioni muoiono."""
    _require_space_admin(ctx, actor)
    device_id = str(payload.get("device_id") or "")
    device = ctx.store.person_devices.get(device_id)
    from homun.domain.errors import NotFoundError
    if device is None:
        raise NotFoundError("Device not found")
    device.status = "revoked"
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=device.id,
              aggregate_type="person_device", aggregate_version=2,
              event_type="person.device_revoked", payload={"device_id": device.id})
    return {"device_id": device.id, "status": device.status}

def _person_bootstrap(ctx: CommandContext, actor: Actor, command_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Crea la prima Person (owner) per l'attore amministrativo iniziale.

    Idempotente per costruzione: rifiuta se esiste già qualunque persona.
    Mantiene l'id dell'attore per la continuità degli AccessGrant esistenti."""
    if ctx.store.persons:
        from homun.domain.errors import ConflictError
        raise ConflictError("People already exist in this workspace")
    person = Person(id=actor.id, workspace_id=ctx.store.workspace_id,
                    display_name=actor.display_name or actor.id, role="owner")
    ctx.store.persons[person.id] = person
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=person.id,
              aggregate_type="person", aggregate_version=1,
              event_type="person.bootstrapped", payload={"role": "owner"})
    return {"person_id": person.id, "role": "owner"}
