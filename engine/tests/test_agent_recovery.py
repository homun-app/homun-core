"""Durable retries recover model calls, never committed tool effects."""
from datetime import timedelta
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application.agent_run_execution import advance
from homun.application.agent_control import control
from homun.context import create_context
from homun.domain.models import utc_now
from homun.models.native_turn import NativeMessage,ToolCall
from homun.models.native_errors import NativeModelError


def final():
    return SimpleNamespace(message=NativeMessage(role='assistant',content='Nota conclusiva.'),usage=None)


def due(ctx,run_id):
    with ctx.repository.transaction() as store:
        store.commands[run_id].result['recovery']['next_attempt_at']=(utc_now()-timedelta(seconds=1)).isoformat()


def test_transient_retry_waits_then_accepts_one_round(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material);calls=[]
    def complete(*a,**k):
        calls.append(True)
        if len(calls)==1:raise NativeModelError('agent_model_server_error','Temporary model service failure',retryable=True,retry_after_seconds=30)
        return final()
    ctx.models.complete_tools=complete
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['recovery']['status']=='waiting' and run['recovery']['attempts']==1
    assert '_lease_token' not in run
    assert advance(ctx,p['id'])=='busy' and len(calls)==1
    due(ctx,p['id'])
    assert advance(ctx,p['id'])=='completed'
    store=ctx.repository.load();run=store.commands[p['id']].result
    assert len(calls)==2 and run['model_attempts']==2 and run['turns']==1
    assert store.work_budgets[work].unknown.attempts==2
    assert run['recovery']['status']=='recovered'
    assert len(store.artifacts)==1


def test_three_total_attempts_survive_process_context_restart(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def unavailable(*a,**k):raise NativeModelError('agent_model_server_error','Unavailable',retryable=True)
    ctx.models.complete_tools=unavailable
    assert advance(ctx,p['id'])=='running'
    due(ctx,p['id'])
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        second.models.complete_tools=unavailable
        assert advance(second,p['id'])=='running'
        due(second,p['id'])
        assert advance(second,p['id'])=='failed'
        saved=second.repository.load().commands[p['id']].result
        assert saved['model_attempts']==3 and saved['recovery']['status']=='exhausted'
        assert advance(second,p['id'])=='failed'
        assert not second.repository.load().artifacts
    finally:second.close()


def test_truncated_response_charges_known_usage_without_dispatch(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def incomplete(*a,**k):raise NativeModelError('agent_model_truncated','Incomplete response',usage=SimpleNamespace(input_tokens=72,output_tokens=32))
    ctx.models.complete_tools=incomplete
    assert advance(ctx,p['id'])=='failed'
    store=ctx.repository.load();run=store.commands[p['id']].result
    assert run['error_code']=='agent_model_truncated'
    assert run['turns']==0 and run['observations']==[] and len(run['_messages'])==2
    budget=store.work_budgets[work]
    assert budget.spent.input_tokens==72 and budget.spent.output_tokens==32
    assert budget.spent.attempts==1 and budget.unknown.attempts==0


@pytest.mark.parametrize('action',['cancel','pause','redirect'])
def test_control_during_retry_wait_invalidates_old_delivery(setup,action):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(NativeModelError('agent_model_rate_limited','Rate limited',retryable=True,retry_after_seconds=600))
    assert advance(ctx,p['id'],epoch=0)=='running'
    control(ctx,actor,work,p['id'],{'command_id':'control','expected_version':ctx.repository.load().works[work].version,'action':action,'text':'Rivedi la nota' if action=='redirect' else None})
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Old workflow must not issue another request')
    assert advance(ctx,p['id'],epoch=0)=='superseded'
    assert ctx.repository.load().commands[p['id']].result['recovery']['status']=='interrupted'


def test_recovery_does_not_repeat_a_committed_tool(setup,monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material);calls=[];reads=[]
    real=agent_run_execution.run_tool
    def read(*a,**k):reads.append(True);return real(*a,**k)
    monkeypatch.setattr(agent_run_execution,'run_tool',read)
    def complete(*a,**k):
        calls.append(True)
        if len(calls)==1:return SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='read',name='read_material',arguments={'material_id':material})]),usage=None)
        if len(calls)==2:raise NativeModelError('agent_model_timeout','Timed out',retryable=True)
        return final()
    ctx.models.complete_tools=complete
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='running'
    due(ctx,p['id'])
    assert advance(ctx,p['id'])=='completed'
    assert len(reads)==1 and len(calls)==3


