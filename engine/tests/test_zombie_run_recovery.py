"""Un run attivo il cui workflow DBOS è già terminale non deve restare zombie:
il delivery sweep lo chiude con un errore tipizzato invece di re-enqueuarlo
per sempre (l'id stabile deduplica in silenzio)."""
from __future__ import annotations

import pytest

from homun.context import create_context
from homun.domain.models import Actor


@pytest.fixture
def ctx(tmp_path):
    ctx = create_context(db_path=tmp_path / 'engine.db', data_dir=tmp_path, for_tests=True)
    yield ctx
    ctx.close()


def _apply(ctx, actor, command_id, kind, payload):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            result = ctx.service.for_store(store).apply(actor, command_id, kind, payload)
        ctx.service.store = store
    return result


def _queued_run(ctx, actor):
    from homun.application.agent_runs import propose
    agent = _apply(ctx, actor, 'ag', 'agent.create',
                   {'name': 'Atlas', 'autonomy_mode': 'autonomous'})['agent_id']
    project = _apply(ctx, actor, 'p', 'project.create', {'name': 'Zombie'})['project_id']
    conversation = _apply(ctx, actor, 'c', 'conversation.create',
                          {'title': 'Zombie', 'project_id': project})['conversation_id']
    work = _apply(ctx, actor, 'w', 'work.create', {
        'conversation_id': conversation, 'title': 'Gate', 'objective': 'Do the thing.'})['work_id']
    version = ctx.repository.load().works[work].version
    _apply(ctx, actor, 'pl', 'plan.propose', {'work_id': work, 'expected_version': version, 'steps': [
        {'title': 'Do', 'assignee_id': agent, 'capability': 'agent_run'}]})
    version = ctx.repository.load().works[work].version
    _apply(ctx, actor, 'pl2', 'plan.accept', {'work_id': work, 'expected_version': version})
    version = ctx.repository.load().works[work].version
    return propose(ctx, actor, work, {'command_id': 'run:zombie', 'expected_version': version,
                                      'material_ids': []}), work


def _deliver(ctx):
    from homun.runtime.workflows.agent_run import deliver_agent_runs
    deliver_agent_runs(ctx)


def test_cancelled_workflow_closes_queued_run(ctx, monkeypatch):
    from homun.runtime.workflows import work_run
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    proposal, _work = _queued_run(ctx, actor)
    _deliver(ctx)  # auto-approve del policy sweep: il run diventa queued
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'queued'

    monkeypatch.setattr(work_run, 'get_workflow_status', lambda _wf: 'CANCELLED')
    _deliver(ctx)
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'failed'
    assert run['error_code'] == 'agent_run_workflow_lost'


def test_succeeded_workflow_without_status_closes_run(ctx, monkeypatch):
    """Il workflow ha finito ma lo status non è stato scritto (restart finale)."""
    from homun.runtime.workflows import work_run
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    proposal, _work = _queued_run(ctx, actor)
    _deliver(ctx)
    assert ctx.repository.load().commands[proposal['id']].result['status'] == 'queued'

    monkeypatch.setattr(work_run, 'get_workflow_status', lambda _wf: 'SUCCESS')
    _deliver(ctx)
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'failed'
    assert run['error_code'] == 'agent_run_workflow_finished_unrecorded'


def test_running_workflow_is_not_touched(ctx, monkeypatch):
    from homun.runtime.workflows import work_run
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    proposal, _work = _queued_run(ctx, actor)
    _deliver(ctx)
    monkeypatch.setattr(work_run, 'get_workflow_status', lambda _wf: 'RUNNING')
    _deliver(ctx)
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'queued'
