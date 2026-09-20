"""Explicit budget adjustments; exhaustion never resolves silently."""
from homun.domain.errors import ConflictError, ValidationError
from homun.domain.ids import new_id
from homun.domain.models import BudgetAllocation, BudgetCaps, WorkBudget, utc_now
from homun.policy.work import require_work_access


def work_set_budget(ctx, actor, command_id, payload):
    work = ctx.get_work(str(payload.get('work_id', '')))
    require_work_access(ctx.store, actor, work.id, 'write')
    raw = payload.get('caps') or {}
    if not isinstance(raw, dict):
        raise ValidationError('caps must be an object')
    model_attempts = raw.get('model_attempts', 40)
    if isinstance(model_attempts, bool) or not isinstance(model_attempts, int) or not 1 <= model_attempts <= 100000:
        raise ValidationError('model_attempts must be between 1 and 100000')
    caps = BudgetCaps(model_attempts=model_attempts,
                      input_tokens=_optional_cap(raw.get('input_tokens')),
                      output_tokens=_optional_cap(raw.get('output_tokens')))
    budget = ctx.store.work_budgets.get(work.id)
    if budget is None:
        budget = WorkBudget(id=new_id('budget'), workspace_id=ctx.store.workspace_id, work_id=work.id)
        ctx.store.work_budgets[work.id] = budget
    expected = payload.get('expected_version')
    if expected is not None and int(expected) != budget.version:
        raise ConflictError('Budget changed; refresh and retry')
    allocations = _allocations(ctx, payload.get('allocations'), budget)
    budget.caps = caps
    # New allocation limits keep the counters each delegate already spent.
    budget.allocations.update(allocations)
    budget.version += 1
    budget.updated_at = utc_now()
    ctx._emit(actor=actor, command_id=command_id, aggregate_id=work.id, aggregate_type='work',
              aggregate_version=work.version, event_type='work.budget_set',
              payload={'caps': caps.model_dump(),
                       'allocations': {k: {'actor_id': v.actor_id, 'model_attempts': v.model_attempts,
                                           'input_tokens': v.input_tokens, 'output_tokens': v.output_tokens}
                                       for k, v in allocations.items()}})
    return {'work_id': work.id, 'caps': caps.model_dump(), 'budget_version': budget.version,
            'allocations': sorted(budget.allocations)}


def _allocations(ctx, raw, budget):
    """Delegate sub-caps: explicit, known workspace actors, limits replaced."""
    if raw is None:
        return {}
    if not isinstance(raw, list):
        raise ValidationError('allocations must be a list')
    allocations = {}
    for item in raw:
        if not isinstance(item, dict):
            raise ValidationError('each allocation must be an object')
        actor_id = str(item.get('actor_id', '')).strip()
        if not actor_id or not _known_actor(ctx, actor_id):
            raise ValidationError(f'Unknown allocation actor: {actor_id}')
        attempts = item.get('model_attempts', 10)
        if isinstance(attempts, bool) or not isinstance(attempts, int) or not 1 <= attempts <= 100000:
            raise ValidationError('allocation model_attempts must be between 1 and 100000')
        existing = budget.allocations.get(actor_id)
        if existing is not None:
            existing.model_attempts = attempts
            existing.input_tokens = _optional_cap(item.get('input_tokens'))
            existing.output_tokens = _optional_cap(item.get('output_tokens'))
            allocations[actor_id] = existing
        else:
            allocations[actor_id] = BudgetAllocation(
                actor_id=actor_id, model_attempts=attempts,
                input_tokens=_optional_cap(item.get('input_tokens')),
                output_tokens=_optional_cap(item.get('output_tokens')))
    return allocations


def _known_actor(ctx, actor_id):
    """Agents come from the roster; persons from the actors that issued commands."""
    if actor_id in ctx.store.agents:
        return True
    return any(record.actor_id == actor_id for record in ctx.store.commands.values())


def _optional_cap(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValidationError('token caps must be positive integers or null')
    return value
