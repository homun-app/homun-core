"""Route ordinary messages to a unique owned active native run, atomically."""
from homun.application.agent_runs import PROPOSAL_TYPE
from homun.application.agent_control import control_in_store
from homun.application import agent_native
from homun.domain.errors import ConflictError


def route_message(ctx,store,actor,body,result):
    conversation_id=body.payload.get('conversation_id')
    candidates=[]
    for record in store.commands.values():
        if record.type!=PROPOSAL_TYPE:continue
        run=record.result
        work=store.works[run['work_id']]
        if (run['status'] in {'queued','running','paused'} and agent_native.enabled(run)
                and conversation_id in work.conversation_ids
                and actor.kind=='person' and actor.id in {work.owner_id,work.reviewer_id}):
            candidates.append(run)
    if not candidates:return False
    if len(candidates)!=1:
        raise ConflictError('More than one active work; choose which work to correct')
    run=candidates[0];work=store.works[run['work_id']]
    control_in_store(ctx,store,actor,work.id,run['id'],{'command_id':body.command_id+':steer',
        'expected_version':work.version,'action':'steer','text':body.payload['text']},echo=False)
    text='Indicazione ricevuta: Homun la userà al prossimo passo.' if run['status']!='paused' else 'Indicazione salvata. Riprendi il lavoro per applicarla.'
    ctx.service.for_store(store).append_engine_message(actor=actor,command_id=body.command_id+':ack',
        conversation_id=conversation_id,author_id='homun_engine',text=text,
        event_payload={'work_id':work.id,'agent_run_id':run['id']})
    result.update(agent_run_id=run['id'],agent_control='steer',assistant_text=text)
    record=store.commands[body.command_id]
    record.result=result.copy();record.followup_status='completed'
    return True
