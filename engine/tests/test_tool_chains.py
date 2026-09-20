"""Tool chains: approval enumerates every effect; sequential durable execution."""
import json
from types import SimpleNamespace

import pytest

from homun.application.material_ingest import ingest_file
from homun.application.tool_chains import approve, list_chains, propose
from homun.context import create_context
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.domain.models import Actor


@pytest.fixture
def setup(tmp_path):
    ctx = create_context(db_path=tmp_path / 'ws.db', data_dir=tmp_path, for_tests=True)
    actor = Actor(id='person_fabio', workspace_id=ctx.workspace_id, display_name='Fabio')
    project = ctx.service.apply(actor, 'project', 'project.create', {'name': 'Synthetic'})['project_id']
    conv = ctx.service.apply(actor, 'conversation', 'conversation.create',
                             {'title': 'Docs', 'project_id': project})['conversation_id']
    work = ctx.service.apply(actor, 'work', 'work.create',
                             {'conversation_id': conv, 'title': 'Docs', 'objective': 'Leggere'})['work_id']
    ctx.persist()
    materials = [ingest_file(ctx, actor, command_id=f'ing-{i}', project_id=project,
                             filename=f'doc{i}.txt', data=f'Documento {i}: contenuto di prova.'.encode())['material_id']
                 for i in range(3)]
    # Confirmed read_material intake so the chain is admitted.
    brief = {'title': 'Lettura documenti', 'objective': 'Leggere i materiali caricati.',
             'output': 'Artifact di lettura', 'constraints': [], 'missing_information': [],
             'suggested_agent_id': None, 'new_agent': {'name': 'Lettore', 'role': 'Lettura',
                                                       'instructions': 'Legge i materiali autorizzati'},
             'rationale': 'ok', 'capability': 'read_material'}
    ctx.models.complete = lambda *_a, **_k: SimpleNamespace(text=json.dumps(brief))
    from homun.application.intake import confirm as intake_confirm
    from homun.application.intake import propose as intake_propose
    p = intake_propose(ctx, actor, work, {'command_id': 'intake', 'text': 'Leggi i documenti', 'expected_version': 1})
    intake_confirm(ctx, actor, work, p['id'], {'command_id': 'staff', 'digest': p['digest'],
                                               'expected_version': 1, 'create_agent': True})
    yield ctx, actor, work, materials
    ctx.close()


def steps(materials):
    return [{'capability': 'read_material', 'material_id': mid} for mid in materials]


def test_chain_of_reads_completes_with_one_artifact_per_step(setup):
    ctx, actor, work, materials = setup
    chain = propose(ctx, actor, work, {'command_id': 'ch', 'steps': steps(materials[:2]), 'expected_version': 2})
    assert chain['status'] == 'pending_approval'
    assert len(chain['steps']) == 2 and all(s['tool_version'] == 'material-read-v1' for s in chain['steps'])
    approve(ctx, actor, work, 'ch', {'command_id': 'ok', 'digest': chain['digest'], 'expected_version': 2})
    from homun.runtime.workflows.tool_chain import run_chain
    run_chain(ctx, chain['steps'])
    store = ctx.repository.load()
    assert store.works[work].status == 'review'
    assert len(store.artifacts) == 2
    statuses = [store.commands[s['proposal_id']].result['status'] for s in chain['steps']]
    assert statuses == ['completed', 'completed']
    assert list_chains(ctx, actor, work)['items'][-1]['status'] == 'completed'


def test_wrong_digest_and_changed_source_invalidate_approval(setup):
    ctx, actor, work, materials = setup
    chain = propose(ctx, actor, work, {'command_id': 'ch', 'steps': steps(materials[:2]), 'expected_version': 2})
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, 'ch', {'command_id': 'bad', 'digest': 'wrong', 'expected_version': 2})
    ctx.service.apply(actor, 'bump', 'material.update',
                      {'material_id': materials[0], 'expected_version': 1, 'title': 'Doc0 v2'})
    ctx.persist()
    with pytest.raises(ConflictError):
        approve(ctx, actor, work, 'ch', {'command_id': 'ok', 'digest': chain['digest'], 'expected_version': 2})
    assert not ctx.repository.load().artifacts


