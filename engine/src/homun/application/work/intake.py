"""Durable conversational brief, committed by the front-door turn.

Proposals arrive from the front-door native turn (``commit_front_door_proposal``);
confirmation and listing are the stable transport the UI reads. Nothing here
calls a model: the brief is what the model proposed and the engine validated.
"""
from copy import deepcopy
from homun.application.work.price_comparisons import cached, save
from homun.application.work.intake_policy import (PROPOSAL_TYPE, active_agents, anchor_brief, authority, digest, idle,
                                                  lookup, permission_snapshot, proposals_for, public)
from homun.application.work.intake_brief import effective_values
from homun.domain.errors import ConflictError, ValidationError
from homun.domain.models import utc_now
from homun.policy.work import require_work_access


def _resolve_plan_assignee(store, name, fallback_agent_id):
    wanted = str(name or '').strip().casefold()
    if wanted:
        for agent in store.agents.values():
            if agent.status == 'active' and agent.name.strip().casefold() == wanted:
                return agent.id
    if wanted:
        raise ConflictError('Plan phase collaborator is no longer active')
    return fallback_agent_id


def commit_front_door_proposal(ctx, actor, *, command_id, conversation_id, work_id, brief, text):
    """Commit a validated front-door brief as the SAME record the first-message
    intake path creates: pending confirmation, same UI, same confirmation flow.

    The brief already passed the shared ``validate_brief`` rules during the
    model turn; here values are re-assembled against fresh state (anchor brief,
    staffing, plan-step people) and optimistic failures land on the record as
    typed intake error codes instead of crashing the chat turn. Runs inside the
    caller's repository transaction, on ``ctx.service.store``.
    """
    store = ctx.service.store
    service = ctx.service
    if work_id is None:
        # A chat without a linked work gets its draft work when the first
        # proposal lands, exactly like the UI's createEngineConversationAndWork.
        work_id = service.apply(actor, f'{command_id}:work', 'work.create', {
            'conversation_id': conversation_id,
            'title': brief.title, 'objective': brief.objective})['work_id']
    work = authority(store, actor, {'work_id': work_id})
    _record, fingerprint = cached(store, actor, command_id, PROPOSAL_TYPE,
                                  {'work_id': work_id, 'front_door': True})
    previous = proposals_for(store, work_id)
    for p in previous:
        if p['status'] == 'pending_confirmation':
            p.update(status='failed', error_code='intake_superseded')
    previous_brief = anchor_brief(previous)
    agents = active_agents(store)
    proposal = {'id': command_id, 'status': 'failed', 'work_id': work_id,
                'expected_version': work.version,
                'title': 'Richiesta da chiarire', 'objective': '', 'output': '', 'constraints': [],
                'missing_information': [], 'suggested_agent': None, 'new_agent': None,
                'rationale': '', 'capability': 'general', 'original_request': text,
                'changed_fields': [], 'changes': [],
                'error_code': 'intake_interrupted', '_submitted_text': text,
                '_permissions': permission_snapshot(store, actor, work)}
    try:
        idle(work)
        # Defence in depth: the turn already validated the brief; the same
        # shared rules run again against fresh state before anything persists.
        from homun.models.intake import validate_brief
        validate_brief(brief, agents)
        values, changes = effective_values(brief, agents, previous_brief, owner_id=work.owner_id)
        error = None
    except (ValueError, TypeError, ConflictError):
        values = {}; changes = []; error = 'intake_invalid_response'
    if error:
        proposal.update(status='failed', error_code=error)
    else:
        proposal.update(values, status='pending_confirmation')
        proposal.pop('error_code', None)
    proposal['changes'] = changes
    proposal['digest'] = digest(proposal)
    save(store, actor, command_id, PROPOSAL_TYPE, fingerprint, proposal)
    return deepcopy(public(proposal))


