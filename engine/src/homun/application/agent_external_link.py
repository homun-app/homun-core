"""Validate a supervised external action against its live native call."""
from homun.application.agent_runs import lookup, authority
from homun.application import agent_native
from homun.domain.errors import ConflictError


def validate_link(ctx,store,actor,proposal,*,staging=False):
    link=proposal.get('_agent_binding')
    if not link:
        return None
    run=lookup(store,link['run_id'],proposal['work_id'])
    authority(ctx,store,actor,run,running=True)
    expected_status='running' if staging else 'waiting_external'
    if run['_epoch']!=link['epoch'] or run['status']!=expected_status:
        raise ConflictError('Agent action has been cancelled or superseded')
    if staging and run.get('_lease_token')!=link['lease_token']:
        raise ConflictError('Agent lease changed while preparing external action')
    if not staging and run.get('external_request_id')!=proposal['id']:
        raise ConflictError('External action is no longer awaited')
    call=agent_native.pending(run)
    if call is not None:
        from homun.application.agent_tool_bridge import resolve_call
        call=resolve_call(run,call)
    binding=next((b for b in run.get('_mcp_bindings',[]) if call and b['name']==call.name),None)
    if (call is None or call.id!=link['call_id'] or binding is None
            or binding['server_id']!=proposal['server_id'] or binding['tool']!=proposal['tool']
            or call.arguments!=proposal['arguments'] or binding['descriptor']!=proposal['_tool_descriptor']):
        raise ConflictError('External proposal differs from the approved agent call')
    return run
