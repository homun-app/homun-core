"""Policy-driven auto-approval: autonomous agents and cron jobs (supervision levels)."""
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


def _setup(ctx, actor, *, autonomy):
    agent = _apply(ctx, actor, 'ag', 'agent.create',
                   {'name': 'Atlas', 'autonomy_mode': autonomy})['agent_id']
    project = _apply(ctx, actor, 'p', 'project.create', {'name': 'Auto approve'})['project_id']
    conversation = _apply(ctx, actor, 'c', 'conversation.create',
                          {'title': 'Auto approve', 'project_id': project})['conversation_id']
    work = _apply(ctx, actor, 'w', 'work.create', {
        'conversation_id': conversation, 'title': 'Gate', 'objective': 'Do the thing.'})['work_id']
    version = ctx.repository.load().works[work].version
    _apply(ctx, actor, 'pl', 'plan.propose', {'work_id': work, 'expected_version': version, 'steps': [
        {'title': 'Do', 'assignee_id': agent, 'capability': 'agent_run'}]})
    version = ctx.repository.load().works[work].version
    _apply(ctx, actor, 'pl2', 'plan.accept', {'work_id': work, 'expected_version': version})
    return agent, work


def _propose(ctx, actor, work):
    from homun.application.agent_runs import propose
    version = ctx.repository.load().works[work].version
    return propose(ctx, actor, work, {'command_id': 'run:auto', 'expected_version': version,
                                      'material_ids': []})


def test_sweep_auto_approves_run_for_autonomous_agent(ctx):
    from homun.application.approval_auto import sweep, POLICY_CHANNEL
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    agent, work = _setup(ctx, actor, autonomy='autonomous')
    proposal = _propose(ctx, actor, work)
    assert proposal['status'] == 'pending_approval'
    assert sweep(ctx, proposal['id']) is True
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'queued'
    assert run['_approval_channel'] == POLICY_CHANNEL
    # Idempotent: a second sweep does not touch the queued run.
    assert sweep(ctx, proposal['id']) is False


def test_sweep_leaves_supervised_agent_pending(ctx):
    from homun.application.approval_auto import sweep
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    agent, work = _setup(ctx, actor, autonomy='supervised')
    proposal = _propose(ctx, actor, work)
    assert sweep(ctx, proposal['id']) is False
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'pending_approval'
    assert '_approval_channel' not in run


def test_terminal_local_policy_never_auto_approved(ctx):
    """Host execution keeps the human gate even for autonomous agents."""
    from homun.application import terminal_jobs
    from homun.application.approval_auto import sweep
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    agent, work = _setup(ctx, actor, autonomy='autonomous')
    proposal = _propose(ctx, actor, work)
    version = ctx.repository.load().works[work].version
    job = terminal_jobs.propose(ctx, actor, work, {
        'command_id': 'term:local', 'command': 'echo host', 'policy': 'local-private-v1',
        'expected_version': version})
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = store.commands[proposal['id']].result
            run['status'] = 'waiting_external'
            run['terminal_request_id'] = job['id']
        ctx.service.store = store
    assert sweep(ctx, proposal['id']) is False
    gate = ctx.repository.load().commands[job['id']].result
    assert gate['status'] == 'pending_approval'
    assert '_approval_channel' not in gate


def test_cron_job_auto_approve_starts_run(ctx, tmp_path):
    from homun.application.cron_agent_runner import make_cron_runner
    from homun.application.cron_manager import CronManager
    from homun.application.cron_manager import reset_store
    from homun.application.cron_store import CronStore, set_cron_store
    actor = Actor(id='person_cron', workspace_id=ctx.workspace_id, display_name='Owner')
    store = CronStore(tmp_path / 'cron.db')
    set_cron_store(store)
    try:
        mgr = CronManager(workspace_id=ctx.workspace_id, store=store)
        job = mgr.create_job('5m', prompt='Segna l\'esecuzione', repeat=1,
                             owner_actor=actor.model_dump(mode='json'), auto_approve=True)
        runner = make_cron_runner(ctx)
        claim = mgr.claim_job_for_fire(job.id, now=20)
        occ = mgr.run_job(job.id, now=20, claim=claim, custom_runner=runner)
        assert occ.status == 'running'
        run = ctx.repository.load().commands[occ.agent_run_id].result
        assert run['status'] == 'queued'
        assert run['_approval_channel'] == 'policy:cron-auto-approve'
    finally:
        reset_store()


def test_cron_job_without_auto_approve_keeps_gate(ctx, tmp_path):
    from homun.application.cron_agent_runner import make_cron_runner
    from homun.application.cron_manager import CronManager
    from homun.application.cron_manager import reset_store
    from homun.application.cron_store import CronStore, set_cron_store
    actor = Actor(id='person_cron', workspace_id=ctx.workspace_id, display_name='Owner')
    store = CronStore(tmp_path / 'cron.db')
    set_cron_store(store)
    try:
        mgr = CronManager(workspace_id=ctx.workspace_id, store=store)
        job = mgr.create_job('5m', prompt='Segna l\'esecuzione', repeat=1,
                             owner_actor=actor.model_dump(mode='json'))
        runner = make_cron_runner(ctx)
        claim = mgr.claim_job_for_fire(job.id, now=20)
        occ = mgr.run_job(job.id, now=20, claim=claim, custom_runner=runner)
        assert occ.status == 'awaiting_approval'
        run = ctx.repository.load().commands[occ.agent_run_id].result
        assert run['status'] == 'pending_approval'
        assert '_approval_channel' not in run
    finally:
        reset_store()


def test_delivery_sweep_hook_auto_approves_autonomous_run(ctx):
    """The delivery loop hook (not just direct sweep calls) must approve."""
    from homun.runtime.workflows.agent_run import deliver_agent_runs
    actor = Actor(id='person_owner', workspace_id=ctx.workspace_id, display_name='Owner')
    agent, work = _setup(ctx, actor, autonomy='autonomous')
    proposal = _propose(ctx, actor, work)
    deliver_agent_runs(ctx)
    run = ctx.repository.load().commands[proposal['id']].result
    assert run['status'] == 'queued'
    assert run['_approval_channel'] == 'policy:autonomy_mode=autonomous'
