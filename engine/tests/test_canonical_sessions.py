"""Repository-backed session lifecycle: actual native execution and fresh consent."""
import json
from copy import deepcopy
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application import agent_runs, session_tools
from homun.application.agent_run_execution import advance
from homun.context import create_context
from homun.domain.errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from homun.models.native_turn import NativeMessage, ToolCall


def runtime():
    from homun.application import session_runtime
    return session_runtime


def completed(setup):
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    responses = iter([
        NativeMessage(role='assistant', tool_calls=[ToolCall(id='read-original', name='read_material', arguments={'material_id': material})]),
        NativeMessage(role='assistant', content='Consegna venerdi: risultato originale'),
    ])
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=next(responses), usage=None)
    assert advance(ctx, 'run') == 'running'
    assert advance(ctx, 'run') == 'completed'
    return ctx, actor, work, material


def test_native_history_export_and_reopen_use_repository(setup):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    view = sessions.get(ctx, actor, work, 'run')
    original = ctx.repository.load().commands['run'].result['_messages']
    assert [row['message'] for row in view['messages']] == original
    assert [row['id'] for row in view['messages']] == [f'run:{i}' for i in range(len(original))]
    exported = sessions.execute(ctx, actor, work, {'action': 'export', 'session_id': 'run', 'redact_secrets': False})
    rows = [json.loads(line) for line in exported['data'].splitlines()]
    assert [row['message'] for row in rows[1:]] == original
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        assert sessions.get(second, actor, work, 'run') == view
        assert not (ctx.data_dir/'sessions.sqlite').exists()
    finally:
        second.close()


def test_fork_fixed_revision_idempotency_cut_and_rewind_audit(setup):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    original = deepcopy(ctx.repository.load().commands['run'].result)
    view = sessions.get(ctx, actor, work, 'run')
    args = {'action': 'fork', 'session_id': 'run', 'command_id': 'branch', 'expected_revision': view['revision'], 'turn_index': len(view['messages'])-1}
    branch = sessions.execute(ctx, actor, work, args)['session']
    assert sessions.execute(ctx, actor, work, args)['session'] == branch
    assert branch['messages'][-1]['message']['role'] == 'tool'
    assert branch['parent_id'] == 'run'
    with pytest.raises(ConflictError):
        sessions.execute(ctx, actor, work, {**args, 'turn_index': 1})
    with pytest.raises(ValidationError, match='unresolved'):
        sessions.execute(ctx, actor, work, {**args, 'command_id': 'bad-cut', 'turn_index': 3})
    rewind = sessions.execute(ctx, actor, work, {**args, 'action': 'rewind', 'command_id': 'rewind'})['session']
    assert rewind['operation'] == 'rewind'
    assert ctx.repository.load().commands['run'].result == original
    assert sessions.get(ctx, actor, work, 'branch')['messages'] == branch['messages']


def test_resume_prepares_new_work_then_approved_model_reads_history_without_replay(setup, monkeypatch):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    original = deepcopy(ctx.repository.load().commands['run'].result)
    args = {'action': 'resume', 'session_id': 'run', 'command_id': 'continue', 'instruction': 'Prepara una nuova nota', 'proposal': {'connection_id': 'openai_compatible'}}
    prepared = sessions.execute(ctx, actor, work, args)
    assert prepared['status'] == 'pending_approval'
    p = prepared['proposal']
    assert p['work_id'] != work
    assert sessions.execute(ctx, actor, work, args) == prepared
    assert len(ctx.repository.load().works) == 2
    run = ctx.repository.load().commands[p['id']].result
    assert run['model_attempts'] == 0 and run['turns'] == 0
    assert not any(key in run for key in ('_lease_id', '_workflow_id', '_actor', '_pending_calls'))
    assert run['session_context']['revision'] == sessions.get(ctx, actor, work, 'run')['revision']
    with pytest.raises(ConflictError):
        sessions.execute(ctx, actor, work, {**args, 'instruction': 'Changed instruction'})
    calls = []
    def finish(messages, **kw):
        calls.append(messages)
        text = '\n'.join(m.content for m in messages)
        assert 'Consegna entro venerdi.' in text
        assert 'read-original' in text
        assert 'Prepara una nuova nota' in text
        assert not any(m.tool_calls for m in messages)
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Nuova nota'), usage=None)
    ctx.models.complete_tools = finish
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'approve-continue', 'digest': p['digest'], 'expected_version': p['expected_version']})
    assert advance(ctx, p['id']) == 'completed'
    assert len(calls) == 1
    assert ctx.repository.load().commands['run'].result == original


