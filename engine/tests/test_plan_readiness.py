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


def test_approving_intermediate_phase_advances_instead_of_completing(setup):
    ctx, actor = setup
    from homun.application.intake import propose, confirm
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'L'})
    work = ctx.service.apply(actor, 'w', 'work.create', {'conversation_id': conv['conversation_id'], 'title': 'L', 'objective': 'Confrontare.'})
    agent = ctx.service.apply(actor, 'a', 'agent.create', {'name': 'Ada', 'role': 'X', 'instructions': 'Y'})
    ctx.persist()
    brief = {'title': 'T', 'objective': 'O', 'output': 'R', 'constraints': [], 'missing_information': [],
             'suggested_agent_id': agent['agent_id'], 'new_agent': None, 'rationale': 'r', 'capability': 'general',
             'plan_steps': [{'title': 'Fase uno', 'capability': 'general', 'assignee': ''},
                            {'title': 'Fase due', 'capability': 'general', 'assignee': ''}]}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = propose(ctx, actor, work['work_id'], {'command_id': 'i', 'text': 'due fasi', 'expected_version': 1})
    confirm(ctx, actor, work['work_id'], 'i', {'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': False})
    wid = work['work_id']
    store = ctx.service.store
    ver = store.works[wid].version
    started = ctx.service.apply(actor, 's', 'work.start', {'work_id': wid, 'expected_version': ver})
    art = ctx.service.apply(actor, 'a1', 'work.submit_artifact', {'work_id': wid, 'expected_version': started['version'], 'title': 'Esito fase uno', 'content': 'contenuto'})
    reviewed = ctx.service.apply(actor, 'r1', 'work.review', {'work_id': wid, 'expected_version': art['version'], 'artifact_version_id': art['artifact_id'], 'decision': 'approve'})
    assert reviewed['status'] == 'ready'  # avanzamento, non completamento
    plan = store.plans[store.plan_key(wid, store.works[wid].current_plan_revision)]
    assert [s.status.value for s in plan.steps] == ['succeeded', 'pending']
    texts = [m.text for m in store.messages.values() if m.conversation_id == conv['conversation_id']]
    assert any('Prossima: «Fase due»' in t for t in texts)
    started2 = ctx.service.apply(actor, 's2', 'work.start', {'work_id': wid, 'expected_version': reviewed['version']})
    art2 = ctx.service.apply(actor, 'a2', 'work.submit_artifact', {'work_id': wid, 'expected_version': started2['version'], 'title': 'Esito finale', 'content': 'finale'})
    done = ctx.service.apply(actor, 'r2', 'work.review', {'work_id': wid, 'expected_version': art2['version'], 'artifact_version_id': art2['artifact_id'], 'decision': 'approve'})
    assert done['status'] == 'completed'
    texts = [m.text for m in ctx.service.store.messages.values() if m.conversation_id == conv['conversation_id']]
    assert any('Lavoro completato' in t for t in texts)


def test_contribution_resolves_its_phase_and_announces_next(setup):
    ctx, actor = setup
    from homun.application.intake import propose, confirm
    conv = ctx.service.apply(actor, 'c', 'conversation.create', {'title': 'L'})
    work = ctx.service.apply(actor, 'w', 'work.create', {'conversation_id': conv['conversation_id'], 'title': 'L', 'objective': 'Raccogliere.'})
    agent = ctx.service.apply(actor, 'a', 'agent.create', {'name': 'Ada', 'role': 'X', 'instructions': 'Y'})
    ctx.persist()
    brief = {'title': 'T', 'objective': 'O', 'output': 'R', 'constraints': [], 'missing_information': [],
             'suggested_agent_id': agent['agent_id'], 'new_agent': None, 'rationale': 'r', 'capability': 'general',
             'plan_steps': [{'title': 'Raccolta', 'capability': 'general', 'assignee': ''},
                            {'title': 'Confronto', 'capability': 'compare_csv', 'assignee': ''}]}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = propose(ctx, actor, work['work_id'], {'command_id': 'i', 'text': 'fasi', 'expected_version': 1})
    confirm(ctx, actor, work['work_id'], 'i', {'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': False})
    wid = work['work_id']
    store = ctx.service.store
    ver = store.works[wid].version
    started = ctx.service.apply(actor, 's', 'work.start', {'work_id': wid, 'expected_version': ver})
    store = ctx.service.store
    plan = store.plans[store.plan_key(wid, store.works[wid].current_plan_revision)]
    asked = ctx.service.apply(actor, 'rc', 'work.request_contribution',
                              {'work_id': wid, 'expected_version': started['version'],
                               'step_id': plan.steps[0].id, 'to_actor_id': actor.id, 'need': 'i listini'})
    request = next(r for r in ctx.service.store.contributions.values() if r.work_id == wid and r.status == 'pending')
    provided = ctx.service.apply(actor, 'pc', 'work.provide_contribution', {'request_id': request.id, 'expected_version': asked['version'], 'text': 'eccoli'})
    assert provided['status'] == 'ready'
    store = ctx.service.store
    plan = store.plans[store.plan_key(wid, store.works[wid].current_plan_revision)]
    assert plan.steps[0].status.value == 'succeeded' and plan.steps[1].status.value == 'pending'
    texts = [m.text for m in store.messages.values() if m.conversation_id == conv['conversation_id']]
    assert any('Fase «Raccolta» registrata' in t and '«Confronto»' in t for t in texts)


