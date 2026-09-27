"""One atomic in-store transition from pending reservation to immutable receipt."""
import hashlib
import json
import math
from homun.domain.errors import ConflictError, NotFoundError, ValidationError
from homun.domain.models import BudgetCounters, BudgetReservation, BudgetUsageReceipt, utc_now


def add(a, b):
    return BudgetCounters(**{key: getattr(a, key) + getattr(b, key) for key in ('attempts', 'input_tokens', 'output_tokens')})


def subtract(a, b):
    return BudgetCounters(**{key: max(0, getattr(a, key) - getattr(b, key)) for key in ('attempts', 'input_tokens', 'output_tokens')})


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
