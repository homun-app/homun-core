import json
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_agent_mcp import start
from homun.application import agent_runs, external_tools
from homun.application.agent_run_execution import advance
from homun.application.agent_external import resume_external
from homun.application.agent_tool_registry import registry_for
from homun.models.native_turn import NativeMessage, ToolCall


def response(*calls, text=''):
    return SimpleNamespace(message=NativeMessage(role='assistant',content=text,tool_calls=list(calls)),usage=None)


def test_model_surface_defers_schemas_and_describe_returns_pinned_contract(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    def describe(messages, **kwargs):
        names={t.name for t in kwargs['tools']}
        assert target not in names
        assert {'tool_search','tool_describe','tool_call'} <= names
        return response(ToolCall(id='describe',name='tool_describe',arguments={'names':[target]}))
    ctx.models.complete_tools=describe
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    result=run['observations'][-1]['result']['tools'][0]
    assert result['name']==target
    assert result['input_schema']['required']==['key']
    assert not calls


def test_bridge_approval_and_receipt_survive_restart(setup,monkeypatch):
    from homun.context import create_context
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='bridge1',name='tool_call',arguments={'name':target,'arguments':{'key':'X'}}))
    assert advance(ctx,p['id'])=='waiting_external'
    run=ctx.repository.load().commands[p['id']].result
    proposal=ctx.repository.load().commands[run['external_request_id']].result
    assert proposal['tool']=='read_record' and proposal['arguments']=={'key':'X'}
    assert not calls
    external_tools.approve(ctx,actor,proposal['id'],{'digest':proposal['digest']})
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    assert resume_external(second,p['id']) and not resume_external(second,p['id'])
    def final(messages,**kwargs):
        assert messages[-1].name=='tool_call' and messages[-1].tool_call_id=='bridge1'
        assert 'Record X: 42' in messages[-1].content
        return response(text='Record X: 42')
    second.models.complete_tools=final
    assert advance(second,p['id'])=='completed'
    assert len(calls)==1 and len(second.repository.load().artifacts)==1


@pytest.mark.parametrize('target',['unknown','list_materials','tool_call','request_user_input'])
def test_invalid_bridge_targets_are_observations_without_io(setup,monkeypatch,target):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='bad',name='tool_call',arguments={'name':target,'arguments':{}}))
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['observations'][-1]['result']['error_code']=='validation_error'
    assert not calls and 'external_request_id' not in run


def test_search_does_not_return_its_own_embedded_catalog(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='search',name='tool_search',arguments={'query':target}))
    assert advance(ctx,p['id'])=='running'
    found=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']['tools']
    assert [item['name'] for item in found]==[target]
    assert not calls


def test_search_and_call_in_same_round_do_not_generate_between_pending_calls(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(
        ToolCall(id='search',name='tool_search',arguments={'query':target}),
        ToolCall(id='execute',name='tool_call',arguments={'name':target,'arguments':{'key':'X'}}))
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Generated before pending call resolved')
    assert advance(ctx,p['id'])=='waiting_external'
    assert not calls


@pytest.mark.parametrize('arguments',[{'key':5},{'key':'X','extra':1},{}])
def test_target_schema_validation_precedes_external_staging(setup,monkeypatch,arguments):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='bad',name='tool_call',arguments={'name':target,'arguments':arguments}))
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['observations'][-1]['result']['error_code']=='validation_error'
    assert not calls and 'external_request_id' not in run


def test_cancel_pending_bridge_action_fences_external_approval(setup,monkeypatch):
    from homun.application.agent_control import control
    from homun.domain.errors import ConflictError
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='cancel',name='tool_call',arguments={'name':target,'arguments':{'key':'X'}}))
    assert advance(ctx,p['id'])=='waiting_external'
    store=ctx.repository.load();run=store.commands[p['id']].result
    proposal=store.commands[run['external_request_id']].result
    control(ctx,actor,work,p['id'],{'command_id':'cancel','action':'cancel','expected_version':store.works[work].version})
    with pytest.raises(ConflictError):
        external_tools.approve(ctx,actor,proposal['id'],{'digest':proposal['digest']})
    assert not calls


