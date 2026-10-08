"""Canonical runtime choices survive defaults and reach actual provider requests."""
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application import agent_runs, session_runtime
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage
from homun.models.types import UsageEntry


def begin(setup, **options):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'session_management': True, 'material_ids': [material], **options})
    agent_runs.approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    return ctx, actor, work, material


def complete(ctx):
    called = []
    def model(*args, **kwargs):
        called.append(kwargs)
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=UsageEntry(id='reported', provider_id='openai_compatible', model_id='resolved-alias', input_tokens=1, output_tokens=2))
    ctx.models.complete_tools = model
    assert advance(ctx, 'run') == 'completed'
    return called


def test_explicit_native_model_reaches_provider_and_requested_receipt(setup):
    ctx, actor, work, _ = begin(setup, model_id='requested-alias')
    original = ctx.models.get_connection('openai_compatible').model_id
    called = complete(ctx)
    assert called[0]['model_id'] == 'requested-alias'
    receipt, = ctx.repository.load().budget_usage_receipts.values()
    assert receipt.requested_model_id == 'requested-alias'
    assert receipt.reported_model_id == 'resolved-alias'
    assert ctx.models.get_connection('openai_compatible').model_id == original


def test_resume_restores_actual_requested_choice_and_metadata_affects_only_future(setup):
    ctx, actor, work, _ = begin(setup, model_id='source-model')
    complete(ctx)
    ctx.models.set_active('fake')
    args = {'action': 'resume', 'session_id': 'run', 'command_id': 'continue', 'instruction': 'Continue'}
    first = session_runtime.execute(ctx, actor, work, args)['proposal']
    assert first['runtime_selection']['model_id'] == 'source-model'
    assert first['connection_id'] == 'openai_compatible'
    session_runtime.execute(ctx, actor, work, {'action': 'update', 'session_id': 'run', 'command_id': 'preference', 'model_pin': 'next-model', 'provider_pin': 'openai_compatible'})
    second = session_runtime.execute(ctx, actor, work, {**args, 'command_id': 'next'})['proposal']
    assert second['runtime_selection']['model_id'] == 'next-model'
    assert ctx.repository.load().commands[first['id']].result['runtime_selection']['model_id'] == 'source-model'
    explicit = session_runtime.execute(ctx, actor, work, {**args, 'command_id': 'override', 'proposal': {'connection_id': 'openai_compatible', 'model_id': 'explicit-model'}})['proposal']
    assert explicit['runtime_selection']['model_id'] == 'explicit-model'


@pytest.fixture
def local_model_http():
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    seen = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append((body, self.headers.get('Authorization')))
            payload = json.dumps({'model': 'provider-resolved-alias', 'choices': [{'message': {'role': 'assistant', 'content': 'Done'}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 7, 'completion_tokens': 3}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/v1', seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_local_http_continuation_uses_requested_model_and_fresh_credentials(setup, local_model_http):
    url, seen = local_model_http
    ctx, actor, work, _ = setup
    ctx.models.set_openai_credentials(api_key='first-test-key', base_url=url, default_model='ambient-model')
    begin(setup, model_id='source-model', native_stream=False)
    assert advance(ctx, 'run') == 'completed'
    p = session_runtime.execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'http-continue', 'instruction': 'Continue', 'proposal': {'model_id': 'explicit-http-model', 'connection_id': 'openai_compatible', 'native_stream': False}})['proposal']
    ctx.models.set_openai_credentials(api_key='new-test-key', default_model='changed-ambient')
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'approve-http', 'digest': p['digest'], 'expected_version': p['expected_version']})
    assert advance(ctx, p['id']) == 'completed'
    assert [body['model'] for body, _ in seen] == ['source-model', 'explicit-http-model']
    assert seen[-1][1] == 'Bearer new-test-key'
    receipts = list(ctx.repository.load().budget_usage_receipts.values())
    assert receipts[-1].requested_model_id == 'explicit-http-model'
    assert receipts[-1].reported_model_id == 'provider-resolved-alias'
    assert receipts[-1].input_tokens == 7
    assert ctx.models.get_connection('openai_compatible').model_id == 'changed-ambient'


