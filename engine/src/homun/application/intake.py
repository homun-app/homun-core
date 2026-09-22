"""Durable conversational brief, with model work outside transactions."""
from copy import deepcopy
from homun.application.price_comparisons import cached, save
from homun.application.intake_policy import PROPOSAL_TYPE, authority, digest, idle, lookup, permission_snapshot, public
from homun.application.intake_brief import brief_changes, preserve_staffing, stabilize
from homun.domain.capabilities import require_capability
from homun.domain.errors import BudgetExhaustedError, ConflictError, ValidationError
from homun.domain.models import utc_now
from homun.models.intake import classify_request, synthesize
from homun.policy.capabilities import capability_catalog
from homun.policy.work import require_work_access


def _usage_counters(usage):
    """Reported usage when the provider returned it; None keeps unknown as unknown."""
    if not usage:
        return None
    entry = usage[-1]
    if entry.input_tokens is None and entry.output_tokens is None:
        return None
    from homun.domain.models import BudgetCounters
    return BudgetCounters(attempts=1,
                          input_tokens=entry.input_tokens or 0,
                          output_tokens=entry.output_tokens or 0)


def classify_message(ctx, actor, work_id, text):
    """Ephemeral routing between chat and the agreement flow; persists nothing.

    The durable record of whatever the person said belongs to the transcript of
    the path chosen by the caller (chat reply or intake proposal), never here.
    """
    text = text.strip()
    if not text or len(text) > 12000:
        raise ValidationError('Request must contain 1-12000 characters')
    store = ctx.repository.load()
    authority(store, actor, {'work_id': work_id})
    pending = next((r.result for r in sorted(store.commands.values(), key=lambda r: r.created_at)
                    if r.type == PROPOSAL_TYPE and r.result['work_id'] == work_id
                    and r.result['status'] == 'pending_confirmation'), None)
    pending_brief = ({'title': pending['title'], 'objective': pending['objective']}
                     if pending and pending.get('objective') else None)
    from homun.application import budgets as work_budgets
    from homun.domain.models import BudgetCounters
    reservation = work_budgets.reserve(ctx, actor, work_id, BudgetCounters(attempts=1),
                                       purpose='intake.classify')
    usage = []
    try:
        kind, language = classify_request(ctx.models, text, pending_brief=pending_brief, usage_out=usage)
        work_budgets.reconcile(ctx, actor, work_id, reservation, usage=_usage_counters(usage))
        return kind, language
    except Exception:
        work_budgets.reconcile_unknown(ctx, actor, work_id, reservation)
        raise

def _plan_step_assignee_names_valid(steps, agents, collaborator_name):
    """Fresh phases must name people who can actually take them: an active roster
    collaborator or the brief's own proposed one. An empty name is the default
    (the brief's collaborator takes the phase); anything else unresolvable is
    an invalid brief."""
    if not steps:
        return True
    roster = {agent['name'].strip().casefold() for agent in agents}
    collaborator = (collaborator_name or '').strip().casefold()
    for step in steps:
        name = (step.get('assignee', '') if isinstance(step, dict) else step.assignee)
        name = str(name).strip().casefold()
        if name and name not in roster and name != collaborator:
            return False
    return True


def _resolve_plan_assignee(store, name, fallback_agent_id):
    wanted = str(name or '').strip().casefold()
    if wanted:
        for agent in store.agents.values():
            if agent.status == 'active' and agent.name.strip().casefold() == wanted:
                return agent.id
    return fallback_agent_id


