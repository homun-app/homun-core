"""Per-work model budget: atomic reservation before the call, honest reconciliation.

Reservations commit before any provider call, so a crash can never spend past
the cap without a trace. Reconciliation moves a reservation to `spent` (known
usage) or `unknown` (call failed or usage unreported): unknown stays unknown,
never zero. Stale reservations from a crashed process are recovered at startup
and charged as unknown — conservative, because the call may have happened.

Store-level mutations live in `homun.domain.budget_ops` so domain commands
(peer delegation) can reserve inside the same transaction.
"""
from datetime import timedelta

from homun.domain.budget_ops import check_capacity, ensure, reserve_in_store
from homun.domain.errors import NotFoundError
from homun.domain.models import BudgetCounters, WorkBudget, utc_now
from homun.policy.work import require_work_access

PENDING_TTL = timedelta(minutes=15)

# Re-export store helpers for existing call sites and tests.
__all__ = [
    'PENDING_TTL', 'ensure', 'check_capacity', 'reserve', 'reserve_in_store',
    'settle_admitted', 'reconcile', 'reconcile_unknown', 'release',
    'recover_pending', 'public',
]


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