def test_fork_chain_freezes_preferences_at_each_branch(setup):
    ctx, actor, work, _ = begin(setup, model_id='source-model')
    complete(ctx)
    session_runtime.execute(ctx, actor, work, {'action': 'update', 'session_id': 'run', 'command_id': 'pin-before', 'model_pin': 'branch-model'})
    session_runtime.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'branch1'})
    session_runtime.execute(ctx, actor, work, {'action': 'update', 'session_id': 'run', 'command_id': 'pin-after', 'model_pin': 'later-model'})
    session_runtime.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'branch1', 'command_id': 'branch2'})
    p = session_runtime.execute(ctx, actor, work, {'action': 'resume', 'session_id': 'branch2', 'command_id': 'branch-continue', 'instruction': 'Continue'})['proposal']
    assert p['runtime_selection']['model_id'] == 'branch-model'


@pytest.mark.parametrize('operation', ['side', 'judge', 'compact', 'legacy'])
def test_auxiliary_and_legacy_calls_use_the_pinned_requested_model(setup, operation):
    from homun.application.agent_run_execution import _claim
    ctx, actor, work, material = begin(setup, model_id='pinned-call', **({'connection_id': 'fake', 'session_management': False} if operation == 'legacy' else {}))
    called = []
    if operation == 'legacy':
        import json
        with ctx.repository.transaction() as store:
            store.commands['run'].result['_protocol'] = 'json-decision-v1'
        ctx.models.complete = lambda *a, **k: (called.append(k) or SimpleNamespace(text=json.dumps({'kind': 'finish', 'message': 'Done'}), usage=None))
        advance(ctx, 'run')
    elif operation == 'side':
        from homun.application.agent_side_questions import answer_side_question
        ctx.models.complete_summary = lambda *a, **k: (called.append(k) or SimpleNamespace(message=NativeMessage(role='assistant', content='Side'), usage=None))
        answer_side_question(ctx, actor, work, 'run', 'Question')
    elif operation == 'judge':
        from homun.application.goal_judge import judge
        _, run = _claim(ctx, 'run')
        ctx.models.complete = lambda *a, **k: (called.append(k) or SimpleNamespace(text='{"verdict":"done","reason":"Done"}', usage=None))
        judge(ctx, run)
    else:
        from homun.application.agent_context import prepare
        from homun.models.native_turn import ToolCall
        from test_agent_context import summary
        with ctx.repository.transaction() as store:
            run = store.commands['run'].result
            for index in range(6):
                run['_messages'].append(NativeMessage(role='assistant', tool_calls=[ToolCall(id=f'c{index}', name='read_material', arguments={'material_id': material})]).model_dump())
                run['_messages'].append(NativeMessage(role='tool', tool_call_id=f'c{index}', name='read_material', content='old context '*700).model_dump())
            run['_context_policy'] = {'context_window': 4096, 'max_output_tokens': 512}
        _, run = _claim(ctx, 'run')
        ctx.models.complete_summary = lambda *a, **k: (called.append(k) or summary())
        prepare(ctx, run, [])
    assert called[0]['model_id'] == 'pinned-call'
    assert next(iter(ctx.repository.load().budget_usage_receipts.values())).requested_model_id == 'pinned-call'


@pytest.mark.parametrize('failed', [False, True])
def test_fallback_pins_its_own_model_and_persists_effective_choice(setup, monkeypatch, failed):
    from homun.models.native_errors import NativeModelError, TIMEOUT
    ctx, actor, work, _ = setup
    original = ctx.models.get_connection
    monkeypatch.setattr(ctx.models, 'get_connection', lambda ident: original('openai_compatible').model_copy(update={'id': 'backup', 'model_id': 'backup-model', 'active': False}) if ident == 'backup' else original(ident))
    begin(setup, model_id='primary-model', fallback_connection_id='backup')
    seen = []
    def model(*args, **kwargs):
        seen.append((kwargs['connection_id'], kwargs['model_id']))
        if kwargs['connection_id'] == 'openai_compatible' or failed:
            raise NativeModelError(TIMEOUT, 'retryable primary, terminal backup', retryable=kwargs['connection_id'] == 'openai_compatible')
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=None)
    ctx.models.complete_tools = model
    assert advance(ctx, 'run') == ('failed' if failed else 'completed')
    assert seen == [('openai_compatible', 'primary-model'), ('backup', 'backup-model')]
    saved = ctx.repository.load().commands['run'].result
    assert saved['runtime_selection']['connection_id'] == saved['connection_id'] == 'backup'
    assert saved['runtime_selection']['model_id'] == 'backup-model'
    p = session_runtime.execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'fallback-continue', 'instruction': 'Continue'})['proposal']
    assert p['runtime_selection']['model_id'] == 'backup-model'


