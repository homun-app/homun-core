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


def test_local_exit_receipt_survives_actual_launcher_process_exit(tmp_path):
    """The child exits only after its original engine process is gone."""
    import subprocess
    import sys
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws', run_id='restart', call_id='call',
        command='while [ ! -f release ]; do sleep 0.02; done; printf once >> count; exit 7')
    launcher = ('import json,sys; from pathlib import Path; '
                'from homun.execution.local_jobs import LocalJobs; '
                'from homun.execution.contracts import LocalJobSpec; '
                'LocalJobs(Path(sys.argv[1])).start(LocalJobSpec.model_validate_json(sys.argv[2]))')
    subprocess.run([sys.executable, '-c', launcher, str(tmp_path), spec.model_dump_json()], check=True)
    (jobs.workspace(spec) / 'release').touch()
    result = finished(LocalJobs(tmp_path), spec)
    assert result['status'] == 'exited' and result['exit_code'] == 7
    assert LocalJobs(tmp_path).start(spec)['exit_code'] == 7
    assert (jobs.workspace(spec) / 'count').read_text() == 'once'


def test_local_supervisor_survives_python_child_cleanup(tmp_path):
    import subprocess
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws', run_id='cleanup', call_id='call', command='sleep 0.05; exit 9')
    jobs.start(spec)
    time.sleep(.1)
    # subprocess reaps any unreferenced completed Popen objects on a new start.
    subprocess.run(['/bin/sh', '-c', ':'], check=True)
    assert finished(LocalJobs(tmp_path), spec)['exit_code'] == 9


def test_frozen_supervisor_uses_engine_entrypoint(monkeypatch):
    import json
    import sys
    from homun.execution.local_job_supervisor import command
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr(sys, 'executable', '/fixture/homun-engine')
    args = command({'command':'exit 7'})
    assert args[:2] == ['/fixture/homun-engine', '_local-job-supervisor']
    assert json.loads(args[2]) == {'command':'exit 7'}


def test_supervised_missing_exit_receipt_stays_unknown(tmp_path):
    jobs = LocalJobs(tmp_path)
    spec = job('lost')
    # A killed supervisor cannot report its child's outcome. Never infer zero.
    jobs._write_json(jobs._path('local-state', spec),
        {'contract':spec.contract, 'pid':99999999, 'lstart':'missing', 'supervised':True})
    assert jobs.inspect(spec)['status'] == 'outcome_unknown'
    assert jobs.inspect(spec)['exit_code'] is None


def test_supervisor_final_receipt_failure_does_not_signal_reaped_pid(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    from homun.execution import local_job_supervisor as supervisor
    class Process:
        pid = 123456
        returncode = None
        def wait(self, timeout=None):
            self.returncode = 7
            return 7
        def poll(self):
            return self.returncode
    process = Process()
    monkeypatch.setattr(supervisor.subprocess, 'Popen', lambda *a, **k: process)
    monkeypatch.setattr(supervisor.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='identity'))
    writes = []
    def write(path, state):
        writes.append(dict(state))
        if len(writes) == 2:
            raise OSError('disk full')
    monkeypatch.setattr(supervisor, 'write_receipt', write)
    monkeypatch.setattr(supervisor.os, 'killpg', lambda *a: pytest.fail('Reaped PID must never be signalled'))
    payload = {'state_path':str(tmp_path/'state.json'), 'log_path':str(tmp_path/'logs'),
               'command':'exit 7','workspace':str(tmp_path),'environment':{},'contract':'contract'}
    with pytest.raises(OSError, match='disk full'):
        supervisor.supervise(json.dumps(payload))


def test_supervised_missing_process_identity_never_signals_or_claims_running(tmp_path, monkeypatch):
    from homun.execution import local_jobs
    from homun.execution.contracts import ExecutionUncertain
    jobs = LocalJobs(tmp_path)
    spec = job('identity')
    jobs._write_json(jobs._path('local-state', spec),
        {'contract':spec.contract, 'pid':os.getpid(), 'lstart':None, 'supervised':True})
    monkeypatch.setattr(local_jobs, '_lstart', lambda pid: None)
    monkeypatch.setattr(os, 'getpgid', lambda pid: pid)
    monkeypatch.setattr(os, 'killpg', lambda *a: pytest.fail('Unidentified PID must never be signalled'))
    assert jobs.inspect(spec)['status'] == 'outcome_unknown'
    with pytest.raises(ExecutionUncertain):
        jobs.stop(spec)
