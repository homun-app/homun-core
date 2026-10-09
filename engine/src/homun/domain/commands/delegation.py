"""F5.5/F5.6 — peer step delegation: offer, accept, unique return, budget link.

Return is idempotent per assignment: the same payload confirms the recorded
result (pilot gate «unique delegation result»), a different payload is an
explicit conflict. Expiry and revoke close the assignment without phantom
results and release the work-budget reservation; reassignment after timeout
requires reconcile of the previous attempt, never a blind retry.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from homun.domain.command_context import CommandContext
from homun.domain.ids import new_id
from homun.domain.models import Actor, PeerAssignment, utc_now
from homun.domain.peer_budget import (
    release_assignment,
    reserve_for_assignment,
    settle_assignment,
)

_OPEN = frozenset({"offered", "accepted"})
_TERMINAL = frozenset({"returned", "revoked", "expired", "failed"})


def _require_work_authority(ctx: CommandContext, actor: Actor, work_id: str) -> None:
    from homun.domain.errors import PermissionDeniedError
    work = ctx.store.works.get(work_id)
    if work is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Work not found")
    person = ctx.store.persons.get(actor.id)
    if person is None or person.status != "active" or person.role not in ("owner", "admin"):
        raise PermissionDeniedError("Only an owner or admin may delegate to a peer")


def _is_work_authority(ctx: CommandContext, actor: Actor, work_id: str) -> bool:
    work = ctx.store.works.get(work_id)
    if work is None:
        return False
    person = ctx.store.persons.get(actor.id)
    return bool(person and person.status == "active" and person.role in ("owner", "admin"))


def _alive(assignment: PeerAssignment) -> bool:
    if assignment.expires_at is None:
        return True
    try:
        return datetime.fromisoformat(str(assignment.expires_at)) > datetime.now(timezone.utc)
    except ValueError:
        return False


def _input_hash(input_ref: dict) -> str:
    return hashlib.sha256(json.dumps(input_ref, sort_keys=True).encode()).hexdigest()


def _open_same_input(store, *, work_id: str, input_hash: str) -> PeerAssignment | None:
    """Previous unresolved attempt for the same work input (if any)."""
    matches = [
        a for a in store.peer_assignments.values()
        if a.work_id == work_id and a.input_hash == input_hash and a.status in _OPEN
    ]
    if not matches:
        return None
    return min(matches, key=lambda a: a.created_at)


def assignment_view(assignment: PeerAssignment) -> dict[str, Any]:
    """Public shape for listing and post-timeout interrogation."""
    return {
        "id": assignment.id,
        "work_id": assignment.work_id,
        "capability": assignment.capability,
        "status": assignment.status,
        "input_ref": assignment.input_ref,
        "input_hash": assignment.input_hash,
        "expires_at": str(assignment.expires_at or ""),
        "model_attempts_reserved": assignment.model_attempts_reserved,
        "budget_reservation_id": assignment.budget_reservation_id,
        "result": assignment.result,
        "model_attempts_used": assignment.model_attempts_used,
    }


def _expire(ctx: CommandContext, actor: Actor, command_id: str,
            assignment: PeerAssignment) -> dict[str, Any]:
    """Close an expired offer inside the command transaction (no raise).

    Raising would roll back the status change and the budget release; return a
    committed expired result so the route can still answer 4xx to the peer.
    """
    assignment.status = "expired"
    assignment.updated_at = utc_now()
    release_assignment(ctx.store, assignment, reason="peer_assignment_expired")
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=2,
              event_type="delegation.expired",
              payload={"assignment_id": assignment.id})
    return {"assignment_id": assignment.id, "status": "expired"}


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
    attempts = int(payload.get("model_attempts_reserved") or 0)
    work_id = str(payload.get("work_id"))
    hashed = _input_hash(input_ref)
    previous = _open_same_input(ctx.store, work_id=work_id, input_hash=hashed)
    if previous is not None:
        from homun.domain.errors import ValidationError
        if _alive(previous):
            raise ValidationError(
                f"Previous assignment {previous.id} still open; "
                "reconcile after timeout before reassignment")
        raise ValidationError(
            f"Previous assignment {previous.id} timed out unresolved; "
            "call delegation.reconcile before reassignment")
    assignment = PeerAssignment(
        id=new_id("assign"), workspace_id=ctx.store.workspace_id,
        work_id=work_id, assignee_person_id=assignee,
        capability=capability,
        input_hash=hashed,
        input_ref=input_ref,
        model_attempts_reserved=attempts,
        issued_by=actor.id, expires_at=expires_at)
    # Reserve before publishing the assignment so exhaustion cannot leave an
    # orphan offer without a ledger hold (same transaction as the command).
    assignment.budget_reservation_id = reserve_for_assignment(
        ctx.store, actor, work_id=assignment.work_id,
        assignee_person_id=assignee, attempts=attempts,
        assignment_id=assignment.id)
    ctx.store.peer_assignments[assignment.id] = assignment
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=1,
              event_type="delegation.offered",
              payload={"work_id": assignment.work_id, "assignee": assignee,
                       "capability": capability, "input_hash": assignment.input_hash,
                       "budget_reservation_id": assignment.budget_reservation_id,
                       "model_attempts_reserved": attempts})
    return {"assignment_id": assignment.id, "status": assignment.status,
            "budget_reservation_id": assignment.budget_reservation_id}


def delegation_accept(ctx: CommandContext, actor: Actor, command_id: str,
                      payload: dict[str, Any]) -> dict[str, Any]:
    """Only the assignee, and only while the offer is alive."""
    from homun.domain.errors import PermissionDeniedError, ValidationError
    assignment = ctx.store.peer_assignments.get(str(payload.get("assignment_id") or ""))
    if assignment is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Assignment not found")
    if assignment.assignee_person_id != actor.id:
        raise PermissionDeniedError("Only the assignee may accept this delegation")
    if assignment.status == "accepted":
        return {"assignment_id": assignment.id, "status": "accepted"}  # idempotent
    if assignment.status != "offered":
        raise ValidationError(f"Assignment is {assignment.status}, not acceptable")
    if not _alive(assignment):
        return _expire(ctx, actor, command_id, assignment)
    assignment.status = "accepted"
    assignment.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=2,
              event_type="delegation.accepted", payload={"assignment_id": assignment.id})
    return {"assignment_id": assignment.id, "status": assignment.status}


def delegation_return(ctx: CommandContext, actor: Actor, command_id: str,
                      payload: dict[str, Any]) -> dict[str, Any]:
    """Return with receipt: same payload confirms, different payload conflicts."""
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
            # Duplicate identical return: receipt confirmed, no double charge.
            return {"assignment_id": assignment.id, "status": "returned",
                    "idempotent": True}
        raise ValidationError("Assignment already returned with a different result")
    if assignment.status not in ("accepted", "offered"):
        raise ValidationError(f"Assignment is {assignment.status}, not returnable")
    if not _alive(assignment):
        return _expire(ctx, actor, command_id, assignment)
    assignment.status = "returned"
    assignment.result = result
    assignment.model_attempts_used = int(used) if used is not None else None
    assignment.returned_at = utc_now()
    assignment.updated_at = utc_now()
    settle_assignment(
        ctx.store, work_id=assignment.work_id,
        reservation_id=assignment.budget_reservation_id,
        used_attempts=assignment.model_attempts_used,
        reason="peer_assignment_returned")
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
    release_assignment(ctx.store, assignment, reason="peer_assignment_revoked")
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=4,
              event_type="delegation.revoked", payload={"assignment_id": assignment.id})
    return {"assignment_id": assignment.id, "status": assignment.status}


def delegation_reconcile(ctx: CommandContext, actor: Actor, command_id: str,
                         payload: dict[str, Any]) -> dict[str, Any]:
    """After timeout: interrogate the previous attempt and free/settle its hold.

    Assignee or work authority may call this. Terminal rows are idempotent
    interrogation (previous status/result). Open rows still inside their TTL
    refuse so callers cannot short-circuit a live peer. Timed-out rows release
    the reservation, or settle known usage / late result when the peer reports
    them — never a blind second offer of the same input.
    """
    from homun.domain.errors import PermissionDeniedError, ValidationError
    assignment = ctx.store.peer_assignments.get(str(payload.get("assignment_id") or ""))
    if assignment is None:
        from homun.domain.errors import NotFoundError
        raise NotFoundError("Assignment not found")
    is_assignee = assignment.assignee_person_id == actor.id
    if not is_assignee and not _is_work_authority(ctx, actor, assignment.work_id):
        raise PermissionDeniedError(
            "Only the assignee or a work authority may reconcile this delegation")

    if assignment.status in _TERMINAL:
        return {"assignment_id": assignment.id, "status": assignment.status,
                "idempotent": True, "previous": assignment_view(assignment)}
    if assignment.status not in _OPEN:
        raise ValidationError(f"Assignment is {assignment.status}, not reconcilable")
    if _alive(assignment):
        raise ValidationError("Assignment still open; wait for timeout before reconcile")

    used = payload.get("model_attempts_used")
    result = payload.get("result") if isinstance(payload.get("result"), dict) else None
    assignment.updated_at = utc_now()

    if result is not None:
        # Late result after timeout: record once, charge known usage, no double offer.
        fingerprint = hashlib.sha256(
            json.dumps(result, sort_keys=True).encode()).hexdigest()
        assignment.status = "returned"
        assignment.result = result
        assignment.model_attempts_used = int(used) if used is not None else None
        assignment.returned_at = utc_now()
        settle_assignment(
            ctx.store, work_id=assignment.work_id,
            reservation_id=assignment.budget_reservation_id,
            used_attempts=assignment.model_attempts_used,
            reason="peer_assignment_timeout_reconcile")
        ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
                  aggregate_type="peer_assignment", aggregate_version=3,
                  event_type="delegation.reconciled",
                  payload={"assignment_id": assignment.id, "status": "returned",
                           "result_fingerprint": fingerprint,
                           "model_attempts_used": assignment.model_attempts_used})
        return {"assignment_id": assignment.id, "status": "returned",
                "reconciled": True, "previous": assignment_view(assignment)}

    assignment.status = "expired"
    if used is not None:
        settle_assignment(
            ctx.store, work_id=assignment.work_id,
            reservation_id=assignment.budget_reservation_id,
            used_attempts=int(used),
            reason="peer_assignment_timeout_reconcile")
    else:
        release_assignment(ctx.store, assignment,
                           reason="peer_assignment_timeout_reconcile")
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=assignment.id,
              aggregate_type="peer_assignment", aggregate_version=2,
              event_type="delegation.reconciled",
              payload={"assignment_id": assignment.id, "status": "expired",
                       "model_attempts_used": int(used) if used is not None else None})
    return {"assignment_id": assignment.id, "status": "expired",
            "reconciled": True, "previous": assignment_view(assignment)}


def list_assignments_for(ctx, store, person_id: str) -> list[dict[str, Any]]:
    return [assignment_view(a)
            for a in sorted(store.peer_assignments.values(), key=lambda x: x.created_at)
            if a.assignee_person_id == person_id]


def get_assignment_for(store, *, assignment_id: str, person_id: str) -> dict[str, Any] | None:
    """Peer interrogation of one previous attempt (assignee only)."""
    assignment = store.peer_assignments.get(assignment_id)
    if assignment is None or assignment.assignee_person_id != person_id:
        return None
    return assignment_view(assignment)
