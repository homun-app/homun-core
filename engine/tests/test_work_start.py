"""Avvio di un lavoro confermato: il motore sceglie l'esecutore, mai il client.

La UI (e il percorso d'oro) chiamano solo `work_start.start` / `approve` /
`current`: l'esecutore (sintesi, lettura, confronto, run adattivo) segue la
fase corrente del piano o la capability dell'accordo, e la modalità di
autonomia decide se l'avvio è immediato o chiede il via libera.
"""
import pytest

from homun.application.work import work_start
from homun.application.work.material_ingest import ingest_file
from homun.application.work.synthesis_execution import execute as execute_synthesis
from homun.context import create_context
from homun.domain.capabilities import REGISTRY, starts_without_approval
from homun.domain.errors import ConflictError, ValidationError
from homun.domain.models import Actor
from intake_setup import front_door_intake


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    service = ctx.service
    project = service.apply(actor, 'project', 'project.create', {'name': 'Fornitori'})['project_id']
    conv = service.apply(actor, 'conversation', 'conversation.create',
                         {'title': 'Fornitori', 'project_id': project})['conversation_id']
    work = service.apply(actor, 'work', 'work.create', {
        'conversation_id': conv, 'title': 'Nota Rossi', 'objective': 'Nota operativa sul rinnovo'})['work_id']
    ctx.persist()
    yield ctx, actor, work, project
    ctx.close()


def _confirm(ctx, actor, work, *, capability='synthesize', plan_steps=None):
    front_door_intake(ctx, actor, work, {
        'title': 'Nota operativa rinnovo Rossi', 'objective': 'Preparare la nota operativa sul rinnovo.',
        'output': 'Nota operativa in Markdown', 'constraints': ['scadenza 30 novembre'],
        'missing_information': [], 'suggested_agent_id': None, 'new_agent': None,
        'rationale': 'Redazione', 'capability': capability, 'plan_steps': plan_steps or [],
    }, text='Prepara la nota operativa sul rinnovo Rossi')


def _ingest(ctx, actor, project, name, text):
    return ingest_file(ctx, actor, command_id=f'ingest-{name}', project_id=project,
                       filename=name, data=text.encode())['material_id']


# -- la regola delle modalità ---------------------------------------------------

def test_mode_rule_lives_in_the_capability_registry():
    executables = [cid for cid, spec in REGISTRY.items() if spec.kind == 'executable']
    assert executables, 'il registro deve avere capability eseguibili'
    for capability in executables:
        assert starts_without_approval(capability, 'autonomous') is True
        assert starts_without_approval(capability, 'supervised') is False
        # Nessuna capability registrata oggi ha effetti esterni: con guardrail parte.
        assert starts_without_approval(capability, 'guarded') is True
    with pytest.raises(ValidationError):
        starts_without_approval('synthesize', 'yolo')


# -- sintesi: la capability più comune ----------------------------------------

def test_guarded_synthesis_starts_by_itself_and_produces_a_result(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work)
    view = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    assert view['kind'] == 'synthesis'
    assert view['status'] == 'queued'
    assert view['auto_started'] is True
    execute_synthesis(ctx, view['id'])
    current = work_start.current(ctx, actor, work)
    assert current['kind'] == 'synthesis'
    assert current['status'] == 'completed'
    assert current['work_status'] == 'review'
    assert current['artifact'] and current['artifact']['content']


def test_supervised_synthesis_waits_for_the_go_ahead(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work)
    view = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'supervised'})
    assert view['status'] == 'pending_approval'
    assert view['auto_started'] is False
    assert ctx.repository.load().works[work].status == 'draft'
    approved = work_start.approve(ctx, actor, work, view['id'], {
        'command_id': 'go', 'digest': view['digest'], 'expected_version': view['expected_version']})
    assert approved['status'] == 'queued'


