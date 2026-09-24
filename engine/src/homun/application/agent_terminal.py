"""Native terminal calls pause for consent and resume from an owned job receipt."""
from copy import deepcopy
from homun.application import agent_native, terminal_jobs
from homun.domain.models import Actor
from homun.execution.contracts import digest
from homun.application.agent_terminal_link import validate_link


def stage(ctx,actor,run,decision):
    call=agent_native.pending(run)
    proposal_id='terminal:'+digest([run['id'],run['_epoch'],call.id])
    terminal_jobs.propose(ctx,actor,run['work_id'],{
        'command_id':proposal_id,'image':run['terminal']['image'],'command':decision.arguments['command'],
        'timeout_seconds':decision.arguments.get('timeout_seconds',300),'expected_version':run['_run_version']},agent_binding={
        'run_id':run['id'],'epoch':run['_epoch'],'call_id':call.id,'lease_token':run['_lease_token']})
    return 'waiting_external'


def resume(ctx,run_id):
    from homun.application.agent_runs import lookup,authority
    store=ctx.repository.load();run=lookup(store,run_id)
    if run['status']!='waiting_external' or not run.get('terminal_request_id'):return False
    actor=Actor.model_validate(run['_actor'])
    authority(ctx,store,actor,run,running=True)
    proposal_id=run['terminal_request_id']
    proposal=store.commands[proposal_id].result
    if proposal['status']=='pending_approval':return False
    terminal_jobs.refresh(ctx,actor,run['work_id'],proposal_id)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run=lookup(store,run_id)
            if run['status']!='waiting_external' or run.get('terminal_request_id')!=proposal_id:return False
            proposal=store.commands[proposal_id].result
            validate_link(ctx,store,actor,proposal)
            if proposal['status'] not in {'exited','dead'} or proposal.get('logs') is None:return False
            call=agent_native.pending(run)
            receipt={k:deepcopy(proposal.get(k)) for k in ('status','exit_code','timed_out','oom_killed','logs','error_code','error')}
            receipt['job_id']=proposal_id
            receipt['is_error']=bool(proposal.get('timed_out')) or proposal.get('exit_code')!=0 or proposal['status']=='dead'
            receipt=agent_native.append_result(run,receipt)
            run['observations'].append({'tool':call.name,'arguments':call.arguments,'message':'Terminal command completed','result':receipt})
            run['turns']+=1
            for key in ('_decision','_active_call_id','terminal_request_id'):run.pop(key,None)
            run['_epoch']+=1
            run.update(status='queued',_workflow_id=f'agent:{actor.workspace_id}:{run_id}:{run["_epoch"]}')
        ctx.service.store=store
    return True
