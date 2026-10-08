"""Quality gates use approved terminal jobs, never the legacy shell runner."""
import json
import time
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_agent_automation_runtime import stores
from homun.application import agent_runs, terminal_jobs
from homun.application.agent_run_execution import advance
from homun.application.goal_manager import GoalManager
from homun.models.native_turn import NativeMessage


def start(setup, *, terminal=True, command='printf verified > gate-marker', policy=None):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    body = {'command_id':'run', 'expected_version':1, 'material_ids':[], 'goals':True}
    if terminal:
        body['terminal_backend'] = 'local'
    body.update(policy or {})
    p = agent_runs.propose(ctx, actor, work, body)
    agent_runs.approve(ctx, actor, work, p['id'], {'command_id':'approve', 'digest':p['digest'], 'expected_version':p['expected_version']})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', content='Result with evidence'), usage=None)
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text=json.dumps({'verdict':'done','reason':'verified'}), usage=None)
    manager = GoalManager(work)
    manager.set('Verify the result')
    manager.add_gate(command)
    return ctx, actor, work, p


def stage(s):
    ctx, actor, work, p = s
    assert advance(ctx, p['id']) == 'waiting_automation'
    jobs = terminal_jobs.list_for_work(ctx, actor, work)['items']
    assert len(jobs) == 1
    assert jobs[0]['status'] == 'pending_approval'
    assert not list(ctx.data_dir.rglob('gate-marker'))
    return jobs[0]


def reconcile(ctx, run_id):
    from homun.application.goal_terminal import resume
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if resume(ctx, run_id):
            return
        time.sleep(.02)
    pytest.fail('terminal receipt did not arrive')


def test_gate_real_process_approval_restart_no_replay(setup, monkeypatch):
    from homun.context import create_context
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        second.models.complete = ctx.models.complete
        second.models.complete_tools = lambda *a, **k: pytest.fail('Finish replay must not call the model')
        reconcile(second, p['id'])
        assert advance(second, p['id']) == 'completed'
        assert GoalManager(work).state.status == 'done'
        assert len(second.repository.load().artifacts) == 1
        assert len(terminal_jobs.list_for_work(second, actor, work)['items']) == 1
        assert [f.read_text() for f in ctx.data_dir.rglob('gate-marker')] == ['verified']
    finally:
        second.close()


@pytest.mark.parametrize('action', ['pause','steer','cancel'])
def test_controls_fence_gate_approval(setup, action):
    from homun.application.agent_control import control
    from homun.domain.errors import ConflictError
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    control(ctx, actor, work, p['id'], {'command_id':'control', 'action':action, 'text':'Review this first', 'expected_version':ctx.repository.load().works[work].version})
    with pytest.raises(ConflictError):
        terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    assert not list(ctx.data_dir.rglob('gate-marker'))


def test_missing_terminal_capability_is_typed_unavailable(setup):
    ctx, actor, work, p = start(setup, terminal=False)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert GoalManager(work).state.paused_reason == 'goal_gate_terminal_unavailable'
    assert ctx.repository.load().commands[p['id']].result['automation_wait']['reason'] == 'goal_gate_terminal_unavailable'
    assert not terminal_jobs.list_for_work(ctx, actor, work)['items']


def test_sequential_gates_use_separate_approval_and_canonical_run_files(setup):
    s = start(setup)
    ctx, actor, work, p = s
    GoalManager(work).add_gate('test "$(cat gate-marker)" = verified')
    first = stage(s)
    terminal_jobs.approve(ctx, actor, work, first['id'], {'digest':first['digest']})
    reconcile(ctx, p['id'])
    assert advance(ctx, p['id']) == 'waiting_automation'
    jobs = terminal_jobs.list_for_work(ctx, actor, work)['items']
    assert len(jobs) == 2
    second = next(j for j in jobs if j['id'] != first['id'])
    assert second['status'] == 'pending_approval'
    assert not ctx.repository.load().artifacts
    terminal_jobs.approve(ctx, actor, work, second['id'], {'digest':second['digest']})
    reconcile(ctx, p['id'])
    assert advance(ctx, p['id']) == 'completed'


