"""Validate a terminal proposal against the current canonical agent call."""
from homun.application import agent_native
from homun.domain.errors import ConflictError


def validate_link(ctx,store,actor,proposal,*,staging=False):
    link=proposal.get('_agent_binding')
    if not link:return None
    from homun.application.agent_runs import lookup,authority
    from homun.application.agent_tool_bridge import resolve_call
    run=lookup(store,link['run_id'],proposal['work_id'])
    authority(ctx,store,actor,run,running=True)
    if run['_epoch']!=link['epoch'] or run['status']!=('running' if staging else 'waiting_external'):
        raise ConflictError('Terminal call has been cancelled or superseded')
    if staging and run.get('_lease_token')!=link['lease_token']:
        raise ConflictError('Agent lease changed before terminal staging')
    if not staging and run.get('terminal_request_id')!=proposal['id']:
        raise ConflictError('Terminal request is no longer awaited')
    call=agent_native.pending(run)
    call=resolve_call(run,call) if call else None
    if (call is None or call.id!=link['call_id'] or call.name!='terminal_execute'
            or call.arguments.get('command')!=proposal['command']
            or set(call.arguments)-{'command','timeout_seconds'}
            or call.arguments.get('timeout_seconds',300)!=proposal.get('timeout_seconds',300)
            or run.get('terminal',{}).get('image')!=proposal['image']):
        raise ConflictError('Terminal proposal differs from the canonical call')
    return run