def test_phased_general_work_admits_comparison_on_its_phase(setup):
    """A 'general' agreement with a compare_csv phase prepares and runs the real
    comparison on that phase: no second plan, the approval is the phase's go."""
    import json
    from types import SimpleNamespace
    from homun.application.material_ingest import ingest_file
    from homun.application.intake import propose as intake_propose, confirm as intake_confirm
    from homun.application.price_comparisons import propose as cmp_propose, approve as cmp_approve
    from homun.application.price_comparison_execution import execute as cmp_execute
    ctx, actor = setup
    project = ctx.service.apply(actor, 'pp', 'project.create', {'name': 'P'})['project_id']
    ctx.persist()
    materials = [ingest_file(ctx, actor, command_id=f'ing{i}', project_id=project,
                             filename=f'list-{i}.csv', data=f'sku,name,price,currency\nA,Alpha,{10+i},EUR\n'.encode())['material_id'] for i in range(2)]
    conv = ctx.service.apply(actor, 'cc', 'conversation.create', {'title': 'L', 'project_id': project})
    work = ctx.service.apply(actor, 'ww', 'work.create', {'conversation_id': conv['conversation_id'], 'title': 'L', 'objective': 'Confrontare.'})
    agent = ctx.service.apply(actor, 'aa', 'agent.create', {'name': 'Ada', 'role': 'X', 'instructions': 'Y'})
    ctx.persist()
    brief = {'title': 'T', 'objective': 'O', 'output': 'R', 'constraints': [], 'missing_information': [],
             'suggested_agent_id': agent['agent_id'], 'new_agent': None, 'rationale': 'r', 'capability': 'general',
             'plan_steps': [{'title': 'Raccolta', 'capability': 'general', 'assignee': ''},
                            {'title': 'Confronto', 'capability': 'compare_csv', 'assignee': ''}]}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    p = intake_propose(ctx, actor, work['work_id'], {'command_id': 'i', 'text': 'due fasi', 'expected_version': 1})
    intake_confirm(ctx, actor, work['work_id'], 'i', {'command_id': 'ok', 'digest': p['digest'], 'expected_version': 1, 'create_agent': False})
    wid = work['work_id']
    store = ctx.service.store
    assert store.works[wid].current_plan_revision == 1  # il piano delle fasi
    # completa la fase umana via contributo, come nel flusso reale
    started = ctx.service.apply(actor, 's', 'work.start', {'work_id': wid, 'expected_version': store.works[wid].version})
    asked = ctx.service.apply(actor, 'rc', 'work.request_contribution',
                              {'work_id': wid, 'expected_version': started['version'],
                               'step_id': store.plans[store.plan_key(wid, 1)].steps[0].id, 'to_actor_id': actor.id, 'need': 'i listini'})
    request = next(r for r in ctx.service.store.contributions.values() if r.work_id == wid and r.status == 'pending')
    ctx.service.apply(actor, 'pc', 'work.provide_contribution', {'request_id': request.id, 'expected_version': asked['version'], 'text': 'pronti'})
    ctx.persist()
    store = ctx.service.store
    cmp_p = cmp_propose(ctx, actor, wid, {'command_id': 'cp', 'left_material_id': materials[0],
                                          'right_material_id': materials[1], 'expected_version': store.works[wid].version})
    assert store.works[wid].current_plan_revision == 1  # nessun secondo piano
    assert cmp_p['expected_version'] == store.works[wid].version
    cmp_approve(ctx, actor, wid, cmp_p['id'], {'command_id': 'ca', 'digest': cmp_p['digest'], 'expected_version': cmp_p['expected_version']})
    store = ctx.service.store
    assert store.works[wid].status.value == 'running'
    plan = store.plans[store.plan_key(wid, 1)]
    assert plan.steps[0].status.value == 'succeeded' and plan.steps[1].status.value == 'running'
    cmp_execute(ctx, cmp_p['id'])
    store = ctx.service.store
    assert store.works[wid].status.value == 'review'
    plan = store.plans[store.plan_key(wid, store.works[wid].current_plan_revision)]
    assert plan.steps[1].status.value == 'succeeded'
    assert len(store.artifacts) == 1

