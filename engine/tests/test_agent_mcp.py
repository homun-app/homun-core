from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.domain.models import ExternalServer
from homun.application import agent_runs, external_tools, mcp_client
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage, ToolCall


def start(setup,monkeypatch):
    ctx,actor,work,material=setup
    ctx.models.set_active('openai_compatible')
    with ctx.repository.transaction() as store:
        store.external_servers['srv']=ExternalServer(id='srv',workspace_id=ctx.workspace_id,name='Records',command='fixture')
    ctx.service.store=store
    descriptor={'name':'read_record','description':'Read a record','inputSchema':{'type':'object','properties':{'key':{'type':'string'}},'required':['key'],'additionalProperties':False}}
    monkeypatch.setattr(mcp_client,'probe_server',lambda *a:{'tool_descriptors':[descriptor]})
    calls=[]
    monkeypatch.setattr(mcp_client,'call_tool',lambda *a:(calls.append(a) or {'text':'Record X: 42','is_error':False}))
    p=agent_runs.propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[],'server_ids':['srv']})
    agent_runs.approve(ctx,actor,work,p['id'],{'command_id':'go','digest':p['digest'],'expected_version':p['expected_version']})
    return ctx,actor,work,p,calls


def choose(ctx,p):
    name=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='external1',name=name,arguments={'key':'X'})]),usage=None)
    assert advance(ctx,p['id'])=='waiting_external'
    return ctx.repository.load().commands[p['id']].result['external_request_id']


def test_model_external_approval_resume_and_final(setup,monkeypatch):
    from homun.application.agent_external import resume_external
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    proposal_id=choose(ctx,p)
    assert calls==[] and not ctx.repository.load().artifacts
    proposal=ctx.repository.load().commands[proposal_id].result
    result=external_tools.approve(ctx,actor,proposal_id,{'digest':proposal['digest']})
    assert result['status']=='result_ready'
    assert not ctx.repository.load().artifacts and len(calls)==1
    assert resume_external(ctx,p['id']) is True
    assert resume_external(ctx,p['id']) is False
    def final(messages,**kwargs):
        assert 'Record X: 42' in messages[-1].content
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Record X: 42'),usage=None)
    ctx.models.complete_tools=final
    assert advance(ctx,p['id'])=='completed'
    assert len(ctx.repository.load().artifacts)==1 and len(calls)==1


def test_cancel_while_awaiting_approval_fences_external_io(setup,monkeypatch):
    from homun.application.agent_control import control
    from homun.domain.errors import ConflictError
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    proposal_id=choose(ctx,p)
    proposal=ctx.repository.load().commands[proposal_id].result
    control(ctx,actor,work,p['id'],{'command_id':'cancel','action':'cancel','expected_version':ctx.repository.load().works[work].version})
    with pytest.raises(ConflictError):external_tools.approve(ctx,actor,proposal_id,{'digest':proposal['digest']})
    assert calls==[]

def test_receipt_resume_survives_context_restart(setup,monkeypatch):
    from homun.context import create_context
    from homun.application.agent_external import resume_external
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    pid=choose(ctx,p);proposal=ctx.repository.load().commands[pid].result
    external_tools.approve(ctx,actor,pid,{'digest':proposal['digest']})
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    assert resume_external(second,p['id'])
    assert not resume_external(second,p['id']) and len(calls)==1
    run=second.repository.load().commands[p['id']].result
    assert len([m for m in run['_messages'] if m.get('tool_call_id')=='external1'])==1


def test_bad_mcp_arguments_are_an_observation_without_external_io(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    name=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='bad',name=name,arguments={'key':5})]),usage=None)
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['observations'][0]['result']['error_code']=='validation_error'
    assert calls==[] and 'external_request_id' not in run


def test_cancel_during_external_io_keeps_receipt_and_reports_uncertainty(setup,monkeypatch):
    from homun.application.agent_control import control
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    pid=choose(ctx,p);proposal=ctx.repository.load().commands[pid].result
    def cancel(*a):
        control(ctx,actor,work,p['id'],{'command_id':'cancel','action':'cancel','expected_version':ctx.repository.load().works[work].version})
        return {'text':'effect happened','is_error':False}
    monkeypatch.setattr(mcp_client,'call_tool',cancel)
    external_tools.approve(ctx,actor,pid,{'digest':proposal['digest']})
    store=ctx.repository.load();run=store.commands[p['id']].result
    assert run['status']=='cancelled' and not store.artifacts
    assert 'unknown' in str(run['_messages'][-1])
    assert store.commands[pid].result['_receipt']['text']=='effect happened'

def test_existing_manual_proposal_does_not_strand_agent_wait(setup,monkeypatch):
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    external_tools.propose(ctx,actor,{'command_id':'manual','work_id':work,'server_id':'srv','tool':'read_record','arguments':{'key':'X'}})
    name=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='same',name=name,arguments={'key':'X'})]),usage=None)
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert 'external_request_id' not in run
    assert run['observations'][0]['result']['error_code']=='validation_error'
    assert calls==[]

def test_expired_external_intent_blocks_runtime_without_redispatch(setup,monkeypatch):
    from homun.runtime.workflows.agent_run import deliver_agent_runs
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    pid=choose(ctx,p)
    with ctx.repository.transaction() as store:
        store.commands[pid].result.update(status='running',_dispatch_deadline='2000-01-01T00:00:00+00:00')
    deliver_agent_runs(ctx)
    assert ctx.repository.load().commands[pid].result['status']=='outcome_unknown'
    deliver_agent_runs(ctx)
    assert ctx.repository.load().commands[p['id']].result['status']=='blocked'
    assert calls==[]

def test_two_external_calls_keep_order_and_each_require_approval(setup,monkeypatch):
    from homun.application.agent_external import resume_external
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    name=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[
        ToolCall(id='first',name=name,arguments={'key':'A'}),ToolCall(id='second',name=name,arguments={'key':'B'})]),usage=None)
    for index,key in enumerate(['A','B']):
        assert advance(ctx,p['id'])=='waiting_external'
        assert len(calls)==index
        run=ctx.repository.load().commands[p['id']].result
        proposal=ctx.repository.load().commands[run['external_request_id']].result
        assert proposal['arguments']=={'key':key}
        external_tools.approve(ctx,actor,proposal['id'],{'digest':proposal['digest']})
        assert resume_external(ctx,p['id'])
        ctx.models.complete_tools=lambda *a,**k:pytest.fail('New model call before pending tools resolved')
    run=ctx.repository.load().commands[p['id']].result
    assert [m['tool_call_id'] for m in run['_messages'] if m['role']=='tool']==['first','second']
    assert len(calls)==2

def test_manual_command_collision_during_discovery_cannot_attach_to_agent(setup,monkeypatch):
    import hashlib
    from copy import deepcopy
    ctx,actor,work,p,calls=start(setup,monkeypatch)
    manual=external_tools.propose(ctx,actor,{'command_id':'manual','work_id':work,'server_id':'srv','tool':'read_record','arguments':{'key':'X'}})
    pid='run:external:'+hashlib.sha256(b'0:external1').hexdigest()[:24]
    original=mcp_client.probe_server
    def raced(server):
        with ctx.repository.transaction() as store:
            record=deepcopy(store.commands['manual']);record.command_id=pid;record.result['id']=pid
            store.commands[pid]=record
        return original(server)
    monkeypatch.setattr(mcp_client,'probe_server',raced)
    name=p['external_tools'][0]['name']
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='external1',name=name,arguments={'key':'X'})]),usage=None)
    assert advance(ctx,p['id'])=='blocked'
    assert calls==[]