# --- typed classification, honest usage extraction, bounded waits -------------

def test_transport_failure_classes_local_http_statuses_with_retry_after():
    import http.server, json as jsonlib, threading
    from homun.models.openai_compat import OpenAICompatibleProvider
    from homun.models.secrets import MemorySecretStore
    from homun.models.native_transport import complete_tools
    from homun.models.agent_turn import ToolDefinition
    from datetime import datetime, timedelta, timezone
    queue = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            status, headers, body = queue.pop(0) if queue else (500, {}, {})
            payload = jsonlib.dumps(body).encode()
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        secrets = MemorySecretStore()
        secrets.put('provider:openai_compatible:api_key', 'test-key')
        provider = OpenAICompatibleProvider(
            secrets=secrets, base_url=f'http://127.0.0.1:{server.server_address[1]}/v1')
        tools = [ToolDefinition(name='list_materials', description='List', input_schema={'type': 'object'})]
        messages = [NativeMessage(role='user', content='Read')]
        future = (datetime.now(timezone.utc) + timedelta(seconds=300)
                  ).strftime('%a, %d %b %Y %H:%M:%S GMT')
        cases = [
            ((429, {'Retry-After': '120'}, {'error': {'message': 'slow down'}}),
             'agent_model_rate_limited', True, 120.0),
            ((429, {'Retry-After': future}, {'error': {'message': 'slow down'}}),
             'agent_model_rate_limited', True, 300.0),
            ((429, {'Retry-After': '900'}, {'error': {'message': 'slow down'}}),
             'agent_model_rate_limited', True, 600.0),
            ((429, {}, {'error': {'code': 'insufficient_quota', 'message': 'You exceeded your current quota'}}),
             'agent_model_quota', False, None),
            ((503, {}, {'error': 'overloaded'}),
             'agent_model_server_error', True, None),
            ((401, {}, {'error': 'bad key'}),
             'agent_model_auth', False, None),
            ((400, {}, {'error': {"message": "This model's maximum context length is 4097 tokens."}}),
             'agent_model_overflow', False, None),
        ]
        for (status, headers, body), code, retryable, retry_after in cases:
            queue.append((status, headers, body))
            with pytest.raises(NativeModelError) as caught:
                complete_tools(provider, messages, tools=tools)
            error = caught.value
            assert error.code == code and error.retryable is retryable, error
            if retry_after is None:
                assert error.retry_after_seconds is None
            elif code == 'agent_model_rate_limited' and retry_after == 300.0:
                assert 290.0 < error.retry_after_seconds <= 300.0
            else:
                assert error.retry_after_seconds == retry_after
    finally:
        server.shutdown()


def test_truncated_transport_reply_preserves_reported_usage():
    import http.server, json as jsonlib, threading
    from homun.models.openai_compat import OpenAICompatibleProvider
    from homun.models.secrets import MemorySecretStore
    from homun.models.native_transport import complete_tools
    body = {'choices': [{'message': {'content': 'partial text'}, 'finish_reason': 'length'}],
            'usage': {'prompt_tokens': 72, 'completion_tokens': 32}}
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            payload = jsonlib.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        secrets = MemorySecretStore()
        secrets.put('provider:openai_compatible:api_key', 'test-key')
        provider = OpenAICompatibleProvider(
            secrets=secrets, base_url=f'http://127.0.0.1:{server.server_address[1]}/v1')
        with pytest.raises(NativeModelError) as caught:
            complete_tools(provider, [NativeMessage(role='user', content='Read')], tools=[])
        error = caught.value
        assert error.code == 'agent_model_truncated' and not error.retryable
        assert error.usage.input_tokens == 72 and error.usage.output_tokens == 32
        assert error.usage.status == 'error'
    finally:
        server.shutdown()


