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


def reserve(ctx, actor, work_id, estimate: BudgetCounters, *, purpose='', accounting_actor_id=None,
            run_id=None, connection_id=None, provider_id=None, model_id=None) -> str:
    """Authorize the caller; optionally charge the approved executor instead."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            reservation_id = reserve_in_store(store, actor, work_id, estimate, purpose=purpose,
                accounting_actor_id=accounting_actor_id, run_id=run_id, connection_id=connection_id,
                provider_id=provider_id, model_id=model_id)
        ctx.service.store = store
    return reservation_id


def reserve_in_store(store, actor, work_id, estimate, *, purpose='', accounting_actor_id=None,
                     run_id=None, connection_id=None, provider_id=None, model_id=None):
    charged_actor_id = accounting_actor_id or actor.id
    budget = check_capacity(store, actor, work_id, estimate, accounting_actor_id=charged_actor_id)
    reservation = BudgetReservation(id=new_id('res'), estimate=estimate, purpose=purpose,
        actor_id=charged_actor_id, admitted_actor_id=actor.id, run_id=run_id,
        connection_id=connection_id, provider_id=provider_id, model_id=model_id)
    budget.pending.append(reservation)
    budget.reserved = _sum(budget.reserved, estimate)
    allocation = budget.allocations.get(charged_actor_id)
    if allocation is not None:
        allocation.reserved = _sum(allocation.reserved, estimate)
    budget.version += 1
    budget.updated_at = utc_now()
    return reservation.id


def _settle(ctx, actor, work_id, reservation_id, **kwargs):
    from homun.application import budget_settlement
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_work_access(store, actor, work_id)
            receipt = budget_settlement.settle_in_store(store, ensure(store, work_id), reservation_id, **kwargs)
        ctx.service.store = store
    return receipt



def settle_admitted(ctx, actor, work_id, reservation_id, **kwargs):
    """Retain metered evidence after IO even if the admitted caller lost access.

    Only the original reservation caller may use this internal completion path;
    it confers no read permission and does not admit another model invocation.
    """
    from homun.application import budget_settlement
    from homun.domain.errors import PermissionDeniedError
    from homun.policy import require_workspace_actor
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            require_workspace_actor(actor, store.workspace_id)
            budget = store.work_budgets.get(work_id)
            if budget is None:
                raise NotFoundError('Work budget no longer exists')
            reservation = next((r for r in budget.pending if r.id == reservation_id), None)
            saved = reservation or store.budget_usage_receipts.get(reservation_id)
            if saved is None or (hasattr(saved, 'work_id') and saved.work_id != work_id):
                raise PermissionDeniedError('Reservation does not belong to this work')
            if saved.admitted_actor_id:
                if saved.admitted_actor_id != actor.id:
                    raise PermissionDeniedError('Only the original admitted caller may settle this reservation')
            else:
                require_work_access(store, actor, work_id)  # Legacy admission has no recorded caller.
            receipt = budget_settlement.settle_in_store(store, budget, reservation_id, **kwargs)
        ctx.service.store = store
    return receipt


def reconcile(ctx, actor, work_id, reservation_id, *, usage: BudgetCounters | None = None,
              unknown_usage: BudgetCounters | None = None, measured_usage=None, reason=''):
    return _settle(ctx, actor, work_id, reservation_id, usage=usage, unknown_usage=unknown_usage,
                   measured_usage=measured_usage, reason=reason)


def reconcile_unknown(ctx, actor, work_id, reservation_id, *, reason=''):
    return _settle(ctx, actor, work_id, reservation_id, reason=reason)


def release(ctx, actor, work_id, reservation_id):
    return _settle(ctx, actor, work_id, reservation_id, released=True)


def recover_pending(ctx, *, now=None) -> int:
    from homun.application import budget_settlement
    moment = now or utc_now()
    recovered = 0
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for budget in store.work_budgets.values():
                stale = [r for r in budget.pending if moment - r.created_at > PENDING_TTL]
                for reservation in stale:
                    budget_settlement.settle_in_store(store, budget, reservation.id, reason='stale_reservation_recovered')
                    recovered += 1
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