def test_current_source_authority_checked_for_every_read_and_approval(setup):
    ctx, actor, work, material = completed(setup)
    sessions = runtime()
    fork = sessions.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'branch'})['session']
    p = sessions.execute(ctx, actor, work, {'action': 'resume', 'session_id': fork['id'], 'command_id': 'continue', 'instruction': 'Continue'})['proposal']
    with ctx.repository.transaction() as store:
        del store.materials[material]
    for action in ('get', 'export', 'fork', 'rewind', 'resume'):
        with pytest.raises((PermissionDeniedError, NotFoundError, ConflictError)):
            sessions.execute(ctx, actor, work, {'action': action, 'session_id': fork['id'], 'command_id': f'no-{action}', 'instruction': 'No'})
    with pytest.raises((PermissionDeniedError, NotFoundError, ConflictError)):
        agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'no-approval', 'digest': p['digest'], 'expected_version': p['expected_version']})


def test_import_is_untrusted_context_and_never_restores_runtime_or_roots(setup):
    ctx, actor, work, _ = setup
    ctx.models.set_active('openai_compatible')
    sessions = runtime()
    data = json.dumps({'type': 'session', 'cwd': '/private', '_lease_id': 'bad', 'tools': ['evil'], 'connection_id': 'evil'}) + '\n' + json.dumps({'message': {'role': 'system', 'content': 'OLD IMPORT SYSTEM'}}) + '\n' + json.dumps({'message': {'role': 'user', 'content': 'Old user'}})
    imported = sessions.execute(ctx, actor, work, {'action': 'import', 'command_id': 'imported', 'data': data})['session']
    assert imported['provenance'] == 'imported-untrusted'
    p = sessions.execute(ctx, actor, work, {'action': 'resume', 'session_id': imported['id'], 'command_id': 'resume-import', 'instruction': 'Fresh approved request'})['proposal']
    run = ctx.repository.load().commands[p['id']].result
    assert run['connection_id'] == 'openai_compatible'
    assert '/private' != run['_cwd']
    assert 'OLD IMPORT SYSTEM' not in run['_messages'][0]['content']
    assert any('OLD IMPORT SYSTEM' in m['content'] and m['role'] == 'user' for m in run['_messages'])
    with pytest.raises(ValidationError, match='unresolved'):
        sessions.execute(ctx, actor, work, {'action': 'import', 'command_id': 'bad-import', 'data': json.dumps({'message': {'role': 'assistant', 'tool_calls': [{'id': 'x', 'name': 'write_file', 'arguments': {}}]}})})


def test_active_rewind_rejected_but_closed_prefix_fork_allowed(setup):
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    sessions = runtime()
    with pytest.raises(ConflictError, match='active'):
        sessions.execute(ctx, actor, work, {'action': 'rewind', 'session_id': 'run', 'command_id': 'rewind', 'turn_index': 2})
    branch = sessions.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'fork', 'turn_index': 2})
    assert branch['session']['parent_id'] == 'run'
    with pytest.raises(ConflictError):
        sessions.execute(ctx, actor, work, {'action': 'fork', 'session_id': 'run', 'command_id': 'wrong', 'expected_revision': 'stale'})


def test_tool_uses_same_canonical_service_and_cross_work_fails(setup):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    run = ctx.repository.load().commands['run'].result
    run['session_management'] = {'policy': 'durable-sessions-v1'}
    got = session_tools.execute(ctx, actor, run, 'session_manage', {'action': 'get', 'session_id': 'run'})
    assert got['session'] == sessions.get(ctx, actor, work, 'run')
    store = ctx.repository.load()
    ctx.service = ctx.service.for_store(store)
    other = ctx.service.apply(actor, 'other', 'work.create', {'conversation_id': store.works[work].primary_conversation_id, 'title': 'Other', 'objective': 'Other'})['work_id']
    ctx.persist()
    with pytest.raises(NotFoundError):
        sessions.get(ctx, actor, other, 'run')
    assert sessions.execute(ctx, actor, other, {'action': 'list'})['sessions'] == []


