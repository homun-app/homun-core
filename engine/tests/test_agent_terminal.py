from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_terminal_jobs import Backend
from homun.application import agent_runs,terminal_jobs
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage,ToolCall

IMAGE='sha256:'+'a'*64


def start(setup,monkeypatch):
    ctx,actor,work,_=setup;ctx.models.set_active('openai_compatible')
    backend=Backend();monkeypatch.setattr(terminal_jobs,'backend_for',lambda ctx, proposal=None: backend)
    p=agent_runs.propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[],'terminal_image':IMAGE})
    agent_runs.approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='cmd1',name='terminal_execute',arguments={'command':'echo done'})]),usage=None)
    return ctx,actor,work,p,backend


def choose(s):
    ctx,actor,work,p,backend=s
    assert advance(ctx,p['id'])=='waiting_external'
    return ctx.repository.load().commands[ctx.repository.load().commands[p['id']].result['terminal_request_id']].result


def test_native_terminal_separate_approval_and_single_receipt(setup,monkeypatch):
    from homun.application.agent_terminal import resume
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    assert not backend.calls
    assert not resume(ctx,p['id'])
    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    assert not resume(ctx,p['id'])
    backend.state.update(status='exited',running=False,exit_code=0)
    assert resume(ctx,p['id']) and not resume(ctx,p['id'])
    def finish(messages,**kwargs):
        assert messages[-1].tool_call_id=='cmd1' and 'done' in messages[-1].content
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Comando concluso: done.'),usage=None)
    ctx.models.complete_tools=finish
    assert advance(ctx,p['id'])=='completed'
    assert len(ctx.repository.load().artifacts)==1
    assert sum(c[0]=='start' for c in backend.calls)==1


def test_cancel_before_command_approval_prevents_io(setup,monkeypatch):
    from homun.application.agent_control import control
    from homun.domain.errors import ConflictError
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    control(ctx,actor,work,p['id'],{'command_id':'cancel','action':'cancel','expected_version':ctx.repository.load().works[work].version})
    with pytest.raises(ConflictError):terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    assert not backend.calls


def test_restart_consumes_receipt_once(setup,monkeypatch):
    from homun.application.agent_terminal import resume
    from homun.context import create_context
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    backend.state.update(status='exited',running=False,exit_code=7)
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        assert resume(second,p['id']) and not resume(second,p['id'])
        run=second.repository.load().commands[p['id']].result
        assert len([m for m in run['_messages'] if m.get('tool_call_id')=='cmd1'])==1
        assert run['observations'][-1]['result']['is_error'] is True
    finally:second.close()


def test_cancel_during_start_keeps_effect_uncertain_without_resuming(setup,monkeypatch):
    from homun.application.agent_terminal import resume
    from homun.application.agent_control import control
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    original=backend.start
    def cancel(spec):
        state=original(spec)
        control(ctx,actor,work,p['id'],{'command_id':'cancel','action':'cancel','expected_version':ctx.repository.load().works[work].version})
        return state
    monkeypatch.setattr(backend,'start',cancel)
    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    assert not resume(ctx,p['id'])
    run=ctx.repository.load().commands[p['id']].result
    assert run['status']=='cancelled'
    assert 'unknown' in [m for m in run['_messages'] if m.get('tool_call_id')=='cmd1'][0]['content']
    assert terminal_jobs.stop(ctx,actor,work,job['id'])['status']=='exited'


def test_terminal_absent_without_explicit_image(setup):
    ctx,actor,work,_=setup;ctx.models.set_active('openai_compatible')
    p=agent_runs.propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[]})
    assert not any(t['name']=='terminal_execute' for t in p['tools'])


def test_runtime_reconciles_terminal_without_mcp_dispatch(setup,monkeypatch):
    from homun.runtime.workflows import agent_run
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    backend.state.update(status='exited',running=False,exit_code=0)
    queued=[];monkeypatch.setattr(agent_run,'start',lambda *a:queued.append(a))
    agent_run.deliver_agent_runs(ctx)
    assert len(queued)==1 and ctx.repository.load().commands[p['id']].result['status']=='queued'


def test_log_transport_failure_waits_without_losing_tool_output(setup,monkeypatch):
    from homun.application.agent_terminal import resume
    from homun.execution.contracts import ExecutionUnavailable
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    backend.state.update(status='exited',running=False,exit_code=0)
    original=backend.logs
    def unavailable(spec):raise ExecutionUnavailable('transient')
    monkeypatch.setattr(backend,'logs',unavailable)
    assert not resume(ctx,p['id'])
    assert ctx.repository.load().commands[p['id']].result['terminal_request_id']==job['id']
    monkeypatch.setattr(backend,'logs',original)
    assert resume(ctx,p['id'])
    assert 'done' in ctx.repository.load().commands[p['id']].result['_messages'][-1]['content']


def test_deadline_reason_reaches_model_even_if_process_exits_zero(setup,monkeypatch):
    from datetime import timedelta
    from homun.domain.models import utc_now
    from homun.application.terminal_watchdog import reconcile
    from homun.application.agent_terminal import resume
    s=start(setup,monkeypatch);ctx,actor,work,p,backend=s;job=choose(s)
    terminal_jobs.approve(ctx,actor,work,job['id'],{'digest':job['digest']})
    def graceful(spec):
        backend.state.update(status='exited',running=False,exit_code=0)
        return backend.state.copy()
    monkeypatch.setattr(backend,'stop',graceful)
    reconcile(ctx,now=utc_now()+timedelta(seconds=301))
    assert resume(ctx,p['id'])
    receipt=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']
    assert receipt['timed_out'] and receipt['is_error'] and receipt['exit_code']==0


def test_cancel_run_stops_active_terminal_process(setup, monkeypatch):
    from homun.application.agent_control import control
    s = start(setup, monkeypatch); ctx, actor, work, p, backend = s; job = choose(s)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest': job['digest']})
    assert any(c[0] == 'start' for c in backend.calls)
    assert not any(c[0] == 'stop' for c in backend.calls)

    control(ctx, actor, work, p['id'], {'command_id': 'cancel_in_flight', 'action': 'cancel', 'expected_version': ctx.repository.load().works[work].version})

    assert any(c[0] == 'stop' for c in backend.calls)
    current_job = ctx.repository.load().commands[job['id']].result
    assert current_job['status'] == 'exited'
    current_run = ctx.repository.load().commands[p['id']].result
    assert current_run['status'] == 'cancelled'

