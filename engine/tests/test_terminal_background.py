"""Background sessions return control, then poll, wait, stop and notify once."""
import json
from types import SimpleNamespace
from homun.application import agent_runs, terminal_jobs
from homun.application.agent_run_execution import advance
from homun.application.agent_terminal import resume
from homun.application.agent_terminal_sessions import announce, resume_wait
from homun.models.native_turn import NativeMessage, ToolCall
from test_agent_runs import setup
from test_agent_terminal import IMAGE, start


class Sessions:
    def __init__(self):
        self.calls = []
        self.states = {}

    def start(self, spec):
        self.calls.append(('start', spec.call_id))
        self.states[spec.call_id] = {'container_id': 'a' * 64, 'status': 'running', 'running': True,
                                     'exit_code': None, 'oom_killed': False}
        return self.states[spec.call_id].copy()

    def inspect(self, spec):
        self.calls.append(('inspect', spec.call_id))
        return self.states[spec.call_id].copy()

    def logs(self, spec):
        return {'text': spec.call_id, 'truncated': False, 'tail_only': True, 'line_limit': 1000}

    def stop(self, spec):
        self.calls.append(('stop', spec.call_id))
        self.states[spec.call_id].update(status='exited', running=False, exit_code=137)
        return self.states[spec.call_id].copy()


def tool(call_id, name, arguments):
    return NativeMessage(role='assistant', tool_calls=[ToolCall(id=call_id, name=name, arguments=arguments)])


def run_of(ctx, run_id):
    return ctx.repository.load().commands[run_id].result


def job_of(ctx, run_id):
    run = run_of(ctx, run_id)
    return ctx.repository.load().commands[run['terminal_request_id']].result


def release(ctx, actor, work, run_id):
    assert advance(ctx, run_id) == 'waiting_external'
    job = job_of(ctx, run_id)
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest': job['digest']})
    assert resume(ctx, run_id)
    return job


def test_version_three_adds_session_tools_without_changing_version_two():
    from homun.application.agent_terminal_contracts import entries
    old = [item.definition.name for item in entries({'image': IMAGE, 'version': 2})]
    new = [item.definition.name for item in entries({'image': IMAGE, 'version': 3})]
    assert old == ['terminal_execute']
    assert new == ['terminal_execute', 'terminal_poll', 'terminal_wait', 'terminal_stop']


def test_background_returns_before_exit_and_poll_does_not_restart(setup, monkeypatch):
    ctx, actor, work, proposal, backend = start(setup, monkeypatch)
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd1', 'terminal_execute', {'command': 'echo done', 'background': True}), usage=None)
    job = release(ctx, actor, work, proposal['id'])
    assert job['background'] is True and backend.state['status'] == 'running'
    assert sum(call[0] == 'start' for call in backend.calls) == 1
    body = json.loads(run_of(ctx, proposal['id'])['_messages'][-1]['content'])
    assert body['complete'] is False and body['job_id'] == job['id']
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd2', 'terminal_poll', {'session_id': job['id']}), usage=None)
    assert advance(ctx, proposal['id']) == 'running'
    assert sum(call[0] == 'start' for call in backend.calls) == 1
    polled = json.loads([item for item in run_of(ctx, proposal['id'])['_messages'] if item.get('tool_call_id') == 'cmd2'][-1]['content'])
    assert polled['status'] == 'running' and polled['complete'] is False


def test_wait_resumes_once_and_a_fast_exit_is_not_announced_twice(setup, monkeypatch):
    ctx, actor, work, proposal, backend = start(setup, monkeypatch)
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd1', 'terminal_execute', {'command': 'echo done', 'background': True}), usage=None)
    job = release(ctx, actor, work, proposal['id'])
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd2', 'terminal_wait', {'session_id': job['id']}), usage=None)
    assert advance(ctx, proposal['id']) == 'waiting_external'
    assert not resume_wait(ctx, proposal['id'])
    backend.state.update(status='exited', running=False, exit_code=0)
    assert resume_wait(ctx, proposal['id']) and not resume_wait(ctx, proposal['id'])
    done = json.loads([item for item in run_of(ctx, proposal['id'])['_messages'] if item.get('tool_call_id') == 'cmd2'][-1]['content'])
    assert done['complete'] is True and done['exit_code'] == 0
    assert not announce(ctx, proposal['id'])


def test_completion_notice_is_delivered_once(setup, monkeypatch):
    ctx, actor, work, proposal, backend = start(setup, monkeypatch)
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd1', 'terminal_execute', {'command': 'echo done', 'background': True}), usage=None)
    job = release(ctx, actor, work, proposal['id'])
    backend.state.update(status='exited', running=False, exit_code=0)
    assert announce(ctx, proposal['id']) and not announce(ctx, proposal['id'])
    notices = [item['content'] for item in run_of(ctx, proposal['id'])['_messages'] if item['role'] == 'user' and 'Background session' in item['content']]
    assert notices == [f"Background session {job['id']} finished with status exited and exit code 0."]


def test_exit_before_release_stays_one_tool_result(setup, monkeypatch):
    ctx, actor, work, proposal, backend = start(setup, monkeypatch)
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd1', 'terminal_execute', {'command': 'echo done', 'background': True}), usage=None)
    assert advance(ctx, proposal['id']) == 'waiting_external'
    job = job_of(ctx, proposal['id'])
    terminal_jobs.approve(ctx, actor, work, job['id'], {'digest': job['digest']})
    backend.state.update(status='exited', running=False, exit_code=0)
    assert resume(ctx, proposal['id']) and not resume(ctx, proposal['id'])
    assert not announce(ctx, proposal['id'])
    assert len([item for item in run_of(ctx, proposal['id'])['_messages'] if item.get('tool_call_id') == 'cmd1']) == 1


def test_stopping_one_session_leaves_the_other_running(setup, monkeypatch):
    ctx, actor, work, proposal, _backend = start(setup, monkeypatch)
    sessions = Sessions()
    monkeypatch.setattr(terminal_jobs, 'backend_for', lambda ctx: sessions)
    planned = [
        tool('cmd1', 'terminal_execute', {'command': 'echo one', 'background': True}),
        tool('cmd2', 'terminal_execute', {'command': 'echo two', 'background': True}),
    ]
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=planned.pop(0), usage=None)
    first = release(ctx, actor, work, proposal['id'])
    second = release(ctx, actor, work, proposal['id'])
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=tool('cmd3', 'terminal_stop', {'session_id': first['id']}), usage=None)
    assert advance(ctx, proposal['id']) == 'running'
    stopped = [name for kind, name in sessions.calls if kind == 'stop']
    assert stopped == [first['id']]
    assert sessions.states[first['id']]['status'] == 'exited'
    assert sessions.states[second['id']]['status'] == 'running'
    assert sum(kind == 'start' for kind, _name in sessions.calls) == 2
