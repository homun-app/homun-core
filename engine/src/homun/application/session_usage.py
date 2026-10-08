"""Scoped immutable usage receipts; inherited history is provenance, never new spend."""
from collections import Counter
from homun.application.session_history import authorize_usage
from homun.domain.errors import DomainError, ValidationError
from homun.policy.work import require_work_access


def _totals(receipts):
    charged_known, charged_unknown, states = Counter(), Counter(), Counter()
    costs = Counter()
    observed = [receipt for receipt in receipts if receipt.status != 'released']
    for receipt in receipts:
        charged_known.update(receipt.charged_known.model_dump())
        charged_unknown.update(receipt.charged_unknown.model_dump())
        states[receipt.status] += 1
        if receipt.status != 'released' and receipt.cost is not None and receipt.currency:
            costs[receipt.currency] += receipt.cost
    result = {'charged_known': dict(charged_known or {'attempts': 0, 'input_tokens': 0, 'output_tokens': 0}),
              'charged_unknown': dict(charged_unknown or {'attempts': 0, 'input_tokens': 0, 'output_tokens': 0}),
              'states': dict(states), 'cost_by_currency': dict(costs)}
    for axis in ('input_tokens', 'output_tokens'):
        known = sum(getattr(receipt, axis) or 0 for receipt in observed)
        result['known_' + axis] = known
        result[axis] = known if all(getattr(receipt, axis) is not None for receipt in observed) else None
    complete_cost = all(receipt.cost is not None and receipt.currency for receipt in observed)
    result['total_cost'] = sum(costs.values()) if complete_cost and len(costs) <= 1 else None
    result['currency'] = next(iter(costs)) if len(costs) == 1 and complete_cost else None
    return result


def query(ctx, actor, work_id, *, session_id=None, limit=50, cursor=None):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 200:
        raise ValidationError('Receipt page limit must be between 1 and 200')
    store = ctx.repository.load()
    require_work_access(store, actor, work_id, 'read')
    session = authorize_usage(store, actor, work_id, session_id) if session_id else None
    all_work = [receipt for receipt in store.budget_usage_receipts.values() if receipt.work_id == work_id]
    receipts = []
    restricted = False
    for receipt in all_work:
        if session_id and receipt.run_id != session_id:
            continue
        if receipt.run_id:
            try:
                authorize_usage(store, actor, work_id, receipt.run_id)
            except DomainError:
                restricted = True
                continue
        receipts.append(receipt)
    receipts.sort(key=lambda receipt: (receipt.settled_at, receipt.id))
    start = 0
    if cursor:
        index = next((index for index, receipt in enumerate(receipts) if receipt.id == cursor), None)
        if index is None:
            raise ValidationError('Receipt cursor is not in the readable query')
        start = index + 1
    page = receipts[start:start+limit]
    budget = store.work_budgets.get(work_id)
    legacy = False
    if budget:
        all_totals = _totals(all_work)
        legacy = any(getattr(budget.spent, axis) != all_totals['charged_known'].get(axis, 0)
                     or getattr(budget.unknown, axis) != all_totals['charged_unknown'].get(axis, 0)
                     for axis in ('attempts', 'input_tokens', 'output_tokens'))
    pending = []
    for reservation in (budget.pending if budget else []):
        if session_id and reservation.run_id != session_id:
            continue
        if reservation.run_id:
            try:
                authorize_usage(store, actor, work_id, reservation.run_id)
            except DomainError:
                restricted = True
                continue
        pending.append(reservation)
    marker = True
    inherited = []
    if session_id:
        record = store.commands[session_id]
        if record.type == 'agent_run.propose':
            marker = record.result.get('_usage_receipts_version') == 1
            own_attempts = sum(r.charged_known.attempts + r.charged_unknown.attempts for r in receipts)
            marker = marker and own_attempts + len(pending) >= record.result.get('model_attempts', 0)
        if session.get('parent_id'):
            inherited.append(session['parent_id'])
    incomplete = not marker or bool(pending) or restricted or (legacy and session_id is None)
    totals = _totals(receipts)
    if incomplete:
        totals.update(input_tokens=None, output_tokens=None, total_cost=None, currency=None)
    from homun.application.session_dependencies import _collect
    source_ids = {item.run_id for item in receipts + pending if item.run_id}
    if session_id:
        source_ids.add(session_id)
    bindings = []
    for source_id in sorted(source_ids):
        for binding in _collect(store, actor, source_id, work_id, None):
            if binding not in bindings:
                bindings.append(binding)
    return {'read_bindings': bindings, 'work_id': work_id, 'session_id': session_id, 'receipt_count': len(receipts),
        'receipts': [receipt.model_dump(mode='json') for receipt in page],
        'next_cursor': page[-1].id if start+len(page) < len(receipts) and page else None,
        'totals': totals, 'pending_count': len(pending), 'inherited_session_ids': inherited,
        'coverage': {'complete': not incomplete,
                     'legacy_unattributed': legacy or not marker, 'scope': 'currently_readable_own_calls'},
        'work_only_receipt_count': sum(receipt.run_id is None for receipt in receipts)}