def confirm(ctx,actor,work_id,proposal_id,body):
    payload={**body,'work_id':work_id,'proposal_id':proposal_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal=lookup(store,proposal_id,work_id)
            work=authority(store,actor,proposal)
            record,fingerprint=cached(store,actor,body['command_id'],'intake.confirm',payload)
            if body['digest']!=proposal['digest'] or body['expected_version']!=proposal['expected_version']:
                raise ConflictError('Confirmation does not match proposal')
            if permission_snapshot(store,actor,work)!=proposal['_permissions']:
                raise ConflictError('Permissions changed; propose again')
            selected=proposal['suggested_agent']
            if selected:
                agent=store.agents.get(selected['id'])
                if not agent or agent.status!='active' or agent.revision!=selected['revision']:
                    raise ConflictError('Suggested agent changed; propose again')
            from homun.policy.intake import latest_intake
            if latest_intake(store,work_id)['id'] != proposal_id:
                raise ConflictError('A newer intake proposal supersedes this confirmation')
            if record:
                return deepcopy(public(proposal))
            idle(work)
            if proposal['status']!='pending_confirmation' or work.version!=proposal['expected_version']:
                raise ConflictError('Proposal or work changed; propose again')
            service=ctx.service.for_store(store)
            owner=selected['id'] if selected else work.owner_id
            if not (selected or proposal['new_agent']) and 'staffing' in proposal.get('changed_fields', []):
                owner = work.reviewer_id or actor.id
            if proposal['new_agent']:
                if not body.get('create_agent',False):
                    raise ValidationError('Explicit creation confirmation is required')
                profile = dict(proposal['new_agent'])
                # The intake brief's identity fields flow into the agent profile.
                for field in ('responsibility','specializations','method','tone','capabilities'):
                    if field not in profile:
                        profile[field] = [] if field in ('specializations','capabilities') else ''
                created=service.apply(actor,body['command_id']+':agent','agent.create',profile)
                owner=created['agent_id']
            elif body.get('create_agent',False):
                raise ValidationError('No new profile was proposed')
            # Delegating execution preserves the confirming human owner's review role.
            # Never replace an existing reviewer or promote an unrelated writer.
            if owner != work.owner_id and work.owner_id == actor.id and work.reviewer_id is None:
                work.reviewer_id = actor.id
            work.objective=proposal['objective']; work.owner_id=owner
            manually_named=any(r.type=='work.rename' and r.result.get('work_id')==work_id for r in store.commands.values())
            if not manually_named:
                work.title=proposal['title']
                conv=store.conversations[work.primary_conversation_id]
                if not any(r.type=='conversation.rename' and r.result.get('conversation_id')==conv.id for r in store.commands.values()):
                    conv.title=proposal['title']; conv.version+=1; conv.updated_at=utc_now()
            work.version+=1; work.updated_at=utc_now()
            service._context._emit(actor=actor,command_id=body['command_id'],aggregate_id=work.id,aggregate_type='work',aggregate_version=work.version,event_type='work.intake_confirmed',payload={'proposal_id':proposal_id,'owner_id':owner})
            proposal['status']='confirmed'
            if proposal.get('plan_steps'):
                # The confirmed agreement declared phases: publish them as the
                # accepted plan (chained steps). One ack covers both; the plan
                # becomes the honest contract the panel ladder shows.
                from homun.domain.ids import new_id as _new_id
                chained=[]
                for draft in proposal['plan_steps']:
                    assignee_id=_resolve_plan_assignee(store, draft.get('assignee',''), owner)
                    if not assignee_id:
                        raise ConflictError('Plan phase has no collaborator')
                    chained.append({'id':_new_id('step'),
                                    'title':draft.get('title',''),
                                    'assignee_id':assignee_id,
                                    'depends_on':[chained[-1]['id']] if chained else [],
                                    'output_expected':draft.get('output_expected',''),
                                    'capability':draft.get('capability','general')})
                proposed=service.apply(actor,body['command_id']+':plan','plan.propose',
                                       {'work_id':work_id,'steps':chained,'expected_version':work.version})
                service.apply(actor,body['command_id']+':plan_accept','plan.accept',
                              {'work_id':work_id,'expected_version':proposed['version']})
            save(store,actor,body['command_id'],'intake.confirm',fingerprint,{'proposal_id':proposal_id})
        ctx.service.store=store
    return deepcopy(public(proposal))


def list_proposals(ctx,actor,work_id):
    store=ctx.repository.load()
    require_work_access(store,actor,work_id,'read')
    return {'items':[deepcopy(public(r.result)) for r in sorted(store.commands.values(),key=lambda r:r.created_at) if r.type==PROPOSAL_TYPE and r.result['work_id']==work_id]}
