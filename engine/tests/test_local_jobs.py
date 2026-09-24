"""Local commands stay in one private directory and do not inherit the environment."""
import os
import time

import pytest

from homun.execution.contracts import LocalJobSpec
from homun.execution.local_jobs import LocalJobs
from test_agent_runs import setup


def job(root_name: str) -> LocalJobSpec:
    return LocalJobSpec(workspace_id='ws', run_id=root_name, call_id='call', command='printf done > "$HOME/out.txt"')


def finished(jobs: LocalJobs, spec: LocalJobSpec) -> dict:
    state = jobs.inspect(spec)
    for _ in range(250):
        if state.get('exit_code') is not None or state.get('running') is False:
            return state
        time.sleep(0.02)
        state = jobs.inspect(spec)
    return state



def test_local_command_hides_parent_environment_and_does_not_restart(tmp_path, monkeypatch):
    monkeypatch.setenv('SENTINEL', 'hidden-value')
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws', run_id='once', call_id='call',
                        command='pwd > "$HOME/where.txt"; printf SENTINEL=%s "$SENTINEL" >> "$HOME/where.txt"')
    jobs.start(spec)
    first = finished(jobs, spec)
    assert first['status'] == 'exited' and first['exit_code'] == 0, jobs.logs(spec)['text']
    workspace = jobs.workspace(spec)
    text = (workspace / 'where.txt').read_text()
    assert text.startswith(str(workspace))
    assert 'hidden-value' not in text
    assert os.environ['SENTINEL'] == 'hidden-value'
    before = (workspace / 'where.txt').read_bytes()
    second = jobs.start(spec)
    assert second['exit_code'] == 0 and (workspace / 'where.txt').read_bytes() == before


def test_local_stop_does_not_signal_another_process(tmp_path):
    jobs = LocalJobs(tmp_path)
    first = LocalJobSpec(workspace_id='ws', run_id='a', call_id='call', command='sleep 30')
    second = LocalJobSpec(workspace_id='ws', run_id='b', call_id='call', command='sleep 30')
    jobs.start(first)
    jobs.start(second)
    assert jobs.stop(first)['running'] is False
    assert jobs.inspect(second)['running'] is True
    jobs.stop(second)


def test_local_refuses_stdin_and_a_second_contract(tmp_path):
    from homun.domain.errors import ConflictError
    from homun.execution.contracts import ExecutionUnavailable
    jobs = LocalJobs(tmp_path)
    spec = job('refused')
    with pytest.raises(ExecutionUnavailable):
        jobs.start(spec, stdin=True)
    jobs.start(spec)
    assert finished(jobs, spec)['exit_code'] == 0
    other = spec.model_copy(update={'command': 'printf twice > "$HOME/out.txt"'})
    with pytest.raises(ConflictError):
        jobs.start(other)
    assert (jobs.workspace(spec) / 'out.txt').read_text() == 'done'


def test_local_symlink_root_is_refused(tmp_path):
    from homun.domain.errors import PermissionDeniedError
    linked = tmp_path / 'linked'
    linked.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(PermissionDeniedError):
        LocalJobs(linked)


def test_approved_local_run_executes_once(setup, monkeypatch):
    from types import SimpleNamespace
    from homun.application import agent_runs, terminal_jobs
    from homun.application.agent_run_execution import advance
    from homun.application.agent_terminal import resume
    from homun.application.workspace_files import root_for
    from homun.models.native_turn import NativeMessage, ToolCall
    monkeypatch.setenv('SENTINEL', 'hidden-value')
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    proposal = agent_runs.propose(ctx, actor, work, {
        'command_id': 'run', 'expected_version': 1, 'material_ids': [], 'terminal_backend': 'local'})
    names = [item['name'] for item in proposal['tools']]
    assert proposal['terminal'] == {'policy': 'local-private-v1', 'version': 1}
    assert 'terminal_write' not in names and 'terminal_execute' in names
    agent_runs.approve(ctx, actor, work, proposal['id'], {
        'command_id': 'go', 'digest': proposal['digest'], 'expected_version': proposal['expected_version']})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role='assistant', tool_calls=[ToolCall(id='cmd1', name='terminal_execute', arguments={
            'command': 'pwd > "$HOME/where.txt"; printf SENTINEL=%s "$SENTINEL" >> "$HOME/where.txt"'})]), usage=None)
    assert advance(ctx, proposal['id']) == 'waiting_external'
    run = ctx.repository.load().commands[proposal['id']].result
    job = ctx.repository.load().commands[run['terminal_request_id']].result
    assert job['policy'] == 'local-private-v1' and 'image' not in job
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest': job['digest']})
    resumed = False
    for _ in range(50):
        resumed = resume(ctx, proposal['id'])
        if resumed:
            break
        time.sleep(0.02)
    assert resumed
    text = (root_for(ctx, ctx.repository.load().commands[proposal['id']].result) / 'where.txt').read_text()
    assert 'hidden-value' not in text and text.strip()
