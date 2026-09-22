"""Material-driven readiness announcements for planned works (slice F1)."""
import json
from types import SimpleNamespace
import pytest
from homun.context import create_context, reset_context_for_tests
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(workspace_id='ws_local', db_path=tmp_path/'ws.sqlite3', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id='ws_local', display_name='Fabio')
    reset_context_for_tests(ctx)
    yield ctx, actor
    reset_context_for_tests(None)
    ctx.close()


def _planned_ready_work(ctx, actor, project_id):
    """Confirmed intake with one executable phase: work READY with the accepted plan."""
    from homun.application.intake import propose, confirm
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'Lavoro listini', 'project_id': project_id})
    work = ctx.service.apply(actor, 'w', 'work.create', {'conversation_id': conv['conversation_id'], 'title': 'Lavoro listini', 'objective': 'Confrontare i listini.'})
    agent = ctx.service.apply(actor, 'a', 'agent.create', {'name': 'Ada', 'role': 'Analisi CSV', 'instructions': 'Confronta dati'})
    ctx.persist()
    brief = {'title': 'Confronto listini', 'objective': 'Confrontare i listini.', 'output': 'Report',
             'constraints': [], 'missing_information': [], 'suggested_agent_id': agent['agent_id'],
             'new_agent': None, 'rationale': 'ruolo analitico', 'capability': 'compare_csv',
             'plan_steps': [{'title': 'Confrontare i listini', 'capability': 'compare_csv',
                             'expected_materials': [], 'output_expected': 'Report differenze', 'assignee': 'Ada'}]}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = propose(ctx, actor, work['work_id'], {'command_id': 'i', 'text': 'Confronta i listini', 'expected_version': 1})
    confirm(ctx, actor, work['work_id'], 'i', {'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': False})
    return work['work_id'], conv['conversation_id']


def _ingest(ctx, actor, project_id, name, command_id):
    from homun.application.material_ingest import ingest_file
    return ingest_file(ctx, actor, command_id=command_id, project_id=project_id,
                       filename=name, data=f'sku,prezzo\n{name},10\n'.encode(), mime_type='text/csv')


def test_ingest_announces_ready_step_once(setup):
    ctx, actor = setup
    from homun.application.plan_readiness import ANNOUNCE_PREFIX
    project = ctx.service.apply(actor, 'pa', 'project.create', {'name': 'Acme'})['project_id']
    wid, conv_id = _planned_ready_work(ctx, actor, project)

    def announcements():
        store = ctx.repository.load()
        return [m.text for m in store.messages.values()
                if m.conversation_id == conv_id and m.text.startswith(ANNOUNCE_PREFIX)]

    _ingest(ctx, actor, project, 'marzo.csv', 'm1')
    assert announcements() == []  # one CSV is not enough for a comparison phase
    _ingest(ctx, actor, project, 'giugno.csv', 'm2')
    messages = announcements()
    assert len(messages) == 1 and 'Confrontare i listini' in messages[0]
    _ingest(ctx, actor, project, 'luglio.csv', 'm3')
    assert len(announcements()) == 1  # exactly once per step title


def test_first_ready_step_requires_work_project_materials(setup):
    ctx, actor = setup
    from homun.application.plan_readiness import first_ready_step
    project_a = ctx.service.apply(actor, 'pa', 'project.create', {'name': 'Acme'})['project_id']
    project_b = ctx.service.apply(actor, 'pb', 'project.create', {'name': 'Beta'})['project_id']
    wid, conv_id = _planned_ready_work(ctx, actor, project_a)
    _ingest(ctx, actor, project_b, 'altro.csv', 'mb1')
    _ingest(ctx, actor, project_b, 'altro2.csv', 'mb2')
    store = ctx.repository.load()
    assert first_ready_step(store, actor, store.works[wid]) is None  # other project's files do not count
    _ingest(ctx, actor, project_a, 'marzo.csv', 'ma1')
    _ingest(ctx, actor, project_a, 'giugno.csv', 'ma2')
    store = ctx.repository.load()
    step = first_ready_step(store, actor, store.works[wid])
    assert step is not None and step.capability == 'compare_csv'
