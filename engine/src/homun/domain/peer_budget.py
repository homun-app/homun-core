"""Link peer assignments to the work budget ledger (F5.6).

Offer reserves attempts under the assignee's accounting identity; return settles
known usage; revoke/expiry release the hold so the envelope is not stuck.
"""
from __future__ import annotations

from homun.domain.budget_ops import ensure, reserve_in_store, settle_in_store
from homun.domain.models import BudgetCounters, PeerAssignment


def reserve_for_assignment(store, actor, *, work_id: str, assignee_person_id: str,
                           attempts: int, assignment_id: str) -> str | None:
    if attempts <= 0:
        return None
    return reserve_in_store(
        store, actor, work_id, BudgetCounters(attempts=attempts),
        purpose=f"peer_assignment:{assignment_id}",
        accounting_actor_id=assignee_person_id,
    )


def settle_assignment(store, *, work_id: str, reservation_id: str | None,
                      used_attempts: int | None = None, released: bool = False,
                      reason: str = ''):
    if not reservation_id:
        return None
    budget = ensure(store, work_id)
    if released:
        return settle_in_store(
            store, budget, reservation_id, released=True,
            reason=reason or 'peer_assignment_released')
    if used_attempts is None:
        return settle_in_store(
            store, budget, reservation_id,
            reason=reason or 'peer_assignment_unreported_usage')
    return settle_in_store(
        store, budget, reservation_id,
        usage=BudgetCounters(attempts=int(used_attempts)),
        reason=reason or 'peer_assignment_returned')


def release_assignment(store, assignment: PeerAssignment, *, reason: str = '') -> None:
    settle_assignment(
        store, work_id=assignment.work_id,
        reservation_id=assignment.budget_reservation_id,
        released=True, reason=reason or 'peer_assignment_released')
