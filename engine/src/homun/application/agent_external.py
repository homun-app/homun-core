"""Pause native calls for approval, then consume a durable external receipt."""
import hashlib
from homun.application import agent_native, external_tools
from homun.application.agent_runs import authority, lookup
from homun.domain.errors import ConflictError
from homun.domain.models import Actor


class ExternalOutcomeUnknown(ConflictError):
    code = "external_outcome_unknown"


def stage(ctx,actor,run,decision):
    call=agent_native.pending(run)
    binding=next(b for b in run['_mcp_bindings'] if b['name']==decision.tool)
    suffix=hashlib.sha256(f'{run["_epoch"]}:{call.id}'.encode()).hexdigest()[:24]
    proposal_id=f'{run["id"]}:external:{suffix}'
    external_tools.propose(ctx,actor,{'command_id':proposal_id,'work_id':run['work_id'],
        'server_id':binding['server_id'],'tool':binding['tool'],'arguments':decision.arguments},
        agent_binding={'run_id':run['id'],'epoch':run['_epoch'],'call_id':call.id,'lease_token':run['_lease_token']})
    return ctx.repository.load().commands[run['id']].result['status']


def resume_external(ctx,run_id):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            resumed=_resume_in_store(ctx,store,run_id)
        ctx.service.store=store
    return resumed


def _resume_in_store(ctx,store,run_id):
    run=lookup(store,run_id)
    if run['status']!='waiting_external':
        return False
    actor=Actor.model_validate(run['_actor'])
    authority(ctx,store,actor,run,running=True)
    proposal=store.commands[run['external_request_id']].result
    status=proposal['status']
    if status=='running':
        from datetime import datetime
        from homun.domain.models import utc_now
        deadline=proposal.get('_dispatch_deadline')
        if not deadline or datetime.fromisoformat(deadline)<=utc_now():
            proposal.update(status='outcome_unknown',error='Esito esterno incerto; verifica sul servizio richiesta.')
            return False
    if status in {'pending_approval','queued','running'}:
        return False
    if status=='outcome_unknown':
        raise ExternalOutcomeUnknown('External outcome is unknown; reconcile before continuing')
    if status not in {'result_ready','tool_error','blocked'}:
        raise ConflictError('Unexpected external action state')
    call=agent_native.pending(run)
    link=proposal['_agent_binding']
    if call is None or call.id!=link['call_id'] or run['_epoch']!=link['epoch']:
        raise ConflictError('External receipt belongs to a superseded call')
    result=proposal.get('_receipt') or {'error_code':'external_preflight_blocked','message':proposal.get('error','External action blocked')}
    agent_native.append_result(run,result)
    run['observations'].append({'tool':call.name,'arguments':call.arguments,'message':f'External result: {proposal["server_name"]} · {proposal["tool"]}','result':result})
    run['turns']+=1
    run.pop('_decision',None)
    run.pop('_active_call_id',None)
    run.pop('external_request_id',None)
    run['_epoch']+=1
    run.update(status='queued',_workflow_id=f'agent:{actor.workspace_id}:{run_id}:{run["_epoch"]}')
    return True
