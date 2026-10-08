"""Real detached local deadline evidence; no application lifespan or user data."""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pytest

from homun.execution.contracts import LocalJobSpec, digest
from homun.execution.local_jobs import LocalJobs
from homun.execution.local_job_supervisor import command


def deadline(seconds=1):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def wait_receipt(path, seconds=4):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if path.is_file():
            result = json.loads(path.read_text())
            if 'exit_code' in result:
                return result
        time.sleep(.02)
    return json.loads(path.read_text())


def test_detached_supervisor_enforces_deadline_after_launcher_dies(tmp_path):
    state = tmp_path / 'state.json'
    payload = dict(state_path=str(state), log_path=str(tmp_path/'output.log'),
        command='printf started; exec sleep 30', workspace=str(tmp_path),
        environment={'PATH':'/usr/bin:/bin'}, contract='test', deadline_at=deadline())
    launcher = 'import json,subprocess,sys; subprocess.Popen(json.loads(sys.argv[1]),start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)'
    subprocess.run([sys.executable, '-c', launcher, json.dumps(command(payload))], check=True)
    try:
        result = wait_receipt(state)
        assert result.get('exit_code') == -9, result
        assert result['timed_out'] is True
        assert (tmp_path/'output.log').read_text() == 'started'
    finally:
        if state.exists():
            result = json.loads(state.read_text())
            if 'exit_code' not in result:
                os.killpg(result['pid'], 9)


def test_local_deadline_receipt_survives_restart_without_redispatch(tmp_path):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='deadline',call_id='call',
        command='printf once >> count; exec sleep 30',deadline_at=deadline())
    jobs.start(spec)
    try:
        result = wait_receipt(jobs._path('local-state', spec))
        assert result['timed_out'] is True and result['exit_code'] == -9
        restarted = LocalJobs(tmp_path)
        assert restarted.inspect(spec)['timed_out'] is True
        assert restarted.start(spec)['status'] == 'dead'
        assert (restarted.workspace(spec)/'count').read_text() == 'once'
    finally:
        jobs.stop(spec)


@pytest.mark.parametrize('cancel', [False, True])
def test_normal_exit_and_cancellation_are_not_timeouts(tmp_path, cancel):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='normal',call_id='call',
        command='exec sleep 30' if cancel else 'exit 7',deadline_at=deadline(10))
    jobs.start(spec)
    try:
        if cancel:
            jobs.stop(spec)
        receipt = wait_receipt(jobs._path('local-state',spec))
        assert not receipt.get('timed_out')
        assert receipt['exit_code'] == (-15 if cancel else 7)
    finally:
        jobs.stop(spec)


def test_local_deadline_contract_preserves_legacy_and_binds_new_deadline():
    base = dict(workspace_id='ws',run_id='r',call_id='c',command='true')
    legacy = LocalJobSpec(**base)
    assert legacy.contract == digest({'spec':base,'policy':'local-private-v1'})
    assert LocalJobSpec(**base,deadline_at=deadline()).contract != legacy.contract


@pytest.mark.parametrize('value', ['nan','2026-09-27T12:00:00', '99999-01-01T00:00:00Z'])
def test_invalid_or_naive_deadlines_are_rejected(value):
    with pytest.raises(ValueError):
        LocalJobSpec(workspace_id='ws',run_id='r',call_id='c',command='true',deadline_at=value)


@pytest.mark.parametrize('changed_identity', [False, True])
def test_deadline_and_error_cleanup_never_signal_changed_owner(tmp_path, monkeypatch, changed_identity):
    from types import SimpleNamespace
    from homun.execution import local_job_supervisor as supervisor
    class Process:
        pid = 123456
        returncode = None
        def wait(self, timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired('owned', timeout)
            self.returncode = 7
            return 7
        def poll(self):
            return self.returncode
    replies = iter(['original', 'supervisor', 'different' if changed_identity else 'original'])
    monkeypatch.setattr(supervisor.subprocess,'Popen',lambda *a,**k: Process())
    monkeypatch.setattr(supervisor.subprocess,'run',lambda *a,**k: SimpleNamespace(stdout=next(replies, 'different')))
    monkeypatch.setattr(supervisor.os,'getpgid',lambda pid: pid if changed_identity else pid+1)
    monkeypatch.setattr(supervisor.os,'killpg',lambda *a: pytest.fail('Must not signal changed process owner'))
    payload = dict(state_path=str(tmp_path/'state'),log_path=str(tmp_path/'log'),command='true',
        workspace=str(tmp_path),environment={},contract='test',deadline_at=deadline(1))
    with pytest.raises(RuntimeError):
        supervisor.supervise(json.dumps(payload))


def test_deadline_expired_before_dispatch_does_not_run_command(tmp_path):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='expired',call_id='call',
        command='printf unwanted > marker',deadline_at=deadline(-1))
    result = jobs.start(spec)
    assert result['timed_out'] is True and result['running'] is False
    assert result['exit_code'] is None
    assert not (jobs.workspace(spec)/'marker').exists()
    assert jobs.start(spec) == result
    receipt = json.loads(jobs._path('local-state',spec).read_text())
    assert receipt['not_started'] is True


