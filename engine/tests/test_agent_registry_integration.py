"""The approved catalog, model surface and dispatch share one registry."""
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application.agent_run_execution import advance
from homun.application.agent_runs import propose,approve
from homun.models.native_turn import NativeMessage,ToolCall


def result(call=None):
    return SimpleNamespace(message=NativeMessage(role='assistant',content='' if call else 'Consegna venerdi.',tool_calls=[call] if call else []),usage=None)


def test_model_discovers_then_reads_tool_from_pinned_registry(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material);seen=[]
    def complete(messages,**kwargs):
        seen.append([t.name for t in kwargs['tools']])
        if len(seen)==1:return result(ToolCall(id='discover',name='tool_search',arguments={'query':'read_material'}))
        if len(seen)==2:
            assert 'read_material' in messages[-1].content
            return result(ToolCall(id='read',name='read_material',arguments={'material_id':material}))
        return result()
    ctx.models.complete_tools=complete
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='completed'
    run=ctx.repository.load().commands[p['id']].result
    assert {t['name'] for t in run['tools']}==set(seen[0])
    assert 'tool_search' in seen[0]
    assert run['observations'][1]['result']['text']=='Consegna entro venerdi.'
    assert len(ctx.repository.load().artifacts)==1


def test_manifest_drift_blocks_before_model_or_tool_io(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['tools'][0]['schema_hash']='changed'
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Manifest changed')
    assert advance(ctx,p['id'])=='blocked'


def test_existing_run_does_not_gain_search_without_new_approval(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        run=store.commands[p['id']].result
        run.pop('_registry_version',None);run.pop('tools',None)
    seen=[]
    def complete(messages,**kwargs):seen.extend(t.name for t in kwargs['tools']);return result()
    ctx.models.complete_tools=complete
    assert advance(ctx,p['id'])=='completed'
    assert 'tool_search' not in seen


def test_search_does_not_advertise_unapproved_collaborators(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:result(ToolCall(id='search',name='tool_search',arguments={'query':'consult_collaborator'}))
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['observations'][0]['result']=={'tools':[]}
