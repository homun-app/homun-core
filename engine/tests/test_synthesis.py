"""Supervised model synthesis: approval, connection, provenance, budget, phases."""
import json
from types import SimpleNamespace

import pytest

from homun.application.synthesis import approve, list_proposals, propose
from homun.application.synthesis_execution import compose, execute
from homun.application.material_ingest import ingest_file
from homun.context import create_context
from homun.domain.errors import ConflictError
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    service = ctx.service
    project = service.apply(actor, 'project', 'project.create', {'name': 'Catalogo'})['project_id']
    conv = service.apply(actor, 'conversation', 'conversation.create', {'title': 'Catalogo', 'project_id': project})['conversation_id']
    work = service.apply(actor, 'work', 'work.create', {
        'conversation_id': conv, 'title': 'Catalogo prodotti', 'objective': 'Preparare il catalogo per Acme'})['work_id']
    ctx.persist()
    material = ingest_file(ctx, actor, command_id='ingest', project_id=project,
                           filename='listino.txt', data='Trapano PK150 euro 89,90\nTrapano PK200 euro 119,00'.encode())['material_id']
    yield ctx, actor, work, material
    ctx.close()


def confirmation(p):
    return dict(command_id='approve', digest=p['digest'], expected_version=p['expected_version'])


def confirm_intake(ctx, actor, work, *, capability='synthesize', plan_steps=None, agent_name='Redattrice'):
    from homun.application.intake import propose as intake_propose, confirm as intake_confirm
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps({
        'title': 'Catalogo prodotti Acme', 'objective': 'Preparare il catalogo per Acme dai listini.',
        'output': 'Bozza di catalogo in Markdown', 'constraints': ['prezzi dai listini caricati'],
        'missing_information': [], 'suggested_agent_id': None,
        'new_agent': {'name': agent_name, 'role': 'Redazione di cataloghi', 'instructions': 'Redige cataloghi dai listini'},
        'rationale': 'Redazione documentale', 'capability': capability,
        'plan_steps': plan_steps or [],
    }))
    p = intake_propose(ctx, actor, work, {'command_id': 'intake', 'text': 'Prepara il catalogo per Acme', 'expected_version': 1})
    intake_confirm(ctx, actor, work, p['id'], {'command_id': 'staff', 'digest': p['digest'],
                                               'expected_version': p['expected_version'], 'create_agent': True})
    return ctx.repository.load().works[work].version


def _agent_id(store, name):
    return next(a.id for a in store.agents.values() if a.name == name)


def test_synthesis_flows_to_review_with_provenance(setup):
    ctx, actor, work, material = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material], 'expected_version': version})
    assert p['status'] == 'pending_approval'
    assert p['tool_version'] == 'model-synthesis-v1'
    assert p['materials'][0]['id'] == material
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    execute(ctx, p['id'])  # DBOS replay: publication stays exactly once
    store = ctx.repository.load()
    assert store.works[work].status == 'review'
    assert len(store.artifacts) == 1
    artifact = next(iter(store.artifacts.values()))
    assert artifact.content.startswith('> Sintesi di Redattrice')
    assert 'connessione attiva dello spazio' in artifact.content  # honest fallback declared
    assert 'bozza in revisione' in artifact.content
    assert list_proposals(ctx, actor, work)['items'][0]['status'] == 'completed'
    assert list_proposals(ctx, actor, work)['items'][0]['summary']['connection'] == 'spazio'
    assert len([m for m in store.messages.values() if m.author_id == 'homun_engine']) == 1
    attempts = [a for a in ctx.models.attempts if a.purpose == 'synthesize']
    assert len(attempts) == 1 and attempts[0].status == 'ok'


def test_preferred_connection_is_honored_and_declared(setup):
    ctx, actor, work, material = setup
    version = confirm_intake(ctx, actor, work)
    store = ctx.repository.load()
    agent_id = _agent_id(store, 'Redattrice')
    ctx.service.apply(actor, 'conn', 'agent.update', {
        'agent_id': agent_id, 'expected_version': 1, 'preferred_connection_id': 'fake'})
    ctx.persist()
    seen = {}
    original = ctx.models.complete

    def spy(messages, *, connection_id=None, **kw):
        seen['connection_id'] = connection_id
        return original(messages, **kw)
    ctx.models.complete = spy
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material], 'expected_version': version})
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    assert seen['connection_id'] == 'fake'
    artifact = next(iter(ctx.repository.load().artifacts.values()))
    assert 'connessione del collaboratore' in artifact.content
    assert list_proposals(ctx, actor, work)['items'][0]['summary']['connection'] == 'collaboratore'


def test_wrong_digest_rejected_and_double_approval_safe(setup):
    ctx, actor, work, material = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material], 'expected_version': version})
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, p['id'], {**confirmation(p), 'digest': 'wrong'})
    approve(ctx, actor, work, p['id'], confirmation(p))
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    assert len(ctx.repository.load().artifacts) == 1


def test_requires_confirmed_matching_intake(setup):
    ctx, actor, work, material = setup
    confirm_intake(ctx, actor, work, capability='read_material')
    with pytest.raises(ConflictError):
        propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material],
                                   'expected_version': ctx.repository.load().works[work].version})


def test_phase_admission_on_multi_phase_plan(setup):
    """A 'general' agreement may carry a synthesize phase: the phase admits the tool."""
    ctx, actor, work, material = setup
    version = confirm_intake(ctx, actor, work, capability='general', plan_steps=[
        {'title': 'Raccogli i listini', 'capability': 'general', 'assignee': 'Redattrice',
         'output_expected': 'Listini caricati', 'expected_materials': ['listino']},
        {'title': 'Scrivi il catalogo', 'capability': 'synthesize', 'assignee': 'Redattrice',
         'output_expected': 'Catalogo bozza in Markdown'},
    ])
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material], 'expected_version': version})
    assert p['step_title'] == 'Scrivi il catalogo'
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    store = ctx.repository.load()
    assert store.works[work].status == 'review'
    artifact = next(iter(store.artifacts.values()))
    assert artifact.title == 'Sintesi · Scrivi il catalogo'


def test_model_failure_is_honest(setup):
    ctx, actor, work, material = setup
    version = confirm_intake(ctx, actor, work)

    def boom(*_a, **_k):
        raise RuntimeError('provider down')
    ctx.models.complete = boom
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material], 'expected_version': version})
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    store = ctx.repository.load()
    assert store.works[work].status == 'failed'
    assert list_proposals(ctx, actor, work)['items'][0]['error_code'] == 'synthesis_model_error'
    assert not store.artifacts
    attempts = [a for a in ctx.models.attempts if a.purpose == 'synthesize']
    assert len(attempts) == 1 and attempts[0].status == 'error'


def test_budget_counts_the_attempt(setup):
    ctx, actor, work, material = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [material], 'expected_version': version})
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    store = ctx.repository.load()
    budget = next(b for b in store.work_budgets.values() if b.work_id == work)
    assert budget.spent.attempts == 1
    assert not budget.pending


def test_compose_without_materials_is_allowed(setup):
    ctx, actor, work, _material = setup
    version = confirm_intake(ctx, actor, work)
    p = propose(ctx, actor, work, {'command_id': 'synth', 'material_ids': [], 'expected_version': version})
    assert p['materials'] == []
    approve(ctx, actor, work, p['id'], confirmation(p))
    execute(ctx, p['id'])
    artifact = next(iter(ctx.repository.load().artifacts.values()))
    assert artifact.content.startswith('> Sintesi di Redattrice')