def test_legacy_approved_local_contract_does_not_gain_deadline():
    from types import SimpleNamespace
    from homun.application.terminal_contracts import job_spec
    proposal = dict(policy='local-private-v1',work_id='work',id='job',command='true',deadline_at=deadline())
    spec = job_spec(SimpleNamespace(workspace_id='ws'),proposal)
    assert spec.deadline_at is None


def test_new_local_approval_passes_deadline_to_supervisor(setup, monkeypatch):
    from homun.application import terminal_jobs
    from homun.application.terminal_contracts import job_spec
    ctx, actor, work, body, _ = setup
    backend = LocalJobs(ctx.data_dir/'execution')
    monkeypatch.setattr(terminal_jobs,'backend_for',lambda *a: backend)
    proposal = terminal_jobs.propose(ctx,actor,work,dict(command_id='bounded-local',
        command='exec sleep 30',expected_version=1,policy='local-private-v1',timeout_seconds=1))
    terminal_jobs.approve(ctx,actor,work,proposal['id'],{'digest':proposal['digest']})
    stored = ctx.repository.load().commands[proposal['id']].result
    spec = job_spec(ctx,stored)
    try:
        assert spec.deadline_at == stored['deadline_at']
        receipt = wait_receipt(backend._path('local-state',spec))
        assert receipt['timed_out'] is True
        observed = terminal_jobs.refresh(ctx,actor,work,proposal['id'])
        assert observed['timed_out'] is True and observed['status'] == 'dead'
    finally:
        backend.stop(spec)


from test_terminal_jobs import setup


def test_supervised_cancel_does_not_signal_from_engine(tmp_path, monkeypatch):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='cancel-ipc',call_id='call',command='exec sleep 30')
    jobs.start(spec)
    real_killpg = os.killpg
    try:
        with monkeypatch.context() as patch:
            patch.setattr(os,'killpg',lambda *a: pytest.fail('Only owning supervisor may signal'))
            result = jobs.stop(spec)
        assert result['running'] is False and not result.get('timed_out')
    finally:
        state = json.loads(jobs._path('local-state',spec).read_text())
        if 'exit_code' not in state:
            real_killpg(state['pid'], 9)


from test_agent_runs import setup as agent_setup


def test_approved_local_timeout_after_engine_exit_resumes_as_error(agent_setup):
    from types import SimpleNamespace
    from homun.application import agent_runs, terminal_jobs
    from homun.application.agent_run_execution import advance
    from homun.application.agent_terminal import resume
    from homun.application.terminal_contracts import job_spec
    from homun.context import create_context
    from homun.models.native_turn import NativeMessage, ToolCall
    ctx, actor, work, _ = agent_setup
    ctx.models.set_active('openai_compatible')
    run = agent_runs.propose(ctx,actor,work,{'command_id':'bounded-run','expected_version':1,
        'material_ids':[],'terminal_backend':'local'})
    agent_runs.approve(ctx,actor,work,run['id'],{'command_id':'go','digest':run['digest'],
        'expected_version':run['expected_version']})
    ctx.models.complete_tools = lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='sleep',name='terminal_execute',arguments={
            'command':'printf once >> count; exec sleep 30','timeout_seconds':1})]),usage=None)
    assert advance(ctx,run['id']) == 'waiting_external'
    stored_run = ctx.repository.load().commands[run['id']].result
    proposal = ctx.repository.load().commands[stored_run['terminal_request_id']].result
    launcher = '''import sys
from pathlib import Path
from homun.context import create_context
from homun.domain.models import Actor
from homun.application import terminal_jobs
ctx=create_context(db_path=Path(sys.argv[1])/'ws.db',data_dir=Path(sys.argv[1]),for_tests=True)
try:
    terminal_jobs.approve(ctx,Actor.model_validate_json(sys.argv[2]),sys.argv[3],sys.argv[4],{'digest':sys.argv[5]})
finally:
    ctx.close()
'''
    subprocess.run([sys.executable,'-c',launcher,str(ctx.data_dir),actor.model_dump_json(),work,
        proposal['id'],proposal['digest']],check=True)
    proposal = ctx.repository.load().commands[proposal['id']].result
    backend = terminal_jobs.backend_for(ctx,proposal)
    spec = job_spec(ctx,proposal)
    try:
        assert wait_receipt(backend._path('local-state',spec))['timed_out'] is True
        second = create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
        try:
            assert resume(second,run['id']) is True
            observed = second.repository.load().commands[run['id']].result['observations'][-1]['result']
            assert observed['timed_out'] is True and observed['is_error'] is True
            assert observed['status'] == 'dead' and observed['exit_code'] is None
            assert not second.repository.load().artifacts
            assert (backend.workspace(spec)/'count').read_text() == 'once'
        finally:
            second.close()
    finally:
        backend.stop(spec)


