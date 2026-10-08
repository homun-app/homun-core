"""Fence effectful Python calls before launching a child process."""
from homun.domain.errors import ValidationError


def run_once(ctx, actor, run, execute):
    if ctx is None or not run.get('id'):
        return execute()  # Explicit standalone/test invocation.
    from homun.application import agent_native
    from homun.application.agent_runs import lookup, authority
    call = agent_native.pending(run) if agent_native.enabled(run) else None
    key = call.id if call else f'turn:{run["turns"]}'
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        current = lookup(store, run['id'])
        authority(ctx, store, actor, current, running=True)
        if current.get('_lease_token') != run.get('_lease_token'):
            raise ValidationError('Code execution lease changed')
        receipts = current.setdefault('_code_receipts', {})
        previous = receipts.get(key)
        if previous is not None:
            if previous['status'] == 'completed':
                return previous['result']
            return {'error_code':'execution_outcome_unknown', 'exit_code':None,
                    'error':'A prior Python call has no confirmed result; automatic replay is forbidden'}
        receipts[key] = {'status':'dispatching'}
    # Crash here or during execution leaves durable uncertainty, never a retry.
    result = execute()
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        current = lookup(store, run['id'])
        current.setdefault('_code_receipts', {})[key] = {'status':'completed', 'result':result}
    return result
