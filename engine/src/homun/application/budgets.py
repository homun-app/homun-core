"""Per-work model budget: atomic reservation before the call, honest reconciliation.

Reservations commit before any provider call, so a crash can never spend past
the cap without a trace. Reconciliation moves a reservation to `spent` (known
usage) or `unknown` (call failed or usage unreported): unknown stays unknown,
never zero. Stale reservations from a crashed process are recovered at startup
and charged as unknown — conservative, because the call may have happened.
"""
from datetime import timedelta

from homun.domain.errors import BudgetExhaustedError, NotFoundError
from homun.domain.ids import new_id
from homun.domain.models import (BudgetCaps, BudgetCounters, BudgetReservation,
                                 WorkBudget, utc_now)
from homun.policy.work import require_work_access

PENDING_TTL = timedelta(minutes=15)


def ensure(store, work_id, *, caps=None) -> WorkBudget:
    budget = store.work_budgets.get(work_id)
    if budget is None:
        budget = WorkBudget(id=new_id('budget'), workspace_id=store.workspace_id,
                            work_id=work_id, caps=caps or BudgetCaps())
        store.work_budgets[work_id] = budget
    return budget


def _charged(budget) -> BudgetCounters:
    """Everything the cap must account for: reconciled plus in-flight."""
    return BudgetCounters(
        attempts=budget.spent.attempts + budget.reserved.attempts + budget.unknown.attempts,
        input_tokens=budget.spent.input_tokens + budget.reserved.input_tokens + budget.unknown.input_tokens,
        output_tokens=budget.spent.output_tokens + budget.reserved.output_tokens + budget.unknown.output_tokens,
    )


def _admit(budget, estimate: BudgetCounters):
    charged = _charged(budget)
    if (charged.attempts + estimate.attempts > budget.caps.model_attempts
            or _token_cap_exhausted(budget.caps.input_tokens, charged.input_tokens,
                                    estimate.input_tokens, estimate.attempts)
            or _token_cap_exhausted(budget.caps.output_tokens, charged.output_tokens,
                                    estimate.output_tokens, estimate.attempts)):
        raise BudgetExhaustedError('Work budget exhausted; raise it with work.set_budget')


def _token_cap_exhausted(cap, charged, estimated_tokens, attempts):
    # An unknown (zero) estimate cannot admit another call once a token cap
    # has already been reached. This is admission, not a per-call token bound:
    # providers may still report actual usage above a non-exhausted estimate.
    return cap is not None and (charged + estimated_tokens > cap
                                or (attempts > 0 and charged >= cap))


def _admit_allocation(budget, actor_id, estimate: BudgetCounters):
    """Delegate sub-cap: a delegate stops at its own limit inside the envelope."""
    allocation = budget.allocations.get(actor_id)
    if allocation is None:
        return
    charged_attempts = (allocation.spent.attempts + allocation.reserved.attempts
                        + allocation.unknown.attempts + estimate.attempts)
    if charged_attempts > allocation.model_attempts:
        raise BudgetExhaustedError(
            f'Delegate budget exhausted for {actor_id}; raise its allocation with work.set_budget')
    for cap, axis in ((allocation.input_tokens, 'input_tokens'), (allocation.output_tokens, 'output_tokens')):
        if cap is None:
            continue
        charged = (getattr(allocation.spent, axis) + getattr(allocation.reserved, axis)
                   + getattr(allocation.unknown, axis))
        if _token_cap_exhausted(cap, charged, getattr(estimate, axis), estimate.attempts):
            raise BudgetExhaustedError(
                f'Delegate budget exhausted for {actor_id}; raise its allocation with work.set_budget')


def _settle_allocation(budget, reservation: BudgetReservation, *, usage: BudgetCounters | None):
    """Move a reservation's counters inside the delegate allocation."""
    allocation = budget.allocations.get(reservation.actor_id)
    if allocation is None:
        return
    allocation.reserved = _diff(allocation.reserved, reservation.estimate)
    if usage is not None:
        allocation.spent = _sum(allocation.spent, usage)
    else:
        allocation.unknown = _sum(allocation.unknown, reservation.estimate)


def check_capacity(store, actor, work_id, estimate, *, accounting_actor_id=None):
    """Check a multi-call operation before starting it; each call still reserves.

    Caller must hold the repository transaction. This is admission against the
    current caps, not a guarantee against subsequent user budget changes.
    """
    require_work_access(store, actor, work_id)
    budget = ensure(store, work_id)
    _admit(budget, estimate)
    _admit_allocation(budget, accounting_actor_id or actor.id, estimate)
    return budget