def test_normal_exit_racing_timeout_is_not_reported_as_timeout(tmp_path, monkeypatch):
    from homun.execution import local_job_supervisor as supervisor
    class Process:
        pid = 123456
        returncode = None
        def wait(self, timeout=None):
            if timeout is not None:
                raise subprocess.TimeoutExpired('owned',timeout)
            self.returncode = 7
            return 7
    monkeypatch.setattr(supervisor,'process_lstart',lambda pid: 'original')
    monkeypatch.setattr(supervisor.os,'getpgid',lambda pid: pid)
    signals = []
    monkeypatch.setattr(supervisor.os,'killpg',lambda *a: signals.append(a))
    state = {'contract':'test','lstart':'original'}
    result = supervisor.wait_owned(Process(),state,tmp_path/'state',datetime.fromisoformat(deadline(-1)))
    assert result == 7 and state['timed_out'] is False
    assert len(signals) == 1


def test_supervisor_ignores_other_contract_stop_then_escalates_owned_cancel(tmp_path):
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='stubborn',call_id='call',
        command='trap "" TERM; printf ready > ready; while :; do sleep 1; done',deadline_at=deadline(10))
    jobs.start(spec)
    try:
        until = time.monotonic()+2
        while not (jobs.workspace(spec)/'ready').exists() and time.monotonic()<until:
            time.sleep(.02)
        jobs._write_json(jobs._path('local-state',spec).with_suffix('.stop'),{'contract':'other'})
        time.sleep(.2)
        assert jobs.inspect(spec)['running'] is True
        assert jobs.stop(spec)['running'] is False
        receipt = json.loads(jobs._path('local-state',spec).read_text())
        assert receipt['exit_code'] == -9 and receipt['timed_out'] is False
    finally:
        jobs.stop(spec)


def test_concurrent_cancel_requests_share_one_exit_receipt(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='concurrent',call_id='call',command='exec sleep 30')
    jobs.start(spec)
    destination = jobs._path('local-state',spec).with_suffix('.stop')
    original = os.replace
    barrier = Barrier(2)
    def replace(source, target):
        if target == destination:
            barrier.wait(timeout=3)
        return original(source,target)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(os,'replace',replace)
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(jobs.stop,spec) for _ in range(2)]
                results = [future.result() for future in futures]
        assert all(result['running'] is False for result in results)
        assert LocalJobs(tmp_path).start(spec)['running'] is False
    finally:
        jobs.stop(spec)


def test_lost_supervisor_is_unknown_until_final_receipt_exists(tmp_path, monkeypatch):
    from homun.execution import local_jobs
    jobs = LocalJobs(tmp_path)
    spec = LocalJobSpec(workspace_id='ws',run_id='owner-lost',call_id='call',command='true')
    state = dict(contract=spec.contract,pid=123456,lstart='child',supervised=True,
                 control_version=1,supervisor_pid=123457,supervisor_lstart='owner')
    jobs._write_json(jobs._path('local-state',spec),state)
    monkeypatch.setattr(local_jobs,'_lstart',lambda pid: 'child' if pid == state['pid'] else None)
    monkeypatch.setattr(jobs,'_alive',lambda pid: pid == state['pid'])
    assert jobs.inspect(spec)['status'] == 'outcome_unknown'
    state.update(exit_code=-9,timed_out=True)
    jobs._write_json(jobs._path('local-state',spec),state)
    assert jobs.inspect(spec)['status'] == 'dead'
    assert jobs.inspect(spec)['timed_out'] is True