def test_paused_resume_replays_existing_control_without_second_transition(setup):
    from homun.application.agent_control import control
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    control(ctx, actor, work, 'run', {'command_id': 'pause', 'action': 'pause', 'expected_version': ctx.repository.load().works[work].version})
    args = {'action': 'resume', 'session_id': 'run', 'command_id': 'resume-paused', 'expected_version': ctx.repository.load().works[work].version}
    result = runtime().execute(ctx, actor, work, args)
    version = ctx.repository.load().works[work].version
    assert runtime().execute(ctx, actor, work, args) == result
    assert ctx.repository.load().works[work].version == version
    assert len(ctx.repository.load().works) == 1


def test_inherited_history_redacted_on_existing_run_api_after_revoke(setup):
    ctx, actor, work, material = completed(setup)
    p = runtime().execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'cont', 'instruction': 'Continue'})['proposal']
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'ok-cont', 'digest': p['digest'], 'expected_version': p['expected_version']})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', tool_calls=[ToolCall(id='new-list', name='list_materials')]), usage=None)
    assert advance(ctx, p['id']) == 'running'
    with ctx.repository.transaction() as store:
        del store.materials[material]
    listed = agent_runs.list_runs(ctx, actor, p['work_id'])['items'][0]
    assert listed['history_redacted'] is True
    assert listed['observations'] == []
    with pytest.raises(PermissionDeniedError):
        runtime().get(ctx, actor, p['work_id'], p['id'])
    assert advance(ctx, p['id']) == 'blocked'


def test_prepare_crash_reuses_one_linked_work_and_checks_snapshot_tamper(setup, monkeypatch):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    args = {'action': 'resume', 'session_id': 'run', 'command_id': 'retry', 'instruction': 'Continue'}
    with monkeypatch.context() as patch:
        patch.setattr(agent_runs, 'propose', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('crash')))
        with pytest.raises(RuntimeError, match='crash'):
            sessions.execute(ctx, actor, work, args)
    assert len(ctx.repository.load().works) == 2
    p = sessions.execute(ctx, actor, work, args)['proposal']
    assert len(ctx.repository.load().works) == 2
    with ctx.repository.transaction() as store:
        store.commands['run'].result['_messages'][-1]['content'] = 'tampered'
    with pytest.raises(ConflictError, match='changed'):
        agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'bad-ok', 'digest': p['digest'], 'expected_version': p['expected_version']})


def test_http_read_export_and_metadata_use_current_scope(setup, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from homun.routes import sessions as routes
    ctx, actor, work, material = completed(setup)
    monkeypatch.setattr(routes, 'request_context', lambda *a: (ctx, actor))
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)  # No app lifespan or global user-data context.
    url = f'/v1/workspaces/{actor.workspace_id}/works/{work}/sessions'
    assert client.get(url).json()['sessions'][0]['id'] == 'run'
    assert client.get(url + '/run').json()['messages'] == runtime().get(ctx, actor, work, 'run')['messages']
    export = client.post(url, json={'action': 'export', 'session_id': 'run'})
    assert export.status_code == 200 and 'read-original' in export.json()['data']
    assert client.post(url, json={'action': 'pin', 'session_id': 'run', 'command_id': 'pin'}).json()['session']['pinned'] is True
    with ctx.repository.transaction() as store:
        del store.materials[material]
    assert client.get(url + '/run').status_code == 403
    assert client.get(url).json()['sessions'] == []
    assert client.post(url, json={'action': 'export', 'session_id': 'run'}).status_code == 403


