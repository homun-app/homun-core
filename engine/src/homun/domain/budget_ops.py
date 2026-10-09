"""Store-level work-budget mutations shared by application and domain commands.

Domain handlers (e.g. peer delegation) must reserve and settle inside the same
repository transaction as the command — these helpers stay free of application
imports so architecture layers remain one-way.
"""
from __future__ import annotations

import hashlib
import json
import math

from homun.domain.errors import BudgetExhaustedError, ConflictError, NotFoundError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import (BudgetCaps, BudgetCounters, BudgetReservation,
                                 BudgetUsageReceipt, WorkBudget, utc_now)
from homun.policy.work import require_work_access


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


def reserve_in_store(store, actor, work_id, estimate, *, purpose='', accounting_actor_id=None,
                     run_id=None, connection_id=None, provider_id=None, model_id=None):
    charged_actor_id = accounting_actor_id or actor.id
    budget = check_capacity(store, actor, work_id, estimate, accounting_actor_id=charged_actor_id)
    reservation = BudgetReservation(id=new_id('res'), estimate=estimate, purpose=purpose,
        actor_id=charged_actor_id, admitted_actor_id=actor.id, run_id=run_id,
        connection_id=connection_id, provider_id=provider_id, model_id=model_id)
    budget.pending.append(reservation)
    budget.reserved = add(budget.reserved, estimate)
    allocation = budget.allocations.get(charged_actor_id)
    if allocation is not None:
        allocation.reserved = add(allocation.reserved, estimate)
    budget.version += 1
    budget.updated_at = utc_now()
    return reservation.id


def add(a, b):
    return BudgetCounters(**{key: getattr(a, key) + getattr(b, key)
                             for key in ('attempts', 'input_tokens', 'output_tokens')})


def subtract(a, b):
    return BudgetCounters(**{key: max(0, getattr(a, key) - getattr(b, key))
                             for key in ('attempts', 'input_tokens', 'output_tokens')})


def _measured(value, *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    if integer and not isinstance(value, int):
        return None
    return value if integer else float(value)


def _settlement(reservation, *, usage, unknown_usage, measured_usage, released):
    known = usage or BudgetCounters()
    unknown = unknown_usage or BudgetCounters()
    if released:
        known, unknown = BudgetCounters(), BudgetCounters()
    elif usage is None:
        unknown = reservation.estimate
    for counters in (known, unknown):
        if any(value < 0 for value in counters.model_dump().values()):
            raise ValidationError('Settled budget counters cannot be negative')
    measured = measured_usage or {}  # Conservative counters are not measured provider metadata.
    input_tokens = _measured(measured.get('input_tokens'), integer=True)
    output_tokens = _measured(measured.get('output_tokens'), integer=True)
    for axis, measured_value in (('input_tokens', input_tokens), ('output_tokens', output_tokens)):
        if measured_value is not None and measured_value != getattr(known, axis):
            raise ValidationError('Provider measurement contradicts charged known counters')
    status = ('released' if released else 'unknown' if usage is None else
              'partial' if any(unknown.model_dump().values()) or input_tokens is None or output_tokens is None else 'known')
    return {'status': status, 'charged_known': known.model_dump(), 'charged_unknown': unknown.model_dump(),
            'input_tokens': input_tokens, 'output_tokens': output_tokens,
            'cost': _measured(measured.get('estimated_cost')), 'currency': measured.get('currency'),
            'reported_provider_id': measured.get('provider_id'), 'reported_model_id': measured.get('model_id')}


def settle_in_store(store, budget, reservation_id, *, usage=None, unknown_usage=None,
                    measured_usage=None, released=False, reason=''):
    existing = store.budget_usage_receipts.get(reservation_id)
    reservation = next((item for item in budget.pending if item.id == reservation_id), None)
    if reservation is None:
        if existing is None or existing.work_id != budget.work_id:
            raise NotFoundError('Budget reservation not found')
        reservation = BudgetReservation(id=existing.id, estimate=existing.estimate)
    payload = _settlement(reservation, usage=usage, unknown_usage=unknown_usage,
                          measured_usage=measured_usage, released=released)
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if existing is not None:
        if existing.work_id != budget.work_id or existing.settlement_fingerprint != fingerprint:
            raise ConflictError('Budget reservation already settled with different usage')
        return existing
    receipt = BudgetUsageReceipt(id=reservation.id, workspace_id=store.workspace_id, work_id=budget.work_id,
        run_id=reservation.run_id, connection_id=reservation.connection_id,
        requested_provider_id=reservation.provider_id, requested_model_id=reservation.model_id,
        accounting_actor_id=reservation.actor_id, admitted_actor_id=reservation.admitted_actor_id, purpose=reservation.purpose, reserved_at=reservation.created_at,
        estimate=reservation.estimate.model_copy(deep=True), reason=reason or ('released_before_call' if released else 'unreported_usage' if usage is None else 'reported_usage'),
        settlement_fingerprint=fingerprint, **payload)
    # All changes below commit in the caller's single repository transaction.
    budget.pending.remove(reservation)
    budget.reserved = subtract(budget.reserved, reservation.estimate)
    budget.spent = add(budget.spent, receipt.charged_known)
    budget.unknown = add(budget.unknown, receipt.charged_unknown)
    allocation = budget.allocations.get(reservation.actor_id)
    if allocation is not None:
        allocation.reserved = subtract(allocation.reserved, reservation.estimate)
        allocation.spent = add(allocation.spent, receipt.charged_known)
        allocation.unknown = add(allocation.unknown, receipt.charged_unknown)
    store.budget_usage_receipts[reservation_id] = receipt
    budget.version += 1
    budget.updated_at = utc_now()
    return receipt