def test_moa_default_models_stay_pinned_when_ambient_model_changes(setup):
    ctx, actor, work, _ = begin(setup, model_id='approved-moa', moa=True)
    ctx.models.set_openai_credentials(api_key='test-only', default_model='new-ambient')
    seen = []
    ctx.models.complete_tools = lambda *a, **k: (seen.append(k['model_id']) or SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=None))
    assert advance(ctx, 'run') == 'completed'
    assert seen == ['approved-moa', 'approved-moa']
    assert {receipt.requested_model_id for receipt in ctx.repository.load().budget_usage_receipts.values()} == {'approved-moa'}


@pytest.mark.parametrize('change', ['endpoint', 'unconfigured', 'missing'])
def test_runtime_configuration_change_blocks_approval_and_execution(setup, monkeypatch, change):
    from homun.domain.errors import DomainError, NotFoundError
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    p = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'model_id': 'pinned'})
    original = ctx.models.get_connection
    def changed(ident):
        if change == 'missing':
            raise NotFoundError('Removed')
        return original(ident).model_copy(update={'base_url': 'http://localhost:9999/v1'} if change == 'endpoint' else {'configured': False})
    monkeypatch.setattr(ctx.models, 'get_connection', changed)
    with pytest.raises(DomainError):
        agent_runs.approve(ctx, actor, work, 'run', {'command_id': 'deny', 'digest': p['digest'], 'expected_version': p['expected_version']})
    monkeypatch.setattr(ctx.models, 'get_connection', original)
    agent_runs.approve(ctx, actor, work, 'run', {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    monkeypatch.setattr(ctx.models, 'get_connection', changed)
    ctx.models.complete_tools = lambda *a, **k: pytest.fail('Changed runtime reached provider')
    assert advance(ctx, 'run') in {'failed', 'blocked'}
    assert not ctx.repository.load().budget_usage_receipts


def test_legacy_source_missing_provenance_accepts_explicit_fresh_selection(setup):
    from homun.domain.errors import ValidationError
    ctx, actor, work, _ = begin(setup)
    complete(ctx)
    with ctx.repository.transaction() as store:
        store.commands['run'].result.pop('runtime_selection')
        store.commands['run'].result.pop('_runtime_routes')
        store.budget_usage_receipts.clear()
    args = {'action': 'resume', 'session_id': 'run', 'command_id': 'old-source', 'instruction': 'Continue'}
    with pytest.raises(ValidationError):
        session_runtime.execute(ctx, actor, work, args)
    p = session_runtime.execute(ctx, actor, work, {**args, 'command_id': 'fresh-choice', 'proposal': {'connection_id': 'openai_compatible', 'model_id': 'explicit'}})['proposal']
    assert p['runtime_selection']['model_id'] == 'explicit'


def test_preference_replay_conflict_reopen_and_source_revocation(setup):
    from homun.context import create_context
    from homun.domain.errors import DomainError, ConflictError
    ctx, actor, work, material = begin(setup)
    complete(ctx)
    args = {'action': 'update', 'session_id': 'run', 'command_id': 'pref', 'model_pin': 'saved'}
    first = session_runtime.execute(ctx, actor, work, args)
    assert session_runtime.execute(ctx, actor, work, args) == first
    with pytest.raises(ConflictError):
        session_runtime.execute(ctx, actor, work, {**args, 'model_pin': 'conflict'})
    reopened = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        assert session_runtime.execute(reopened, actor, work, args) == first
        p = session_runtime.execute(reopened, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'reopened', 'instruction': 'Continue'})['proposal']
        assert p['runtime_selection']['model_id'] == 'saved'
        with reopened.repository.transaction() as store:
            del store.materials[material]
        with pytest.raises(DomainError):
            agent_runs.approve(reopened, actor, p['work_id'], p['id'], {'command_id': 'denied', 'digest': p['digest'], 'expected_version': p['expected_version']})
    finally:
        reopened.close()


def test_ambiguous_provider_and_malformed_model_preferences_are_typed(setup, monkeypatch):
    from homun.domain.errors import DomainError
    ctx, actor, work, _ = begin(setup)
    complete(ctx)
    original = ctx.models.list_connections
    connection = ctx.models.get_connection('openai_compatible')
    monkeypatch.setattr(ctx.models, 'list_connections', lambda: [connection.model_copy(update={'id': 'one'}), connection.model_copy(update={'id': 'two'})])
    with pytest.raises(DomainError):
        session_runtime.execute(ctx, actor, work, {'action': 'update', 'session_id': 'run', 'command_id': 'ambiguous', 'provider_pin': 'openai_compatible'})
    monkeypatch.setattr(ctx.models, 'list_connections', original)
    for index, model in enumerate([' ', 0, [], {'x': 'y'}]):
        with pytest.raises(DomainError):
            session_runtime.execute(ctx, actor, work, {'action': 'update', 'session_id': 'run', 'command_id': f'bad{index}', 'model_pin': model})


@pytest.fixture
def second_local_model_http():
    yield from local_model_http.__wrapped__()


def test_transport_selection_cannot_race_to_an_unapproved_endpoint(setup, local_model_http, second_local_model_http, monkeypatch):
    approved_url, approved_calls = local_model_http
    unapproved_url, unapproved_calls = second_local_model_http
    ctx, actor, work, _ = setup
    ctx.models.set_openai_credentials(api_key='test-key', base_url=approved_url)
    begin(setup, model_id='pinned-model', native_stream=False)
    original = ctx.models.complete_tools
    def change_before_transport(*args, **kwargs):
        ctx.models.set_openai_credentials(api_key='rotated-key', base_url=unapproved_url)
        return original(*args, **kwargs)
    monkeypatch.setattr(ctx.models, 'complete_tools', change_before_transport)
    assert advance(ctx, 'run') in {'blocked', 'failed'}
    assert not unapproved_calls and not approved_calls


@pytest.mark.parametrize('method', ['complete', 'complete_summary'])
def test_aux_transport_checks_actual_endpoint(setup, local_model_http, second_local_model_http, monkeypatch, method):
    from homun.application import runtime_calls
    from homun.domain.errors import ConflictError
    from homun.models.types import ChatMessage
    approved_url, approved_calls = local_model_http
    unapproved_url, unapproved_calls = second_local_model_http
    ctx, *_ = setup
    ctx.models.set_openai_credentials(api_key='test-key', base_url=approved_url)
    begin(setup, model_id='pinned-model')
    run = ctx.repository.load().commands['run'].result
    original = getattr(ctx.models, method)
    def change_before_transport(*args, **kwargs):
        ctx.models.set_openai_credentials(api_key='rotated-key', base_url=unapproved_url)
        return original(*args, **kwargs)
    monkeypatch.setattr(ctx.models, method, change_before_transport)
    messages = [ChatMessage(role='user', content='Hello')] if method == 'complete' else [NativeMessage(role='user', content='Hello')]
    with pytest.raises(ConflictError):
        getattr(runtime_calls, method)(ctx, run, messages)
    assert not unapproved_calls and not approved_calls


@pytest.mark.parametrize('method', ['complete', 'complete_tools', 'complete_summary'])
def test_custom_connection_adapter_runtime_binding(local_model_http, second_local_model_http, method):
    from homun.application.runtime_selection import resolve
    from homun.domain.errors import ConflictError
    from homun.models.adapters.openai_compat import OpenAICompatModelAdapter
    from homun.models.secrets import MemorySecretStore
    from homun.models.types import ChatMessage
    approved_url, approved_calls = local_model_http
    unapproved_url, unapproved_calls = second_local_model_http
    adapter = OpenAICompatModelAdapter(secrets=MemorySecretStore(), base_url=approved_url, connection_id='custom-http')
    expected = resolve(adapter, connection_id='custom-http', model_id='approved-model')
    messages = [ChatMessage(role='user', content='Hello')] if method == 'complete' else [NativeMessage(role='user', content='Hello')]
    getattr(adapter, method)(messages, connection_id='custom-http', model_id='approved-model', expected_runtime=expected)
    assert approved_calls[0][0]['model'] == 'approved-model'
    adapter.upsert_connection(connection_id='custom-http', kind='openai_compatible', display_name='Changed', model_id='new-default', base_url=unapproved_url)
    with pytest.raises(ConflictError):
        getattr(adapter, method)(messages, connection_id='custom-http', model_id='approved-model', expected_runtime=expected)
    assert not unapproved_calls


def test_fake_adapter_custom_connection_runtime_binding():
    from homun.application.runtime_selection import resolve
    from homun.models.adapters.fake import FakeModelAdapter
    from homun.models.types import ChatMessage
    adapter = FakeModelAdapter()
    adapter.upsert_connection(connection_id='custom-fake', kind='fake', display_name='Custom', model_id='default')
    expected = resolve(adapter, connection_id='custom-fake', model_id='approved-model')
    result = adapter.complete([ChatMessage(role='user', content='Hello')], connection_id='custom-fake', model_id='approved-model', expected_runtime=expected)
    assert result.usage.model_id == 'approved-model'