@pytest.mark.parametrize('state', [
    {'status':'exited','exit_code':7},
    {'status':'exited','exit_code':0,'timed_out':True},
    {'status':'exited','exit_code':0,'oom_killed':True},
    {'status':'exited','exit_code':0,'error_code':'execution_unavailable'},
    {'status':'dead','exit_code':0},
    {'status':'outcome_unknown','exit_code':None},
])
def test_non_success_receipts_never_finish_or_replay(setup, monkeypatch, state):
    from test_terminal_jobs import Backend
    from homun.application.goal_terminal import resume
    backend = Backend()
    monkeypatch.setattr(terminal_jobs, 'backend_for', lambda *a: backend)
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    backend.state.update(state, running=False)
    resumed = resume(ctx, p['id'])
    if state['status'] == 'outcome_unknown':
        assert not resumed
        assert not resume(ctx, p['id'])
    else:
        assert resumed
        assert advance(ctx, p['id']) != 'completed'
        assert GoalManager(work).state.gates[0].attempts == 1
    assert not ctx.repository.load().artifacts
    assert sum(c[0] == 'start' for c in backend.calls) == 1


@pytest.mark.parametrize('change', ['replace_gate','pause','revision'])
def test_goal_configuration_fences_old_approval(setup, change):
    from homun.domain.errors import ConflictError
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    manager = GoalManager(work)
    if change == 'replace_gate':
        manager.clear_gates()
        manager.add_gate(job['command'])
    elif change == 'pause':
        manager.pause()
    else:
        with ctx.repository.locked(), ctx.repository.transaction() as store:
            store.commands[p['id']].result['_automation_revision'] = 1
    with pytest.raises(ConflictError):
        terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    assert not list(ctx.data_dir.rglob('gate-marker'))


def test_gate_wait_scheduler_does_not_wake_before_approval(setup, monkeypatch):
    from homun.application.agent_automation import wake_due_automation
    from homun.runtime.workflows import agent_run
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    assert wake_due_automation(ctx, now=10**12) == []
    queued = []
    monkeypatch.setattr(agent_run, 'start', lambda *a: queued.append(a))
    agent_run.deliver_agent_runs(ctx)
    assert not queued
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    deadline = time.monotonic() + 5
    while not queued and time.monotonic() < deadline:
        agent_run.deliver_agent_runs(ctx)
        time.sleep(.02)
    assert len(queued) == 1


@pytest.mark.parametrize('policy', [{'denied_tools':['terminal_execute']}, {'toolset':'readonly'}])
def test_pinned_policy_denies_goal_terminal(setup, policy):
    ctx, actor, work, p = start(setup, policy=policy)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert GoalManager(work).state.paused_reason == 'goal_gate_terminal_unavailable'
    assert ctx.repository.load().commands[p['id']].result['automation_wait']['reason'] == 'goal_gate_terminal_unavailable'
    assert terminal_jobs.list_for_work(ctx, actor, work)['items'] == []


def test_configuration_change_during_refresh_rejects_receipt(setup, monkeypatch):
    from test_terminal_jobs import Backend
    from homun.application.goal_terminal import resume
    from homun.domain.errors import ConflictError
    backend = Backend()
    monkeypatch.setattr(terminal_jobs, 'backend_for', lambda *a: backend)
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    backend.state.update(status='exited', exit_code=0)
    inspect = backend.inspect
    def changed(spec):
        GoalManager(work).add_gate('false')
        return inspect(spec)
    monkeypatch.setattr(backend, 'inspect', changed)
    assert resume(ctx, p['id'])
    assert '_goal_gate_cycle' not in ctx.repository.load().commands[p['id']].result
    assert not ctx.repository.load().artifacts


def test_crash_after_receipt_commit_reopens_without_replay(setup):
    from homun.context import create_context
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    reconcile(ctx, p['id'])
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        from homun.application.goal_terminal import resume
        assert not resume(second, p['id'])
        second.models.complete = ctx.models.complete
        second.models.complete_tools = lambda *a, **k: pytest.fail('Unexpected model replay')
        assert advance(second, p['id']) == 'completed'
        assert len(terminal_jobs.list_for_work(second, actor, work)['items']) == 1
    finally:
        second.close()


def test_missing_logs_wait_without_starting_again(setup, monkeypatch):
    from test_terminal_jobs import Backend
    from homun.application.goal_terminal import resume
    from homun.execution.contracts import ExecutionUnavailable
    backend = Backend()
    monkeypatch.setattr(terminal_jobs, 'backend_for', lambda *a: backend)
    s = start(setup)
    ctx, actor, work, p = s
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    backend.state.update(status='exited', exit_code=0)
    def unavailable(spec):
        raise ExecutionUnavailable('missing logs')
    monkeypatch.setattr(backend, 'logs', unavailable)
    assert not resume(ctx, p['id'])
    assert not resume(ctx, p['id'])
    assert sum(c[0] == 'start' for c in backend.calls) == 1
    assert not ctx.repository.load().artifacts