def test_changed_wrapper_arguments_cannot_approve_old_proposal(setup,monkeypatch):
    from homun.domain.errors import ConflictError
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='tamper',name='tool_call',arguments={'name':target,'arguments':{'key':'X'}}))
    assert advance(ctx,p['id'])=='waiting_external'
    with ctx.repository.transaction() as store:
        run=store.commands[p['id']].result
        proposal=store.commands[run['external_request_id']].result
        run['_messages'][-1]['tool_calls'][0]['arguments']['arguments']['key']='Y'
    with pytest.raises(ConflictError):
        external_tools.approve(ctx,actor,proposal['id'],{'digest':proposal['digest']})
    assert not calls


def test_legacy_catalog_keeps_direct_schema(setup,monkeypatch):
    from homun.application.agent_tool_bridge import visible_definitions
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    run=ctx.repository.load().commands[p['id']].result
    run.pop('_tool_bridge_version');run.pop('tools')
    legacy=registry_for(run)
    run['tools']=legacy.manifest()
    names={t.name for t in visible_definitions(run,registry_for(run))}
    assert p['external_tools'][0]['name'] in names
    assert 'tool_call' not in names and 'tool_describe' not in names


def test_two_wrapper_calls_keep_distinct_approvals_and_result_ids(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(*[
        ToolCall(id=key,name='tool_call',arguments={'name':target,'arguments':{'key':key}}) for key in ['A','B']])
    for key in ['A','B']:
        assert advance(ctx,p['id'])=='waiting_external'
        store=ctx.repository.load();run=store.commands[p['id']].result
        proposal=store.commands[run['external_request_id']].result
        assert proposal['arguments']=={'key':key}
        external_tools.approve(ctx,actor,proposal['id'],{'digest':proposal['digest']})
        assert resume_external(ctx,p['id'])
        ctx.models.complete_tools=lambda *a,**k:pytest.fail('Unexpected generation')
    run=ctx.repository.load().commands[p['id']].result
    assert [m['tool_call_id'] for m in run['_messages'] if m['role']=='tool']==['A','B']
    assert len(calls)==2


def test_direct_hidden_name_still_requires_approval(setup,monkeypatch):
    # Disclosure is a model-context optimization, not a new authority boundary.
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    target=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='direct',name=target,arguments={'key':'X'}))
    assert advance(ctx,p['id'])=='waiting_external'
    assert not calls
    run=ctx.repository.load().commands[p['id']].result
    proposal=ctx.repository.load().commands[run['external_request_id']].result
    assert proposal['tool']=='read_record' and proposal['arguments']=={'key':'X'}


@pytest.mark.parametrize('arguments',[
    {'name':'unknown','arguments':{},'extra':'private'},
    {'name':'unknown','arguments':[]},
    {'name':5,'arguments':{}},
])
def test_wrapper_schema_errors_are_recoverable_observations(setup,monkeypatch,arguments):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='invalid',name='tool_call',arguments=arguments))
    assert advance(ctx,p['id'])=='running'
    result=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']
    assert result['error_code']=='validation_error' and 'private' not in str(result)
    assert not calls


def test_search_indexes_human_server_label(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    ctx.models.complete_tools=lambda *a,**k:response(ToolCall(id='source',name='tool_search',arguments={'query':'Records'}))
    assert advance(ctx,p['id'])=='running'
    found=ctx.repository.load().commands[p['id']].result['observations'][-1]['result']['tools']
    assert [item['name'] for item in found]==[p['external_tools'][0]['name']]


def test_catalog_hint_allows_missing_optional_description():
    from homun.application.agent_tool_bridge import search_description
    run={'_mcp_bindings':[{'name':'mcp_read','server_name':'Records','tool':'read','descriptor':{'description':None}}]}
    assert 'Records · read' in search_description(run)
