"""Actor-owned onboarding draft and atomic, explicitly confirmed team creation."""
from copy import deepcopy
from homun.application.price_comparisons import cached, save
from homun.domain.errors import ConflictError, ValidationError
from homun.models.organization import OrganizationContext, generate
from homun.policy import require_workspace_actor

DRAFT = 'organization.context'
PROPOSAL = 'organization.propose'

def _state(store, actor):
    require_workspace_actor(actor, store.workspace_id)
    if actor.kind != 'person':
        raise ValidationError('Organization onboarding requires a person')
    records = [r for r in store.commands.values() if r.actor_id == actor.id]
    drafts = [r.result for r in records if r.type == DRAFT]
    current = max(drafts, key=lambda d: d['revision']) if drafts else {'revision':0,'context':OrganizationContext().model_dump()}
    proposals = [r for r in records if r.type == PROPOSAL and r.result['revision'] == current['revision']]
    latest = max(proposals, key=lambda r:r.created_at).result if proposals else None
    return {**current, 'proposal':latest}

def get_state(ctx, actor):
    return deepcopy(_state(ctx.repository.load(), actor))

def update_context(ctx, actor, body):
    values = OrganizationContext.model_validate({k:body.get(k,'') for k in ('company','people','tools','goals')}).model_dump()
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = _state(store,actor)
            prior, fingerprint = cached(store,actor,body['command_id'],DRAFT,body)
            if prior:
                return deepcopy(prior.result)
            if current['revision'] != body['expected_revision']:
                raise ConflictError('Organization context changed; reload it')
            result = {'revision':current['revision']+1,'context':values}
            save(store,actor,body['command_id'],DRAFT,fingerprint,result)
        ctx.service.store = store
    return deepcopy(result)

def propose(ctx,actor,body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = _state(store,actor)
            prior,fingerprint = cached(store,actor,body['command_id'],PROPOSAL,body)
            if prior:
                return deepcopy(prior.result)
            if current['revision'] != body['expected_revision']:
                raise ConflictError('Organization context changed; reload it')
            if not any(current['context'].values()):
                raise ValidationError('Describe your organization first')
            result = {'id':body['command_id'],'revision':current['revision'],'status':'failed','error_code':'organization_interrupted','team':None}
            save(store,actor,body['command_id'],PROPOSAL,fingerprint,result)
        ctx.service.store = store
    try:
        team = generate(ctx.models,current['context'])
        error = None
    except (ValueError, TypeError):
        team, error = None, 'organization_invalid_response'
    except Exception:
        team, error = None, 'organization_provider_failed'
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            state = _state(store,actor)
            if state['revision'] != result['revision'] or state['proposal']['id'] != result['id']:
                error = 'organization_obsolete'
            result = store.commands[body['command_id']].result
            result.update(team=team,status='failed' if error else 'pending_confirmation',error_code=error)
        ctx.service.store = store
    return deepcopy(result)

def confirm(ctx,actor,body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            state = _state(store,actor)
            prior,fingerprint = cached(store,actor,body['command_id'],'organization.confirm',body)
            proposal = state['proposal']
            if not proposal or proposal['id'] != body['proposal_id'] or state['revision'] != body['expected_revision']:
                raise ConflictError('Proposal or context changed; generate a new proposal')
            if proposal['status'] == 'confirmed':
                return deepcopy(proposal)
            if proposal['status'] != 'pending_confirmation':
                raise ConflictError('Proposal is not ready for confirmation')
            service = ctx.service.for_store(store)
            agent_ids = []
            for i,profile in enumerate(proposal['team']['agents']):
                payload = {k:v for k,v in profile.items() if k != 'tools_required'}
                agent_ids.append(service.apply(actor,body['command_id']+f':agent:{i}','agent.create',payload)['agent_id'])
            team = service.apply(actor,body['command_id']+':team','team.create',{
                'name':proposal['team']['name'],'description':proposal['team']['description'],'member_ids':agent_ids,
                'coordinator_id':agent_ids[0]})
            proposal.update(status='confirmed',agent_ids=agent_ids,team_id=team['team_id'])
            save(store,actor,body['command_id'],'organization.confirm',fingerprint,proposal)
        ctx.service.store = store
    return deepcopy(proposal)
