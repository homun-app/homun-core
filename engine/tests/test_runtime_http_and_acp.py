import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from homun.application.relay_runtime import RelayRuntime
from homun.application.acp_adapter import AcpServerAdapter
from homun.application.hosted_mcp_runner import HostedMcpEngineRunner
from homun.context import create_context
from homun.domain.errors import BackendUnavailableError, ConflictError, ValidationError


@pytest.mark.parametrize('status,body,code', [(200,b'{"receipt":"real"}',None),(200,b' ', 'runtime_protocol_error'),(200,b'[]','runtime_protocol_error'),(503,b'{}','runtime_http_error'),(302,b'{}','runtime_http_error')])
def test_relay_uses_exact_local_endpoint_once(status, body, code):
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, dict(self.headers), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        relay = RelayRuntime(endpoint_url=f'http://127.0.0.1:{server.server_port}/configured/dispatch', enabled=True)
        relay.create_session('child','parent')
        result = relay.execute_operation('openai.responses',{'input':'hello'},session_id='child')
        assert result.error_code == code
        assert result.success == (code is None)
        assert result.source == 'engine'
        assert requests == [('/configured/dispatch', requests[0][1], {'operation':'openai.responses','payload':{'input':'hello'}})]
        assert requests[0][1]['x-dynamo-session-id'] == 'child'
        assert requests[0][1]['x-dynamo-parent-session-id'] == 'parent'
        if code is None: assert result.output == {'receipt':'real'}
    finally:
        server.shutdown(); server.server_close(); thread.join()


def test_acp_without_engine_does_not_invent_completion():
    adapter = AcpServerAdapter()
    session = adapter.new_session()
    with pytest.raises(BackendUnavailableError):
        asyncio.run(adapter.prompt(session.session_id, 'do work'))
    assert session.messages == []


def test_canonical_runner_retries_and_reopens_without_duplicate_effect(tmp_path):
    ctx = create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    runner = HostedMcpEngineRunner()
    first = runner.run_task('prepare note',allow_tools=[],ctx=ctx,command_id='caller-1')
    assert first['status'] == 'pending_approval'
    assert runner.run_task('prepare note',allow_tools=[],ctx=ctx,command_id='caller-1') == first
    with pytest.raises(ConflictError):
        runner.run_task('different',allow_tools=[],ctx=ctx,command_id='caller-1')
    ctx.close()
    ctx = create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    try:
        assert runner.run_task('prepare note',allow_tools=[],ctx=ctx,command_id='caller-1') == first
        store = ctx.repository.load()
        assert len(store.works) == len(store.projects) == len(store.conversations) == 1
        run = store.commands[first['run_id']].result
        assert run['allowed_tools'] == []
        assert run['tools'] == []
        adapter = AcpServerAdapter(runner=runner,ctx=ctx)
        session = adapter.new_session()
        events = []
        result = asyncio.run(adapter.prompt(session.session_id,'prepare note',command_id='caller-1',allow_tools=[],event_callback=lambda kind, data: events.append((kind,data))))
        assert events[0][0] == "plan_update"
        assert events[0][1]["status"] == "pending_approval"
        assert result["source"] == "engine"
        assert not any(m["role"] == "assistant" for m in session.messages)
        assert result['run_id'] == first['run_id']
        assert result['status'] == 'pending_approval'
    finally: ctx.close()


def test_unsupported_files_fail_before_any_work_is_created(tmp_path):
    ctx = create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    try:
        with pytest.raises(ValidationError):
            HostedMcpEngineRunner().run_task('read',files=['/some/file'],ctx=ctx)
        assert not ctx.repository.load().works
    finally: ctx.close()


def test_admission_recovers_after_proposal_failure_without_duplicate_work(tmp_path, monkeypatch):
    from homun.application import agent_runs
    ctx = create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    runner = HostedMcpEngineRunner()
    real_propose = agent_runs.propose
    def lost_receipt(*args, **kwargs):
        real_propose(*args, **kwargs)
        raise RuntimeError('crash after canonical proposal commit')
    monkeypatch.setattr(agent_runs, 'propose', lost_receipt)
    with pytest.raises(RuntimeError):
        runner.run_task('recover',ctx=ctx,command_id='retry')
    ctx.close()
    ctx = create_context(db_path=tmp_path/'ws.db',data_dir=tmp_path,for_tests=True)
    monkeypatch.setattr(agent_runs, 'propose', real_propose)
    try:
        result = runner.run_task('recover',ctx=ctx,command_id='retry')
        assert result['status'] == 'pending_approval'
        store = ctx.repository.load()
        assert len(store.works) == 1
        assert len([r for r in store.commands.values() if r.type == 'agent_run.propose']) == 1
    finally: ctx.close()


@pytest.mark.parametrize('mode', ['timeout', 'disconnect'])
def test_relay_ambiguous_transport_never_retries(mode):
    import time
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            requests.append(1)
            if mode == 'timeout': time.sleep(0.15)
            self.close_connection = True
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1',0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        relay = RelayRuntime(endpoint_url=f'http://127.0.0.1:{server.server_port}/dispatch',enabled=True,timeout_seconds=0.05)
        result = relay.execute_operation('work',{})
        assert not result.success
        assert result.error_code == ('runtime_timeout' if mode == 'timeout' else 'runtime_transport_error')
        assert requests == [1]
    finally:
        server.shutdown(); server.server_close(); thread.join()