def test_synthesis_reads_the_project_materials_by_default(setup):
    ctx, actor, work, project = setup
    first = _ingest(ctx, actor, project, 'contratto.md', 'Disdetta entro il 1 ottobre. Legale: Marco Bianchi.')
    second = _ingest(ctx, actor, project, 'budget.md', 'Budget massimo 12.000 euro.')
    _confirm(ctx, actor, work)
    view = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    assert sorted(view['material_ids']) == sorted([first, second])


def test_explicit_materials_win_over_the_project_default(setup):
    ctx, actor, work, project = setup
    first = _ingest(ctx, actor, project, 'contratto.md', 'Disdetta entro il 1 ottobre.')
    _ingest(ctx, actor, project, 'altro.md', 'Altro testo.')
    _confirm(ctx, actor, work)
    view = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded',
                                               'material_ids': [first]})
    assert view['material_ids'] == [first]


# -- run adattivo: accordo «general» senza fasi --------------------------------

def test_general_agreement_runs_the_adaptive_agent(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work, capability='general')
    view = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'autonomous'})
    assert view['kind'] == 'agent_run'
    assert view['auto_started'] is True
    assert view['status'] != 'pending_approval'


# -- lettura di un materiale: serve sapere QUALE ------------------------------

def test_material_read_uses_the_only_readable_material(setup):
    ctx, actor, work, project = setup
    only = _ingest(ctx, actor, project, 'contratto.md', 'Disdetta entro il 1 ottobre.')
    _confirm(ctx, actor, work, capability='read_material')
    view = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    assert view['kind'] == 'material_read'
    assert view['material_ids'] == [only]


def test_material_read_with_several_materials_asks_which_one(setup):
    ctx, actor, work, project = setup
    _ingest(ctx, actor, project, 'a.md', 'Primo.')
    _ingest(ctx, actor, project, 'b.md', 'Secondo.')
    _confirm(ctx, actor, work, capability='read_material')
    with pytest.raises(ValidationError) as exc:
        work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    assert exc.value.reason == 'work.start.materials_required'


# -- regole d'ingresso ----------------------------------------------------------

def test_a_work_without_a_confirmed_agreement_cannot_start(setup):
    ctx, actor, work, _project = setup
    with pytest.raises(ConflictError) as exc:
        work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    assert exc.value.reason == 'work.start.agreement_required'


def test_unknown_mode_is_rejected(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work)
    with pytest.raises(ValidationError):
        work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'yolo'})


def test_start_is_idempotent_and_never_doubles_an_active_execution(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work)
    first = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    again = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    other = work_start.start(ctx, actor, work, {'command_id': 'start-2', 'mode': 'guarded'})
    assert again['id'] == first['id']
    assert other['id'] == first['id']


def test_current_is_empty_before_any_execution(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work)
    current = work_start.current(ctx, actor, work)
    assert current['kind'] is None
    assert current['status'] == 'not_started'
    assert current['agreement_status'] == 'confirmed'


def test_a_correction_restarts_the_same_executor_with_a_new_version(setup):
    ctx, actor, work, _project = setup
    _confirm(ctx, actor, work)
    first = work_start.start(ctx, actor, work, {'command_id': 'start-1', 'mode': 'guarded'})
    execute_synthesis(ctx, first['id'])
    done = work_start.current(ctx, actor, work)
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            ctx.service.for_store(store).apply(actor, 'review-1', 'work.review', {
                'work_id': work, 'expected_version': store.works[work].version,
                'artifact_version_id': done['artifact']['id'], 'decision': 'request_changes',
                'comment': 'Aggiungi una sezione Rischi.'})
        ctx.service.store = store
    second = work_start.start(ctx, actor, work, {'command_id': 'start-2', 'mode': 'guarded'})
    assert second['kind'] == 'synthesis'
    assert second['id'] != first['id']
    execute_synthesis(ctx, second['id'])
    after = work_start.current(ctx, actor, work)
    assert after['artifact']['version'] > done['artifact']['version']
