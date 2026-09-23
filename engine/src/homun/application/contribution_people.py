"""Named local recipients, not accounts, invites, or access grants."""
from copy import deepcopy
from homun.application.price_comparisons import cached, save
from homun.application.contribution_invitations import _owner
from homun.domain.errors import PermissionDeniedError, ValidationError, ConflictError
from homun.domain.ids import new_id
from homun.policy import require_workspace_actor

KIND = 'person.define'

def _people(store,actor):
    require_workspace_actor(actor,store.workspace_id)
    if actor.kind != 'person':
        raise PermissionDeniedError('Only people may define recipients')
    return [r.result for r in store.commands.values() if r.type == KIND and r.actor_id == actor.id]

def list_people(ctx,actor):
    return {'items':deepcopy(_people(ctx.repository.load(),actor))}

def create_person(ctx,actor,body):
    name = str(body.get('name','')).strip()
    if not name or len(name)>120:
        raise ValidationError('Name requires 1-120 characters')
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            people = _people(store,actor)
            prior,fingerprint = cached(store,actor,body['command_id'],KIND,body)
            if prior:
                return deepcopy(prior.result)
            person = next((p for p in people if p['name'].casefold() == name.casefold()),None)
            if person:
                return deepcopy(person)
            person = {'id':new_id('person'),'name':name}
            save(store,actor,body['command_id'],KIND,fingerprint,person)
        ctx.service.store = store
    return deepcopy(person)

def request_contribution(ctx,actor,work_id,body):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            work = _owner(store,actor,work_id)
            person = next((p for p in _people(store,actor) if p['id'] == body['person_id']),None)
            if person is None:
                raise ValidationError('Choose a defined person')
            # Never interrupt active provider/tool execution with a manual request.
            if any(r.work_id == work_id and r.status in {'running','queued'} for r in store.runs.values()):
                raise ConflictError('Wait for the active execution before asking a person')
            result = ctx.service.for_store(store).apply(actor,body['command_id'],'work.request_contribution',{
                'work_id':work.id,'expected_version':body['expected_version'],'step_id':body['step_id'],
                'to_actor_id':person['id'],'need':body['need']})
        ctx.service.store = store
    return deepcopy(result)