def test_native_session_mutation_dispatch_gets_stable_server_key(setup):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'material_ids': [material], 'session_management': True})
    agent_runs.approve(ctx, actor, work, p['id'], {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    responses = iter([NativeMessage(role='assistant', tool_calls=[ToolCall(id='create-session', name='session_manage', arguments={'action': 'create', 'title': 'My branch'})]), NativeMessage(role='assistant', content='Done')])
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=next(responses), usage=None)
    assert advance(ctx, 'run') == 'running'
    run = ctx.repository.load().commands['run'].result
    result = json.loads(run['_messages'][-1]['content'])
    assert result.get('status') == 'created', result
    session_id = result['session']['id']
    assert runtime().get(ctx, actor, work, session_id)['title'] == 'My branch'
    assert advance(ctx, 'run') == 'completed'
    assert len([r for r in ctx.repository.load().commands.values() if r.type == 'session.snapshot']) == 1


def test_historical_write_receipt_is_context_and_never_dispatched(setup, monkeypatch):
    from homun.application import agent_run_execution
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = agent_runs.propose(ctx, actor, work, {'command_id': 'run', 'expected_version': 1, 'material_ids': [material], 'memory': True})
    agent_runs.approve(ctx, actor, work, p['id'], {'command_id': 'approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    responses = iter([NativeMessage(role='assistant', tool_calls=[ToolCall(id='write-memory', name='memory_remember', arguments={'text': 'Historical persistent write'})]), NativeMessage(role='assistant', content='Stored')])
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=next(responses), usage=None)
    assert advance(ctx, 'run') == 'running'
    assert advance(ctx, 'run') == 'completed'
    before = ctx.memory.list(work_id=work)
    assert len(before) == 1
    p = runtime().execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'continue-write', 'instruction': 'Summarize the prior write'})['proposal']
    monkeypatch.setattr(agent_run_execution, 'run_tool', lambda *a, **k: pytest.fail('Historical write replayed'))
    def finish(messages, **kw):
        assert any('write-memory' in m.content and 'memory_remember' in m.content and 'stored' in m.content for m in messages)
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Summary'), usage=None)
    ctx.models.complete_tools = finish
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'approve-write', 'digest': p['digest'], 'expected_version': p['expected_version']})
    assert advance(ctx, p['id']) == 'completed'
    assert [note.id for note in ctx.memory.list(work_id=work)] == [note.id for note in before]


@pytest.mark.parametrize('action', ['get', 'fork', 'rewind', 'resume', 'update', 'pin', 'archive', 'export', 'handoff'])
def test_missing_session_id_is_domain_validation(setup, action):
    ctx, actor, work, _ = setup
    with pytest.raises(ValidationError, match='session_id'):
        runtime().execute(ctx, actor, work, {'action': action, 'command_id': 'bad'})


def test_foreign_material_project_revocation_keeps_target_work_access_but_redacts_history(setup):
    from homun.domain.models import Actor
    from homun.policy.work import require_work_access
    ctx, actor, work, material = setup
    owner = Actor(id='source-owner', workspace_id=actor.workspace_id, display_name='Source owner')
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        project = service.apply(owner, 'foreign-project', 'project.create', {'name': 'Private sources'})['project_id']
        grant = service.apply(owner, 'source-grant', 'grant.issue', {'project_id': project, 'subject_id': actor.id, 'capability': 'read'})['grant_id']
        store.materials[material].project_id = project
    ctx, actor, work, material = completed(setup)
    sessions = runtime()
    p = sessions.execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'continued', 'instruction': 'Continue'})['proposal']
    with ctx.repository.transaction() as store:
        ctx.service.for_store(store).apply(owner, 'revoke-source', 'grant.revoke', {'grant_id': grant})
        require_work_access(store, actor, p['work_id'], 'read')
    with pytest.raises(PermissionDeniedError):
        sessions.get(ctx, actor, p['work_id'], p['id'])
    assert agent_runs.list_runs(ctx, actor, p['work_id'])['items'][0]['history_redacted'] is True
    with pytest.raises(PermissionDeniedError):
        agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'denied-approval', 'digest': p['digest'], 'expected_version': p['expected_version']})