def reserve(ctx, actor, work_id, estimate: BudgetCounters, *, purpose='', accounting_actor_id=None) -> str:
    """Authorize the caller; optionally charge the approved executor instead."""
    charged_actor_id = accounting_actor_id or actor.id
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            budget = check_capacity(store, actor, work_id, estimate, accounting_actor_id=charged_actor_id)
            reservation = BudgetReservation(id=new_id('res'), estimate=estimate,
                                            purpose=purpose, actor_id=charged_actor_id)
            budget.pending.append(reservation)
            budget.reserved = _sum(budget.reserved, estimate)
            allocation = budget.allocations.get(charged_actor_id)
            if allocation is not None:
                allocation.reserved = _sum(allocation.reserved, estimate)
            budget.version += 1
            budget.updated_at = utc_now()
            reservation_id = reservation.id
        ctx.service.store = store
    return reservation_id


def _find(budget, reservation_id) -> BudgetReservation:
    reservation = next((r for r in budget.pending if r.id == reservation_id), None)
    if reservation is None:
        raise NotFoundError('Budget reservation not found')
    return reservation


def reconcile(ctx, actor, work_id, reservation_id, *, usage: BudgetCounters | None = None,
              unknown_usage: BudgetCounters | None = None):
    """Charge reported counters; partial reports can also retain unknown counters.

    For partial usage, put the attempt in unknown_usage and only known token
    axes in usage, so the attempt is charged once and uncertainty stays visible.
    An entirely absent usage report still charges the reservation as unknown.
    """
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id)
            budget = ensure(store, work_id)
            reservation = _find(budget, reservation_id)
            budget.pending.remove(reservation)
            budget.reserved = _diff(budget.reserved, reservation.estimate)
            if usage is not None:
                budget.spent = _sum(budget.spent, usage)
            else:
                budget.unknown = _sum(budget.unknown, reservation.estimate)
            _settle_allocation(budget, reservation, usage=usage)
            if usage is not None and unknown_usage is not None:
                budget.unknown = _sum(budget.unknown, unknown_usage)
                allocation = budget.allocations.get(reservation.actor_id)
                if allocation is not None:
                    allocation.unknown = _sum(allocation.unknown, unknown_usage)
            budget.version += 1
            budget.updated_at = utc_now()
        ctx.service.store = store


def reconcile_unknown(ctx, actor, work_id, reservation_id):
    """Failed or unreported call: the estimate is charged as unknown usage."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id)
            budget = ensure(store, work_id)
            reservation = _find(budget, reservation_id)
            budget.pending.remove(reservation)
            budget.reserved = _diff(budget.reserved, reservation.estimate)
            budget.unknown = _sum(budget.unknown, reservation.estimate)
            _settle_allocation(budget, reservation, usage=None)
            budget.version += 1
            budget.updated_at = utc_now()
        ctx.service.store = store


def release(ctx, actor, work_id, reservation_id):
    """Cancellation before the call: the estimate returns to the envelope untouched."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id)
            budget = ensure(store, work_id)
            reservation = _find(budget, reservation_id)
            budget.pending.remove(reservation)
            budget.reserved = _diff(budget.reserved, reservation.estimate)
            allocation = budget.allocations.get(reservation.actor_id)
            if allocation is not None:
                allocation.reserved = _diff(allocation.reserved, reservation.estimate)
            budget.version += 1
            budget.updated_at = utc_now()
        ctx.service.store = store


def recover_pending(ctx, *, now=None) -> int:
    """Charge stale reservations from a crashed process as unknown usage."""
    moment = now or utc_now()
    recovered = 0
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for budget in store.work_budgets.values():
                stale = [r for r in budget.pending if moment - r.created_at > PENDING_TTL]
                if not stale:
                    continue
                for reservation in stale:
                    budget.pending.remove(reservation)
                    budget.reserved = _diff(budget.reserved, reservation.estimate)
                    budget.unknown = _sum(budget.unknown, reservation.estimate)
                    _settle_allocation(budget, reservation, usage=None)
                    recovered += 1
                budget.version += 1
                budget.updated_at = utc_now()
        ctx.service.store = store
    return recovered


def public(budget: WorkBudget) -> dict:
    return {
        'work_id': budget.work_id, 'version': budget.version, 'caps': budget.caps.model_dump(),
        'reserved': budget.reserved.model_dump(), 'spent': budget.spent.model_dump(),
        'unknown': budget.unknown.model_dump(), 'pending': len(budget.pending),
        'allocations': {actor_id: {
            'model_attempts': a.model_attempts, 'input_tokens': a.input_tokens,
            'output_tokens': a.output_tokens, 'spent': a.spent.model_dump(),
            'unknown': a.unknown.model_dump(), 'reserved': a.reserved.model_dump(),
        } for actor_id, a in budget.allocations.items()},
    }


def _sum(a: BudgetCounters, b: BudgetCounters) -> BudgetCounters:
    return BudgetCounters(attempts=a.attempts + b.attempts,
                          input_tokens=a.input_tokens + b.input_tokens,
                          output_tokens=a.output_tokens + b.output_tokens)


def _diff(a: BudgetCounters, b: BudgetCounters) -> BudgetCounters:
    return BudgetCounters(attempts=max(0, a.attempts - b.attempts),
                          input_tokens=max(0, a.input_tokens - b.input_tokens),
                          output_tokens=max(0, a.output_tokens - b.output_tokens))
