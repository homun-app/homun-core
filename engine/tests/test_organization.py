import json
from types import SimpleNamespace
import pytest
from homun.context import create_context
from homun.domain.models import Actor
from homun.domain.errors import ConflictError

@pytest.fixture
def setup(tmp_path):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='fabio', workspace_id='ws_local', display_name='Fabio')
    proposal = dict(name='Operations', description='Supporto', agents=[dict(name='Ada',role='Analisi',instructions='Analizza solo materiali autorizzati.',capabilities=['read_material'],tools_required=['CSV caricati'])], questions=[], limitations=['Nessuna integrazione collegata'])
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text=json.dumps(proposal))
    yield ctx, actor, proposal
    ctx.close()

def draft(ctx, actor, revision=0, command='draft'):
    from homun.application.organization import update_context
    return update_context(ctx, actor, dict(command_id=command,expected_revision=revision,company='Azienda servizi',people='Fabio coordina',tools='Email',goals='Ridurre lavoro manuale'))

def test_draft_persists_and_is_actor_scoped(setup):
    from homun.application.organization import get_state
    ctx, actor, _ = setup
    draft(ctx, actor)
    assert get_state(ctx.snapshot(), actor)['context']['company'] == 'Azienda servizi'
    assert get_state(ctx, Actor(id='other',workspace_id='ws_local',display_name='Other'))['revision'] == 0

def test_confirm_atomic_idempotent_no_creation_before_confirmation(setup):
    from homun.application.organization import propose, confirm
    ctx, actor, _ = setup
    draft(ctx,actor)
    p = propose(ctx, actor, dict(command_id='proposal',expected_revision=1))
    assert not ctx.repository.load().agents
    result = confirm(ctx, actor, dict(command_id='confirm',proposal_id=p['id'],expected_revision=1))
    assert confirm(ctx, actor, dict(command_id='again',proposal_id=p['id'],expected_revision=1)) == result
    store = ctx.repository.load()
    assert len(store.agents) == len(store.teams) == 1
    assert next(iter(store.agents.values())).instructions == 'Analizza solo materiali autorizzati.'
    assert next(iter(store.teams.values())).member_ids == result['agent_ids']

def test_stale_context_rejects_proposal(setup):
    from homun.application.organization import propose, confirm
    ctx, actor, _ = setup
    draft(ctx,actor)
    p = propose(ctx,actor,dict(command_id='proposal',expected_revision=1))
    draft(ctx,actor,1,'revision')
    with pytest.raises(ConflictError):
        confirm(ctx,actor,dict(command_id='confirm',proposal_id=p['id'],expected_revision=1))
    assert not ctx.repository.load().agents

@pytest.mark.parametrize('invalid', [True, False])
def test_model_errors_are_durable_without_creation(setup, invalid):
    from homun.application.organization import propose, get_state
    ctx, actor, proposal = setup
    draft(ctx,actor)
    if invalid:
        proposal['agents'][0]['capabilities'] = ['magic_email']
    else:
        ctx.models.complete = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('secret'))
    p = propose(ctx,actor,dict(command_id='proposal',expected_revision=1))
    assert p['status'] == 'failed'
    assert p['error_code'] == ('organization_invalid_response' if invalid else 'organization_provider_failed')
    assert get_state(ctx,actor)['proposal'] == p
    assert not ctx.repository.load().agents

def test_rejects_foreign_confirmation_and_command_reuse(setup):
    from homun.application.organization import propose, confirm
    ctx, actor, _ = setup
    draft(ctx,actor)
    p = propose(ctx,actor,dict(command_id='proposal',expected_revision=1))
    other = Actor(id='other',workspace_id='ws_local',display_name='Other')
    with pytest.raises(ConflictError):
        confirm(ctx,other,dict(command_id='confirm',proposal_id=p['id'],expected_revision=1))
    with pytest.raises(ConflictError):
        draft(ctx,actor,1,'proposal')
    assert not ctx.repository.load().agents

def test_confirmation_rolls_back_partial_agent_creation(setup, monkeypatch):
    from homun.application.organization import propose, confirm
    from homun.domain.service import DomainService
    ctx, actor, _ = setup
    draft(ctx,actor)
    p = propose(ctx,actor,dict(command_id='proposal',expected_revision=1))
    original = DomainService.apply
    def fail_team(self, actor, command, kind, payload):
        if kind == 'team.create':
            raise RuntimeError('injected storage boundary failure')
        return original(self,actor,command,kind,payload)
    monkeypatch.setattr(DomainService,'apply',fail_team)
    with pytest.raises(RuntimeError):
        confirm(ctx,actor,dict(command_id='confirm',proposal_id=p['id'],expected_revision=1))
    store = ctx.repository.load()
    assert not store.agents and not store.teams
    assert store.commands[p['id']].result['status'] == 'pending_confirmation'

def test_context_change_during_provider_call_invalidates_result(setup):
    from homun.application.organization import propose
    ctx,actor,proposal = setup
    draft(ctx,actor)
    def model(*args,**kwargs):
        draft(ctx,actor,1,'new-context')
        return SimpleNamespace(text=json.dumps(proposal))
    ctx.models.complete = model
    p = propose(ctx,actor,dict(command_id='proposal',expected_revision=1))
    assert p['error_code'] == 'organization_obsolete'

def test_routes_preserve_actor_boundary_and_validate_context(setup):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import reset_context_for_tests
    ctx,actor,_ = setup
    reset_context_for_tests(ctx)
    with TestClient(create_app()) as client:
        path = '/v1/workspaces/ws_local/organization'
        assert client.get(path).status_code == 401
        headers = {'X-Homun-Actor-Id':actor.id}
        response = client.post(path+'/context',headers=headers,json=dict(command_id='draft',expected_revision=0,company='Company'))
        assert response.status_code == 200
        assert client.get(path,headers=headers).json()['context']['company'] == 'Company'
        assert client.get('/v1/workspaces/other/organization',headers=headers).status_code == 404
        assert client.post(path+'/context',headers=headers,json=dict(command_id='too-long',expected_revision=1,company='x'*6001)).status_code == 422

@pytest.mark.parametrize('field', ['questions', 'limitations', 'tools_required'])
def test_proposal_text_items_are_bounded(setup, field):
    from homun.models.organization import TeamProposal
    from pydantic import ValidationError
    _,_,proposal = setup
    target = proposal['agents'][0] if field == 'tools_required' else proposal
    target[field] = ['x'*601]
    with pytest.raises(ValidationError):
        TeamProposal.model_validate(proposal)