def test_model_session_tool_cannot_invoke_human_paused_control(setup):
    from homun.application.agent_control import control
    ctx, actor, work, material = setup
    native_start(ctx, actor, work, material)
    control(ctx, actor, work, 'run', {'command_id': 'pause', 'action': 'pause', 'expected_version': ctx.repository.load().works[work].version})
    run = ctx.repository.load().commands['run'].result
    run['session_management'] = {'policy': 'durable-sessions-v1'}
    with pytest.raises(PermissionDeniedError, match='human'):
        session_tools.execute(ctx, actor, run, 'session_manage', {'action': 'resume', 'session_id': 'run', 'command_id': 'model-resume', 'expected_version': ctx.repository.load().works[work].version})
    assert ctx.repository.load().commands['run'].result['status'] == 'paused'


def test_metadata_archive_search_and_exact_snapshot_replay(setup):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    for action in ('create', 'rewind'):
        args = {'action': action, 'command_id': action, 'session_id': 'run'}
        first = sessions.execute(ctx, actor, work, args)
        assert sessions.execute(ctx, actor, work, args) == first
    sessions.execute(ctx, actor, work, {'action': 'update', 'session_id': 'run', 'command_id': 'title', 'title': 'Renamed'})
    sessions.execute(ctx, actor, work, {'action': 'archive', 'session_id': 'run', 'command_id': 'archive'})
    assert not sessions.execute(ctx, actor, work, {'action': 'list', 'query': 'Renamed'})['sessions']
    assert sessions.execute(ctx, actor, work, {'action': 'list', 'query': 'Renamed', 'include_archived': True})['sessions'][0]['id'] == 'run'
    for field in ('cwd', 'model_pin', 'provider_pin', 'parent_id'):
        with pytest.raises(ValidationError):
            sessions.execute(ctx, actor, work, {'action': 'create', 'command_id': f'bad-{field}', field: 'untrusted'})


def test_copied_session_tool_history_retains_revocation_dependency(setup):
    from homun.domain.models import Actor
    from homun.application.agent_tool_registry import registry_for
    ctx, actor, work, material = completed(setup)
    # A consumer in the same work need not select the source material itself.
    with ctx.repository.transaction() as store:
        source = store.commands['run'].result
        consumer = deepcopy(source)
        consumer.update(id='consumer', materials=[], observations=[], _messages=[NativeMessage(role='user', content='Read earlier work').model_dump()], session_management={'policy': 'durable-sessions-v1', 'version': 1})
        consumer.pop('tools', None)
        record = store.commands['run'].model_copy(deep=True)
        record.command_id = 'consumer'; record.result = consumer
        store.commands['consumer'] = record
    consumer = ctx.repository.load().commands['consumer'].result
    result = registry_for(consumer).dispatch('session_manage', {'action': 'get', 'session_id': 'run'}, ctx=ctx, actor=actor, run=consumer)
    with ctx.repository.transaction() as store:
        store.commands['consumer'].result['observations'].append({'result': result})
        store.commands['consumer'].result['_messages'].append(NativeMessage(role='user', content=json.dumps(result)).model_dump())
        del store.materials[material]
    with pytest.raises(PermissionDeniedError):
        runtime().get(ctx, actor, work, 'consumer')
    assert agent_runs.list_runs(ctx, actor, work)['items'][-1]['history_redacted'] is True


@pytest.mark.parametrize('action', ['get', 'export', 'list'])
def test_tool_pins_exact_returned_prefix_not_concurrent_rewrite(setup, monkeypatch, action):
    ctx, actor, work, _ = completed(setup)
    sessions = runtime()
    with ctx.repository.transaction() as store:
        consumer = deepcopy(store.commands['run'].result)
        consumer.update(id='consumer', materials=[], _messages=[NativeMessage(role='user', content='Read').model_dump()], session_management={'policy': 'durable-sessions-v1'})
        record = store.commands['run'].model_copy(deep=True); record.command_id = 'consumer'; record.result = consumer
        store.commands['consumer'] = record
    original = sessions.execute
    def changed_after_read(*args, **kwargs):
        result = original(*args, **kwargs)
        with ctx.repository.transaction() as store:
            store.commands['run'].result['_messages'][-1]['content'] = 'Concurrent rewrite'
        return result
    monkeypatch.setattr(sessions, 'execute', changed_after_read)
    with pytest.raises(ConflictError, match='changed'):
        session_tools.execute(ctx, actor, consumer, 'session_manage', {'action': action, 'session_id': 'run'})


