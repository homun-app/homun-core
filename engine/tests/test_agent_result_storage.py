import json
import pytest
from test_agent_runs import setup
from homun.domain.errors import ValidationError, ConflictError


def test_large_result_preserves_error_and_reconstructs_exact_json():
    from homun.application.agent_results import project, read
    run={'_result_storage_version':1}
    original={'is_error':True,'error_code':'partial_failure','text':'head'+('α"\\\n'*12000)+'tail'}
    preview=project(run,'tool','call',original)
    assert preview['is_error'] is True and preview['error_code']=='partial_failure'
    assert len(json.dumps(preview))<12000
    ref=preview['result_ref'];parts=[];offset=0
    while True:
        page=read(run,{'result_ref':ref,'offset':offset,'limit':1000})
        assert page['is_error'] is True
        parts.append(page['text'])
        if page['next_offset'] is None:break
        offset=page['next_offset']
    assert json.loads(''.join(parts))==original


def test_literal_search_finds_middle_without_another_external_call():
    from homun.application.agent_results import project, read
    run={'_result_storage_version':1}
    preview=project(run,'tool','call',{'text':'x'*14000+'MIDDLE: 8 ottobre 2026'+'y'*14000})
    page=read(run,{'result_ref':preview['result_ref'],'query':'MIDDLE','offset':0,'limit':1000})
    assert '8 ottobre 2026' in page['text'] and page['match_offset']>10000
    assert read(run,{'result_ref':preview['result_ref'],'query':'absent','offset':0,'limit':1000})['found'] is False


def test_reference_is_run_scoped_and_corruption_fails_closed():
    from homun.application.agent_results import project, read
    run={'_result_storage_version':1}
    preview=project(run,'tool','call',{'text':'x'*20000});ref=preview['result_ref']
    with pytest.raises(ValidationError):read({}, {'result_ref':ref,'offset':0,'limit':1000})
    run['_tool_results'][ref]['text']='changed'
    with pytest.raises(ConflictError):read(run,{'result_ref':ref,'offset':0,'limit':1000})


def test_small_and_legacy_results_are_unchanged():
    from homun.application.agent_results import project
    for run,result in [({}, {'text':'x'*20000}),({'_result_storage_version':1},{'text':'small'})]:
        assert project(run,'tool','call',result)==result
        assert '_tool_results' not in run


def test_large_external_error_is_readable_after_restart(setup, monkeypatch):
    from types import SimpleNamespace
    from test_agent_mcp import start, choose
    from homun.application import external_tools, mcp_client, agent_runs
    from homun.application.agent_external import resume_external
    from homun.application.agent_run_execution import advance
    from homun.context import create_context
    from homun.models.native_turn import NativeMessage, ToolCall

    ctx, actor, work, proposal, calls = start(setup, monkeypatch)
    payload = {'text': 'a' * 20000 + 'CENTRAL_FACT: unavailable' + 'z' * 20000,
               'is_error': True}
    def external(*args):
        calls.append(args)
        return payload
    monkeypatch.setattr(mcp_client, 'call_tool', external)
    pid = choose(ctx, proposal)
    request = ctx.repository.load().commands[pid].result
    external_tools.approve(ctx, actor, pid, {'digest': request['digest']})
    second = create_context(db_path=ctx.data_dir / 'ws.db', data_dir=ctx.data_dir, for_tests=True)
    assert resume_external(second, proposal['id'])
    run = second.repository.load().commands[proposal['id']].result
    projected = run['observations'][-1]['result']
    assert projected['is_error'] is True
    assert 'CENTRAL_FACT' not in projected['preview']
    assert '_tool_results' not in agent_runs.public(run)
    def query(messages, **kwargs):
        assert 'CENTRAL_FACT' not in messages[-1].content
        return SimpleNamespace(message=NativeMessage(role='assistant', tool_calls=[
            ToolCall(id='page', name='read_tool_result', arguments={
                'result_ref': projected['result_ref'], 'query': 'CENTRAL_FACT'})]), usage=None)
    second.models.complete_tools = query
    assert advance(second, proposal['id']) == 'running'
    def finish(messages, **kwargs):
        assert 'CENTRAL_FACT: unavailable' in messages[-1].content
        assert json.loads(messages[-1].content)['is_error'] is True
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Record unavailable'), usage=None)
    second.models.complete_tools = finish
    assert advance(second, proposal['id']) == 'completed'
    assert len(calls) == 1
    assert len(second.repository.load().artifacts) == 1


def test_source_change_fences_saved_result_retrieval(setup, monkeypatch):
    from types import SimpleNamespace
    from test_native_agent import native_start
    from homun.application import agent_results
    from homun.application.agent_run_execution import advance
    from homun.models.native_turn import NativeMessage, ToolCall
    ctx, actor, work, material = setup
    p = native_start(ctx, actor, work, material)
    with ctx.repository.transaction() as store:
        run = store.commands[p['id']].result
        projection = agent_results.project(run, 'read_material', 'original', {'text': 'secret' * 5000})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(message=NativeMessage(
        role='assistant', tool_calls=[ToolCall(id='first', name='list_materials'),
            ToolCall(id='read', name='read_tool_result', arguments={'result_ref': projection['result_ref']})]), usage=None)
    assert advance(ctx, p['id']) == 'running'
    with ctx.repository.transaction() as store:
        store.materials[material].version += 1
    monkeypatch.setattr(agent_results, 'read', lambda *a: pytest.fail('Revoked result was read'))
    assert advance(ctx, p['id']) == 'blocked'
    assert not ctx.repository.load().artifacts


def test_legacy_registry_does_not_gain_result_reader():
    from homun.application.agent_tool_registry import registry_for
    run = {'assignee_id': 'agent', '_protocol': 'native-tools-v1', '_registry_version': 1}
    registry = registry_for(run)
    assert 'read_tool_result' not in [t.name for t in registry.definitions()]