def test_backoff_uses_capped_retry_after_else_jittered_base2():
    from homun.models.native_errors import retry_delay, sanitize, parse_retry_after
    capped = NativeModelError('agent_model_rate_limited', 'limited', retryable=True,
                              retry_after_seconds=9000)
    assert retry_delay(1, capped) == 600.0
    for attempts in (1, 2, 3):
        wait = retry_delay(attempts, NativeModelError('agent_model_server_error', 'x', retryable=True))
        floor = 2.0 * (2 ** (attempts - 1))
        assert floor <= wait <= floor * 1.5 + 1e-9
    zero = NativeModelError('agent_model_rate_limited', 'x', retryable=True, retry_after_seconds=0)
    assert retry_delay(1, zero) >= 2.0
    assert parse_retry_after({'Retry-After': '30'}) == 30.0
    assert sanitize('a\n  b\n\nc' * 200) == ('a b c' * 200)[:300]
    assert sanitize(None) == ''


def test_response_shape_failures_map_to_empty_malformed_and_content_filter():
    from homun.models.native_errors import classify_response
    empty = classify_response(ValueError('Agent response contains neither tools nor a final answer'))
    assert empty.code == 'agent_model_empty_response' and empty.retryable
    malformed = classify_response(ValueError('Malformed native agent response'))
    assert malformed.code == 'agent_model_malformed' and malformed.retryable
    filtered = classify_response(ValueError('Incomplete agent response: content_filter'))
    assert filtered.code == 'agent_model_invalid_request' and not filtered.retryable


def test_control_during_failing_call_fences_recovery(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def failing(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'cancel','expected_version':ctx.repository.load().works[work].version,'action':'cancel'})
        raise NativeModelError('agent_model_server_error','Late failure',retryable=True)
    ctx.models.complete_tools=failing
    assert advance(ctx,p['id'])=='cancelled'
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['status']=='cancelled'
    # A fenced delivery schedules nothing: the control generation owns the run.
    assert saved.get('recovery',{}).get('status')!='waiting'
    assert '_lease_token' not in saved
    assert not ctx.repository.load().artifacts


def test_summary_phase_retries_durrably_without_touching_decide_counter(setup):
    from homun.application.agent_context import prepare, ContextPreparationDeferred
    from homun.application.agent_run_execution import _claim
    from test_agent_context import pressured, summary
    ctx,actor,work,material=setup
    p,run=pressured(ctx,actor,work,material)
    calls=[]
    def flaky(*a,**k):
        calls.append(True)
        if len(calls)==1:
            raise NativeModelError('agent_model_server_error','Summarizer unavailable',retryable=True)
        return summary()
    ctx.models.complete_summary=flaky
    with pytest.raises(ContextPreparationDeferred):prepare(ctx,run,[])
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['recovery']['phase']=='summary' and saved['recovery']['attempts']==1
    assert '_lease_token' not in saved and '_context_checkpoint' not in saved
    assert _claim(ctx,p['id'])==('busy',None)
    due(ctx,p['id'])
    _,again=_claim(ctx,p['id'])
    result=prepare(ctx,again,[])
    saved=ctx.repository.load().commands[p['id']].result
    assert len(calls)==2 and len(result)<len(saved['_messages'])
    assert saved['recovery']['status']=='recovered' and saved['recovery']['attempts']==0
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    # The decide phase owns its own counter even right after a summary recovery.
    def unavailable(*a,**k):raise NativeModelError('agent_model_timeout','Timed out',retryable=True)
    ctx.models.complete_tools=unavailable
    assert advance(ctx,p['id'])=='running'
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['recovery']['phase']=='decide' and saved['recovery']['attempts']==1
