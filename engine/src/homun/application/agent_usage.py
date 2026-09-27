"""Attribute reservations and retain reported or partial provider measurements."""
from homun.application import budgets
from homun.application.budget_settlement import _measured
from homun.domain.models import BudgetCounters


def reserve(ctx, actor, run, *, purpose, connection_id=None, model_id=None, accounting_actor_id=None, store=None):
    if run.get('workspace_transfer') and run['workspace_transfer'].get('status') != 'ready':
        from homun.domain.errors import ConflictError
        raise ConflictError('Workspace transfer must be ready before a model call')
    from homun.application.runtime_selection import for_call
    selection = for_call(ctx.models, run, connection_id=connection_id, model_id=model_id)
    selected = selection['connection_id']
    connection = ctx.models.get_connection(selected)
    reserve_budget = (lambda *args, **kwargs: budgets.reserve_in_store(store, *args, **kwargs)) if store is not None else (lambda *args, **kwargs: budgets.reserve(ctx, *args, **kwargs))
    return reserve_budget(actor, run['work_id'], BudgetCounters(attempts=1), purpose=purpose,
        accounting_actor_id=accounting_actor_id or run['assignee_id'], run_id=run['id'],
        connection_id=selected, provider_id=connection.pydantic_provider or connection.kind,
        model_id=selection['model_id'])


def charge(ctx, actor, run, reservation, usage, *, reason=''):
    if reservation is None:
        return None
    if usage is None:
        return budgets.settle_admitted(ctx, actor, run['work_id'], reservation, reason=reason)
    measured = {key: (usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None))
                for key in ('input_tokens', 'output_tokens', 'estimated_cost', 'currency', 'provider_id', 'model_id')}
    input_tokens = _measured(measured['input_tokens'], integer=True)
    output_tokens = _measured(measured['output_tokens'], integer=True)
    complete = input_tokens is not None and output_tokens is not None
    known = BudgetCounters(input_tokens=input_tokens or 0, output_tokens=output_tokens or 0, attempts=1 if complete else 0)
    return budgets.settle_admitted(ctx, actor, run['work_id'], reservation, usage=known,
        unknown_usage=BudgetCounters(attempts=1) if not complete else None, measured_usage=measured, reason=reason)
