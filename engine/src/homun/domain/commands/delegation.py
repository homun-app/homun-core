"""F5.5/5.6 — delega di un passo a un peer: offerta, accettazione, ritorno unico.

Il ritorno è idempotente per assignment: lo stesso payload conferma il
risultato già registrato (il «risultato di delega unico» del gate pilot),
un payload diverso è un conflitto esplicito. Scadenza e revoca chiudono
l'assignment senza risultati fantasma; la riassegnazione dopo timeout
richiede una nuova offerta, mai un retry cieco."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from homun.domain.command_context import CommandContext
from homun.domain.ids import new_id
from homun.domain.models import Actor, PeerAssignment, utc_now


def _require_work_authority(ctx: CommandContext, actor: Actor, work_id: str) -> None:
    from homun.domain.errors import PermissionDeniedError
    work = ctx.store.works.get(work_id)
    if work is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Work not found")
    person = ctx.store.persons.get(actor.id)
    if person is None or person.status != "active" or person.role not in ("owner", "admin"):
        raise PermissionDeniedError("Only an owner or admin may delegate to a peer")


def _alive(assignment: PeerAssignment) -> bool:
    if assignment.expires_at is None:
        return True
    try:
        return datetime.fromisoformat(str(assignment.expires_at)) > datetime.now(timezone.utc)
    except ValueError:
        return False


def delegation_offer(ctx: CommandContext, actor: Actor, command_id: str,
                     payload: dict[str, Any]) -> dict[str, Any]:
    _require_work_authority(ctx, actor, str(payload.get("work_id") or ""))
    assignee = str(payload.get("assignee_person_id") or "")
    if assignee not in ctx.store.persons or ctx.store.persons[assignee].status != "active":
        from homun.domain.errors import ValidationError
        raise ValidationError("Assignee must be an active person of this space")
    capability = str(payload.get("capability") or "").strip()
    if not capability:
        from homun.domain.errors import ValidationError
        raise ValidationError("Delegated capability is required")
    input_ref = payload.get("input_ref") if isinstance(payload.get("input_ref"), dict) else {}
    expires_at = str(payload.get("expires_at") or "") or None
    assignment = PeerAssignment(
        id=new_id("assign"), workspace_id=ctx.store.workspace_id,
        work_id=str(payload.get("work_id")), assignee_person_id=assignee,
        capability=capability,
        input_hash=hashlib.sha256(
            json.dumps(input_ref, sort_keys=True).encode()).hexdigest(),
        input_ref=input_ref,
        model_attempts_reserved=int(payload.get("model_attempts_reserved") or 0),
        issued_by=actor.id, expires_at=expires_at)
    ctx.store.peer_assignments[assignment.id] = assignment
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=1,
              event_type="delegation.offered",
              payload={"work_id": assignment.work_id, "assignee": assignee,
                       "capability": capability, "input_hash": assignment.input_hash})
    return {"assignment_id": assignment.id, "status": assignment.status}


def delegation_accept(ctx: CommandContext, actor: Actor, command_id: str,
                      payload: dict[str, Any]) -> dict[str, Any]:
    """Solo l'assegnatario, solo finché l'offerta è viva."""
    from homun.domain.errors import PermissionDeniedError, ValidationError
    assignment = ctx.store.peer_assignments.get(str(payload.get("assignment_id") or ""))
    if assignment is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Assignment not found")
    if assignment.assignee_person_id != actor.id:
        raise PermissionDeniedError("Only the assignee may accept this delegation")
    if assignment.status == "accepted":
        return {"assignment_id": assignment.id, "status": "accepted"}  # idempotente
    if assignment.status != "offered":
        raise ValidationError(f"Assignment is {assignment.status}, not acceptable")
    if not _alive(assignment):
        assignment.status = "expired"
        assignment.updated_at = utc_now()
        raise ValidationError("Assignment expired")
    assignment.status = "accepted"
    assignment.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=2,
              event_type="delegation.accepted", payload={"assignment_id": assignment.id})
    return {"assignment_id": assignment.id, "status": assignment.status}


def delegation_return(ctx: CommandContext, actor: Actor, command_id: str,
                      payload: dict[str, Any]) -> dict[str, Any]:
    """Ritorno con ricevuta: stesso payload conferma, payload diverso confligge."""
    from homun.domain.errors import PermissionDeniedError, ValidationError
    assignment = ctx.store.peer_assignments.get(str(payload.get("assignment_id") or ""))
    if assignment is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Assignment not found")
    if assignment.assignee_person_id != actor.id:
        raise PermissionDeniedError("Only the assignee may return this delegation")
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    fingerprint = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    used = payload.get("model_attempts_used")

    if assignment.status == "returned":
        stored = hashlib.sha256(json.dumps(
            assignment.result or {}, sort_keys=True).encode()).hexdigest()
        if stored == fingerprint:
            # ritorno duplicato identico: ricevuta riconfermata, zero doppi
            return {"assignment_id": assignment.id, "status": "returned",
                    "idempotent": True}
        raise ValidationError("Assignment already returned with a different result")
    if assignment.status not in ("accepted", "offered"):
        raise ValidationError(f"Assignment is {assignment.status}, not returnable")
    if not _alive(assignment):
        assignment.status = "expired"
        assignment.updated_at = utc_now()
        raise ValidationError("Assignment expired")
    assignment.status = "returned"
    assignment.result = result
    assignment.model_attempts_used = int(used) if used is not None else None
    assignment.returned_at = utc_now()
    assignment.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=3,
              event_type="delegation.returned",
              payload={"assignment_id": assignment.id, "result_fingerprint": fingerprint,
                       "model_attempts_used": assignment.model_attempts_used})
    return {"assignment_id": assignment.id, "status": "returned", "idempotent": False}


def delegation_revoke(ctx: CommandContext, actor: Actor, command_id: str,
                      payload: dict[str, Any]) -> dict[str, Any]:
    _require_work_authority(ctx, actor, str(payload.get("work_id") or ""))
    assignment = ctx.store.peer_assignments.get(str(payload.get("assignment_id") or ""))
    if assignment is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Assignment not found")
    if assignment.status in ("returned", "revoked"):
        return {"assignment_id": assignment.id, "status": assignment.status}
    assignment.status = "revoked"
    assignment.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=4,
              event_type="delegation.revoked", payload={"assignment_id": assignment.id})
    return {"assignment_id": assignment.id, "status": assignment.status}


def list_assignments_for(ctx, store, person_id: str) -> list[dict[str, Any]]:
    return [{"id": a.id, "work_id": a.work_id, "capability": a.capability,
             "status": a.status, "input_ref": a.input_ref,
             "input_hash": a.input_hash, "expires_at": str(a.expires_at or ""),
             "model_attempts_reserved": a.model_attempts_reserved}
            for a in sorted(store.peer_assignments.values(), key=lambda x: x.created_at)
            if a.assignee_person_id == person_id]
