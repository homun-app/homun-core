"""Reserve an additional provider attempt within an already claimed turn."""
from homun.application import agent_native, agent_recovery, budgets
from homun.application.agent_runs import authority, lookup
from homun.domain.errors import ValidationError
from homun.domain.models import BudgetCounters


def reserve_extra(ctx, actor, snapshot, *, connection_id):
    from homun.application.agent_usage import reserve
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current=lookup(store,snapshot['id'])
            authority(ctx,store,actor,current,running=True)
            if current.get('_lease_token')!=snapshot['_lease_token'] or current.get('_steering'):
                raise ValidationError('Provider fallback superseded by human control')
            if current['model_attempts']>=current['limits']['max_model_attempts']:
                raise ValidationError('Adaptive run reached its model attempt limit')
            if agent_native.enabled(current):
                agent_recovery.begin(current,'decide')
            reservation = reserve(ctx, actor, current, purpose='agent_run.fallback',
                                  connection_id=connection_id, store=store)
            current['model_attempts']+=1
            from homun.application.runtime_selection import for_call
            current['runtime_selection'] = for_call(ctx.models, current, connection_id=connection_id)
            current['connection_id'] = connection_id
        ctx.service.store=store
    return reservation


def reserve_auxiliary(ctx, actor, snapshot, *, purpose, connection_id=None, model_id=None, detached=False):
    """Admit each physical auxiliary call and its run/work counters atomically."""
    from homun.application.agent_usage import reserve
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, snapshot['id'], snapshot['work_id'])
            authority(ctx, store, actor, current, running=not detached)
            if detached:
                if current['status'] not in {'queued', 'running', 'paused', 'waiting_input', 'waiting_external', 'waiting_automation'}:
                    raise ValidationError('Side questions require an active agent run')
            elif current.get('_lease_token') != snapshot.get('_lease_token') or current.get('_steering'):
                raise ValidationError('Auxiliary model call superseded by human control')
            if current['model_attempts'] >= current['limits']['max_model_attempts']:
                raise ValidationError('Adaptive run reached its model attempt limit')
            reservation = reserve(ctx, actor, current, purpose=purpose, connection_id=connection_id,
                                  model_id=model_id, store=store)
            current['model_attempts'] += 1
        ctx.service.store = store
    return reservation
