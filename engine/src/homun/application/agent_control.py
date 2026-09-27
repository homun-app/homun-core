"""Durable owner controls for native runs; no network calls inside transactions."""
from homun.application import agent_native, agent_recovery
from homun.application.agent_control_history import close_pending, redirect_history
from homun.application.agent_runs import authority, lookup, public, public_for
from homun.application.price_comparisons import cached, save
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.policy.work import require_work_access

CONTROL='agent_run.control'
ACTIVE={'queued','running','paused','waiting_automation'}


def _owner(store,actor,run):
    work=require_work_access(store,actor,run['work_id'],'write')
    if actor.kind!='person' or actor.id not in {work.owner_id,work.reviewer_id}:
        raise PermissionDeniedError('Only the human owner or reviewer can control the run')
    return work


from homun.application.agent_run_fencing import _fence


def control_in_store(ctx,store,actor,work_id,run_id,body,*,echo=True):
    run=lookup(store,run_id,work_id)
    work=_owner(store,actor,run)
    if run.get('_delegation_parent'):
        raise ValidationError('Control delegated work through its parent supervisor')
    record,fingerprint=cached(store,actor,body['command_id'],CONTROL,{**body,'work_id':work_id,'run_id':run_id})
    if record:
        return public_for(store,actor,record.result)
    if not agent_native.enabled(run):
        raise ValidationError('Execution controls require a native run')
    action=body['action'];text=body.get('text','') or ''
    if action not in {'steer','redirect','pause','resume','cancel'}:
        raise ValidationError('Unknown execution control')
    if action in {'steer','redirect'} and (not isinstance(text,str) or not text.strip() or len(text)>16000):
        raise ValidationError('A correction of 1 to 16000 characters is required')
    if run['status'] not in ACTIVE and not (run['status'] in {'waiting_input','waiting_external'} and action=='cancel'):
        raise ConflictError('Run is no longer controllable')
    if work.version != body['expected_version']:
        raise ConflictError('Work changed; refresh the control')
    if action in {'steer','redirect','resume'}:
        authority(ctx,store,actor,run,approve=True)
    if action=='resume' and run['status']!='paused':
        raise ConflictError('Only a paused run can resume')
    if action=='pause' and run['status']=='paused':
        raise ConflictError('Run is already paused')
    service=ctx.service.for_store(store)
    if action in {'steer','redirect'}:
        if run['status']=='paused' and work.version!=run.get('_pause_version'):
            raise ConflictError('Paused work changed')
        if run['status']!='paused' and (work.status!='running' or work.version!=run['_run_version']):
            raise ConflictError('Approved work changed')
        from homun.application.automation_projection import invalidate_evaluation
        invalidate_evaluation(run)
        if action=='steer':
            if len(run.get('_steering',[]))>=20:
                raise ValidationError('Too many pending corrections; wait for the next round')
            agent_recovery.interrupt(run)
            run.setdefault('_steering',[]).append({'text':text,'command_id':body['command_id'],'actor_id':actor.id})
            if run['status']=='waiting_automation':
                _fence(run,actor)
                run['status']='queued'
                run.pop('automation_wait',None)
        else:
            redirect_history(run,text)
            _fence(run,actor)
            if run['status']!='paused':run['status']='queued'
    elif action=='pause':
        service.apply(actor,body['command_id']+':pause','work.pause',{'work_id':work.id,'expected_version':work.version})
        run.update(status='paused',_pause_version=work.version)
        _fence(run,actor,preserve_active=True)
    elif action=='resume':
        if work.status!='paused' or work.version!=run.get('_pause_version'):
            raise ConflictError('Work changed after pause')
        service.apply(actor,body['command_id']+':accept','plan.accept',{'work_id':work.id,'expected_version':work.version})
        service.apply(actor,body['command_id']+':start','work.start',{'work_id':work.id,'expected_version':work.version,'durable':False})
        run.update(status='queued',_run_version=work.version)
        _fence(run,actor,preserve_active=True)
    else:
        close_pending(run)
        service.apply(actor,body['command_id']+':cancel','work.cancel',{'work_id':work.id,'expected_version':work.version})
        if run.get('request_id') and store.contributions[run['request_id']].status=='pending':
            store.contributions[run['request_id']].status='rejected'
        from homun.application import terminal_jobs
        to_stop = []
        if run.get('terminal_wait_id'):
            to_stop.append(run['terminal_wait_id'])
        for record in store.commands.values():
            if record.type == terminal_jobs.TYPE:
                prop = record.result
                if prop.get('work_id') == work.id:
                    binding = prop.get('_agent_binding') or {}
                    if binding.get('run_id') == run_id:
                        if prop.get('status') not in {'exited', 'dead', 'outcome_unknown', 'pending_approval', 'dispatching'}:
                            if prop['id'] not in to_stop:
                                to_stop.append(prop['id'])
        if to_stop:
            run['_terminal_to_stop'] = to_stop
        run.update(status='cancelled')
        _fence(run,actor)
    run.setdefault('_controls',[]).append({'action':action,'text':text,'actor_id':actor.id,'command_id':body['command_id']})
    if echo:
        labels={'steer':'Indicazione aggiunta al lavoro','redirect':'Correzione applicata: Homun rivaluta il prossimo passo',
                'pause':'Lavoro in pausa','resume':'Lavoro ripreso','cancel':'Lavoro interrotto'}
        service.append_engine_message(actor=actor,command_id=body['command_id']+':notice',
            conversation_id=work.primary_conversation_id,author_id='homun_engine',
            text=labels[action]+(': '+text if text else '.'),event_payload={'work_id':work.id,'agent_run_id':run_id})
    result=public(run)
    save(store,actor,body['command_id'],CONTROL,fingerprint,result)
    return public_for(store,actor,result)


def control(ctx,actor,work_id,run_id,body):
    from homun.application import terminal_jobs
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result=control_in_store(ctx,store,actor,work_id,run_id,body)
            run_cmd = store.commands.get(run_id)
            to_stop = list(run_cmd.result.pop('_terminal_to_stop', [])) if run_cmd else []
        ctx.service.store=store
    for term_id in to_stop:
        try:
            terminal_jobs.stop(ctx, actor, work_id, term_id)
        except Exception:
            pass
    return result