def propose(ctx, actor, work_id, body):
    payload={**body,'work_id':work_id}
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work=authority(store,actor,{"work_id":work_id})
            record,fingerprint=cached(store,actor,body['command_id'],PROPOSAL_TYPE,payload)
            if record:
                authority(store,actor,record.result)
                return deepcopy(public(record.result))
            idle(work)
            if work.version != body['expected_version']:
                raise ConflictError('Work changed; refresh before proposing')
            text=body['text']
            if not text.strip() or len(text)>12000:
                raise ValidationError('Request must contain 1-12000 characters')
            previous=[r.result for r in sorted(store.commands.values(),key=lambda r:r.created_at) if r.type==PROPOSAL_TYPE and r.result['work_id']==work_id]
            previous_brief=next((deepcopy(public(p)) for p in reversed(previous) if p['objective']),None)
            original='\n\n'.join([p['_submitted_text'] for p in previous]+[text])
            if len(original)>30000:
                raise ValidationError('Intake context too long')
            ctx.service.for_store(store).apply(actor,body['command_id']+':message','conversation.post_message',{'conversation_id':work.primary_conversation_id,'text':text})
            for p in previous:
                if p['status']=='pending_confirmation':
                    p.update(status='failed',error_code='intake_superseded')
            proposal={'id':body['command_id'],'status':'failed','work_id':work_id,'expected_version':work.version,
                      'title':'Richiesta da chiarire','objective':'','output':'','constraints':[], 'missing_information':[],
                      'suggested_agent':None,'new_agent':None,'rationale':'','capability':'general','original_request':original,
                      'changed_fields':[],'changes':[],
                      'error_code':'intake_interrupted','_submitted_text':text,
                      '_permissions':permission_snapshot(store,actor,work)}
            proposal['digest']=digest(proposal)
            save(store,actor,body['command_id'],PROPOSAL_TYPE,fingerprint,proposal)
            agents=[{'id':a.id,'name':a.name,'role':a.role,'instructions':a.instructions,'revision':a.revision,
                     'capabilities':a.capabilities}
                    for a in store.agents.values() if a.status=='active']
            # Ground the collaborator recommendation in what the engine can really run.
            capabilities=capability_catalog(store,actor)
        ctx.service.store=store
    requested_language = body.get('language')
    language = (requested_language.strip().lower()[:8] or None
                if isinstance(requested_language, str) else None)
    from homun.application import budgets as work_budgets
    from homun.domain.models import BudgetCounters
    # Reserve before the provider call: exhaustion is durable and typed, and a
    # crash between reserve and reconcile leaves a recoverable trace.
    try:
        reservation = work_budgets.reserve(ctx, actor, work_id, BudgetCounters(attempts=1),
                                           purpose='intake.synthesize')
    except BudgetExhaustedError:
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                proposal = lookup(store, body['command_id'], work_id)
                proposal.update(status='failed', error_code='budget_exhausted')
                proposal['digest'] = digest(proposal)
            ctx.service.store = store
        return deepcopy(public(proposal))
    usage = []
    try:
        brief = synthesize(ctx.models, original, agents, previous_brief=previous_brief,
                           latest_request=text, capabilities=capabilities, language=language,
                           usage_out=usage)
    except BaseException as cause:
        # The call may have consumed provider budget even on failure.
        work_budgets.reconcile_unknown(ctx, actor, work_id, reservation)
        values = {}; changes = []
        error = 'intake_invalid_response' if isinstance(cause, (ValueError, TypeError)) else 'intake_provider_failed'
    else:
        work_budgets.reconcile(ctx, actor, work_id, reservation, usage=_usage_counters(usage))
        try:
            selected = next((a for a in agents if a['id'] == brief.suggested_agent_id), None)
            if brief.suggested_agent_id and not selected:
                raise ValueError('Suggested agent does not exist in active roster')
            collaborator_name = None
            if selected:
                collaborator_name = selected['name']
            elif brief.new_agent:
                collaborator_name = brief.new_agent.name
            if not _plan_step_assignee_names_valid(brief.plan_steps, agents, collaborator_name):
                raise ValueError('Plan step assignee is not a roster collaborator')
            if previous_brief:
                values = stabilize(brief, previous_brief)
            else:
                values = brief.model_dump(exclude={'suggested_agent_id'})
            values['suggested_agent'] = {k: selected[k] for k in ('id', 'name', 'role', 'revision')} if selected else None
            if previous_brief:
                values = preserve_staffing(values, previous_brief, agents, owner_id=work.owner_id)
            changes = brief_changes(previous_brief, values)
            error = None
        except (ValueError, TypeError):
            values = {}; changes = []; error = 'intake_invalid_response'
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            proposal=lookup(store,body['command_id'],work_id)
            work=authority(store,actor,proposal)
            if work.version != proposal['expected_version'] or permission_snapshot(store,actor,work)!=proposal['_permissions']:
                error='intake_obsolete'
            newer=any(r.type==PROPOSAL_TYPE and r.result['work_id']==work_id and r.result['id']!=proposal['id'] and r.result.get('original_request','').startswith(original+'\n\n') for r in store.commands.values())
            if newer:
                error='intake_superseded'
            if error:
                proposal.update(status='failed',error_code=error)
            else:
                proposal.update(values,status='pending_confirmation')
                proposal.pop('error_code',None)
            proposal['changes']=changes
            proposal['digest']=digest(proposal)
        ctx.service.store=store
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
            if require_capability(proposal['capability']).kind == 'executable' and not (selected or proposal['new_agent']):
                raise ValidationError('Propose a collaborator before confirming CSV work')
            service=ctx.service.for_store(store)
            owner=selected['id'] if selected else work.owner_id
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