def test_only_a_person_approves(setup):
    ctx, actor, work, materials = setup
    chain = propose(ctx, actor, work, {'command_id': 'ch', 'steps': steps(materials[:2]), 'expected_version': 2})
    agent = Actor(id=ctx.repository.load().works[work].owner_id, workspace_id=ctx.workspace_id,
                  display_name='Lettore', kind='agent')
    with pytest.raises(PermissionDeniedError):
        approve(ctx, agent, work, 'ch', {'command_id': 'no', 'digest': chain['digest'], 'expected_version': 2})


def test_chain_needs_admitted_capability_and_two_steps(setup):
    ctx, actor, work, materials = setup
    with pytest.raises(ValidationError):
        propose(ctx, actor, work, {'command_id': 'solo', 'steps': steps(materials[:1]), 'expected_version': 2})
    compare_step = [{'capability': 'compare_csv', 'left_material_id': materials[0],
                     'right_material_id': materials[1]},
                    {'capability': 'compare_csv', 'left_material_id': materials[1],
                     'right_material_id': materials[2]}]
    with pytest.raises(ConflictError):
        propose(ctx, actor, work, {'command_id': 'mix', 'steps': compare_step, 'expected_version': 2})


def test_failed_step_keeps_prior_artifacts_and_blocks_the_rest(setup, monkeypatch):
    ctx, actor, work, materials = setup
    chain = propose(ctx, actor, work, {'command_id': 'ch', 'steps': steps(materials), 'expected_version': 2})
    approve(ctx, actor, work, 'ch', {'command_id': 'ok', 'digest': chain['digest'], 'expected_version': 2})
    # Break the second source after approval: its revalidation at execution fails.
    import hashlib as _h
    from homun.domain.errors import ConflictError as CE
    from homun.application import material_read_execution as execution
    original = execution._running_authority
    calls = {'n': 0}

    second_id = chain['steps'][1]['proposal_id']
    def failing_second(ctx_, store_, proposal):
        if proposal is not None and getattr(proposal, 'get', lambda k: None)('id') == second_id:
            raise CE('Read source changed; create a new proposal')
        return original(ctx_, store_, proposal)
    monkeypatch.setattr(execution, '_running_authority', failing_second)
    from homun.runtime.workflows import tool_chain as wf
    # First step executes through the wrapper's authority path; force failure on step 2.
    wf.run_chain(ctx, chain['steps'])
    store = ctx.repository.load()
    statuses = [store.commands[s['proposal_id']].result['status'] for s in chain['steps']]
    assert statuses[0] == 'completed'
    assert statuses[1] in {'failed', 'blocked'}
    assert statuses[2] == 'blocked'
    assert len(store.artifacts) == 1
    assert list_chains(ctx, actor, work)['items'][-1]['status'] == 'failed'


def test_chain_survives_restart_dispatch(setup):
    """The approved command remains the intent: deliver re-enqueues with a stable id."""
    ctx, actor, work, materials = setup
    chain = propose(ctx, actor, work, {'command_id': 'ch', 'steps': steps(materials[:2]), 'expected_version': 2})
    approve(ctx, actor, work, 'ch', {'command_id': 'ok', 'digest': chain['digest'], 'expected_version': 2})
    store = ctx.repository.load()
    stored = store.commands['ch'].result
    assert stored['status'] == 'queued' and stored['_workflow_id'].startswith('chain:ws_local:ch')
    # Step proposals exist, queued, bound to the same sources the approval enumerated.
    for step in stored['steps']:
        record = store.commands[step['proposal_id']]
        assert record.result['status'] == 'queued'
        assert record.result['work_id'] == work