def test_export_action_normalization_cannot_skip_provenance(setup):
    ctx, actor, work, material = completed(setup)
    with ctx.repository.transaction() as store:
        consumer = deepcopy(store.commands['run'].result)
        consumer.update(id='consumer', materials=[], _messages=[NativeMessage(role='user', content='Read').model_dump()], session_management={'policy': 'durable-sessions-v1'})
        record = store.commands['run'].model_copy(deep=True); record.command_id = 'consumer'; record.result = consumer
        store.commands['consumer'] = record
    result = session_tools.execute(ctx, actor, consumer, 'session_manage', {'action': ' EXPORT ', 'session_id': 'run'})
    assert 'venerdi' in result['data']
    assert ctx.repository.load().commands['consumer'].result['_session_dependencies']


def test_continuation_revalidates_transitive_tool_source_material_version(setup):
    ctx, actor, work, material = completed(setup)
    with ctx.repository.transaction() as store:
        consumer = deepcopy(store.commands['run'].result)
        consumer.update(id='consumer', materials=[], _messages=[NativeMessage(role='user', content='Read').model_dump()], session_management={'policy': 'durable-sessions-v1'})
        record = store.commands['run'].model_copy(deep=True); record.command_id = 'consumer'; record.result = consumer
        store.commands['consumer'] = record
    session_tools.execute(ctx, actor, consumer, 'session_manage', {'action': 'get', 'session_id': 'run'})
    p = runtime().execute(ctx, actor, work, {'action': 'resume', 'session_id': 'consumer', 'command_id': 'transitive', 'instruction': 'Continue'})['proposal']
    with ctx.repository.transaction() as store:
        store.materials[material].version += 1
    with pytest.raises(ConflictError, match='material changed'):
        agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'transitive-approve', 'digest': p['digest'], 'expected_version': p['expected_version']})


def test_revoked_continuation_redacts_derived_clarification_and_automation_reason(setup, monkeypatch):
    from homun.domain.models import Actor
    ctx, actor, work, material = setup
    owner = Actor(id='source-owner', workspace_id=actor.workspace_id, display_name='Source owner')
    with ctx.repository.transaction() as store:
        service = ctx.service.for_store(store)
        project = service.apply(owner, 'foreign-project', 'project.create', {'name': 'Private sources'})['project_id']
        grant = service.apply(owner, 'source-grant', 'grant.issue', {'project_id': project, 'subject_id': actor.id, 'capability': 'read'})['grant_id']
        store.materials[material].project_id = project
    completed(setup)
    p = runtime().execute(ctx, actor, work, {'action': 'resume', 'session_id': 'run', 'command_id': 'clarification-continuation', 'instruction': 'Continue', 'proposal': {'clarify': True}})['proposal']
    agent_runs.approve(ctx, actor, p['work_id'], p['id'], {'command_id': 'clarification-approve', 'digest': p['digest'], 'expected_version': p['expected_version']})
    secret = 'Consegna entro venerdi: confermi questo dato riservato?'
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(role='assistant', tool_calls=[ToolCall(id='ask-secret', name='clarify', arguments={'question': secret})]), usage=None)
    assert advance(ctx, p['id']) == 'waiting_input'
    assert secret in json.dumps(agent_runs.list_runs(ctx, actor, p['work_id']))
    with ctx.repository.transaction() as store:
        # Automation reasons are likewise derived freeform model output.
        store.commands[p['id']].result['automation_wait'] = {'reason': secret}
        ctx.service.for_store(store).apply(owner, 'revoke-source', 'grant.revoke', {'grant_id': grant})
    view = agent_runs.list_runs(ctx, actor, p['work_id'])['items'][0]
    assert view['history_redacted'] is True
    assert secret not in json.dumps(view)
    assert not view.get('clarify_request') and not view.get('automation_wait')
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from homun.routes import agent_runs as routes
    monkeypatch.setattr(routes, 'request_context', lambda *args: (ctx, actor))
    app = FastAPI(); app.include_router(routes.router)
    response = TestClient(app).get(f"/v1/workspaces/{actor.workspace_id}/works/{p['work_id']}/agent-runs")
    assert response.status_code == 200
    assert response.json()['items'][0]['history_redacted'] is True
    assert secret not in response.text