def test_wait_transition_never_reaches_legacy_shell(setup, monkeypatch):
    import homun.application.goal_manager as module
    s = start(setup)
    ctx, actor, work, p = s
    checks = iter([True, False, False])
    monkeypatch.setattr(GoalManager, 'is_waiting', lambda *a, **k: next(checks, False))
    monkeypatch.setattr(module, 'run_gate', lambda *a, **k: pytest.fail('Legacy shell invoked'))
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert not ctx.repository.load().artifacts


def test_expired_barrier_stages_gate_against_persisted_configuration(setup):
    s = start(setup)
    ctx, actor, work, p = s
    goal = GoalManager(work)
    goal.wait_for_seconds(1)
    goal.state.waiting_until = time.time() - 1
    goal._save()
    stage(s)


def test_reconfiguration_supersedes_gate_wait_and_proposes_fresh_approval(setup, monkeypatch):
    from homun.application.automation_configuration import configure, AutomationCommand
    from homun.runtime.workflows import agent_run
    s = start(setup)
    ctx, actor, work, p = s
    old = stage(s)
    configure(ctx, actor, work, p['id'], 'heartbeat', AutomationCommand(
        command_id='heartbeat', action='set', prompt='Watch', interval_seconds=60))
    queued = []
    monkeypatch.setattr(agent_run, 'start', lambda *a: queued.append(a))
    agent_run.deliver_agent_runs(ctx)
    assert len(queued) == 1
    assert advance(ctx, p['id']) == 'waiting_automation'
    jobs = terminal_jobs.list_for_work(ctx, actor, work)['items']
    assert len(jobs) == 2
    assert all(j['status'] == 'pending_approval' for j in jobs)
    from homun.domain.errors import ConflictError
    with pytest.raises(ConflictError):
        terminal_jobs.approve(ctx, actor, work, old['id'], {'digest':old['digest']})


def test_authority_change_blocks_goal_wait_with_typed_error(setup):
    from homun.runtime.workflows import agent_run
    s = start(setup)
    ctx, actor, work, p = s
    stage(s)
    with ctx.repository.locked(), ctx.repository.transaction() as store:
        store.works[work].version += 1
    agent_run.deliver_agent_runs(ctx)
    run = ctx.repository.load().commands[p['id']].result
    assert run['status'] == 'blocked'
    assert run['error_code']


def test_legacy_goal_without_revision_can_project_finish(setup):
    from homun.application.goal_store import get_goal_store
    s = start(setup)
    ctx, actor, work, p = s
    database = get_goal_store()
    with database._lock, database._conn:
        payload = GoalManager(work).state.to_dict()
        payload.pop('revision')
        database._conn.execute('UPDATE goals SET payload=? WHERE session_id=?', (json.dumps(payload), work))
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    reconcile(ctx, p['id'])
    assert advance(ctx, p['id']) == 'completed'
    assert GoalManager(work).state.status == 'done'


def test_zero_gate_retries_survive_reload_and_pause_on_first_failure(setup):
    s = start(setup, command='exit 7')
    ctx, actor, work, p = s
    manager = GoalManager(work)
    manager.clear_gates()
    manager.add_gate('exit 7', max_retries=0)
    assert GoalManager(work).state.gates[0].max_retries == 0
    job = stage(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest':job['digest']})
    reconcile(ctx, p['id'])
    assert advance(ctx, p['id']) == 'waiting_automation'
    state = GoalManager(work).state
    assert state.status == 'paused'
    assert state.gates[0].attempts == 1
    assert state.gates[0].max_retries == 0
    assert not ctx.repository.load().commands[p['id']].result.get('_steering')
    assert len(terminal_jobs.list_for_work(ctx, actor, work)['items']) == 1


@pytest.mark.parametrize('arguments', [
    {'max_retries':-1}, {'timeout_seconds':0}, {'timeout_seconds':-1}, {'timeout_seconds':3601},
])
def test_gate_limits_validated_by_contract_and_manager(setup, arguments):
    from homun.application.goal_contracts import GoalGateAddArguments
    ctx, actor, work, p = start(setup)
    with pytest.raises(ValueError):
        GoalGateAddArguments(command='true', **arguments)
    with pytest.raises(ValueError):
        GoalManager(work).add_gate('true', **arguments)
    assert len(GoalManager(work).state.gates) == 1


def test_gate_none_limits_keep_defaults(setup):
    from homun.application.goal_contracts import DEFAULT_GATE_MAX_RETRIES, DEFAULT_GATE_TIMEOUT_SECONDS
    ctx, actor, work, p = start(setup)
    gate = GoalManager(work).add_gate('true', timeout_seconds=None, max_retries=None)
    assert gate.timeout_seconds == DEFAULT_GATE_TIMEOUT_SECONDS
    assert gate.max_retries == DEFAULT_GATE_MAX_RETRIES
