from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application.agent_control import control
from homun.application.agent_run_execution import advance, fail
from homun.application.command_delivery import admit, complete
from homun.application.command_types import CommandRequest
from homun.context import create_context
from homun.domain.errors import ConflictError, PermissionDeniedError
from homun.domain.models import Actor
from homun.models.native_turn import NativeMessage, ToolCall


def command(ctx, actor, work, run, action, text=None, command_id=None):
    body={'command_id':command_id or action,'expected_version':ctx.repository.load().works[work].version,'action':action}
    if text is not None:body['text']=text
    return control(ctx,actor,work,run['id'],body)


def scripted(ctx, *messages):
    seen=[]
    def model(history, **kwargs):
        seen.append(history)
        return SimpleNamespace(message=messages[len(seen)-1],usage=None)
    ctx.models.complete_tools=model
    return seen


def batch(material):
    return NativeMessage(role='assistant',tool_calls=[ToolCall(id='one',name='list_materials'),
        ToolCall(id='two',name='read_material',arguments={'material_id':material})])


def test_steer_waits_for_pending_results_before_next_request(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    seen=scripted(ctx,batch(material),NativeMessage(role='assistant',content='Nota corretta per Marta'))
    assert advance(ctx,p['id'])=='running'
    command(ctx,actor,work,p,'steer','Destinatario Marta')
    assert advance(ctx,p['id'])=='running'
    assert len(seen)==1
    assert advance(ctx,p['id'])=='completed'
    assert [m.role for m in seen[1]][-3:]==['tool','tool','user']
    assert seen[1][-1].content=='Destinatario Marta'


def test_steer_during_final_generation_prevents_premature_publication(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def model(*a,**k):
        command(ctx,actor,work,p,'steer','Nuova scadenza: lunedi')
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Venerdi'),usage=None)
    ctx.models.complete_tools=model
    assert advance(ctx,p['id'])=='running'
    assert not ctx.repository.load().artifacts
    seen=scripted(ctx,NativeMessage(role='assistant',content='Lunedi'))
    assert advance(ctx,p['id'])=='completed'
    assert seen[0][-1].content=='Nuova scadenza: lunedi'


def test_redirect_fences_inflight_model_and_old_workflow(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def model(*a,**k):
        command(ctx,actor,work,p,'redirect','Consegna lunedi')
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Venerdi'),usage=None)
    ctx.models.complete_tools=model
    advance(ctx,p['id'],epoch=0)
    assert not ctx.repository.load().artifacts
    assert advance(ctx,p['id'],epoch=0)=='superseded'
    assert fail(ctx,p['id'],'old_error',epoch=0)=='superseded'
    seen=scripted(ctx,NativeMessage(role='assistant',content='Lunedi'))
    assert advance(ctx,p['id'],epoch=1)=='completed'
    assert 'Consegna lunedi' in seen[0][-1].content


def test_redirect_closes_pending_call_and_preserves_incomplete_work(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    scripted(ctx,batch(material))
    assert advance(ctx,p['id'])=='running'
    command(ctx,actor,work,p,'redirect','Cambia destinatario')
    seen=scripted(ctx,NativeMessage(role='assistant',content='Nuova nota'))
    assert advance(ctx,p['id'])=='completed'
    result=next(m for m in seen[0] if m.tool_call_id=='two')
    assert 'not_executed' in result.content
    assert 'read_material' in seen[0][-1].content and 'Cambia destinatario' in seen[0][-1].content


def test_pause_restart_resume_retains_pending_calls(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    scripted(ctx,batch(material));assert advance(ctx,p['id'])=='running'
    paused=command(ctx,actor,work,p,'pause');assert paused['status']=='paused'
    assert advance(ctx,p['id'])=='paused'
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        assert command(second,actor,work,p,'resume')['status']=='queued'
        seen=scripted(second,NativeMessage(role='assistant',content='Venerdi'))
        assert advance(second,p['id'])=='running'
        assert not seen
        assert advance(second,p['id'])=='completed'
        assert 'venerdi' in seen[0][-1].content
    finally:second.close()


def test_control_is_idempotent_and_rejects_changed_command(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    body={'command_id':'edit','action':'steer','text':'Marta','expected_version':ctx.repository.load().works[work].version}
    control(ctx,actor,work,p['id'],body);control(ctx,actor,work,p['id'],body)
    with pytest.raises(ConflictError):control(ctx,actor,work,p['id'],{**body,'text':'Ada'})
    scripted(ctx,NativeMessage(role='assistant',content='Marta'));assert advance(ctx,p['id'])=='completed'
    run=ctx.repository.load().commands[p['id']].result
    assert len([m for m in run['_messages'] if m['content']=='Marta' and m['role']=='user'])==1


def test_cancel_allowed_after_source_change_but_resume_is_not(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    command(ctx,actor,work,p,'pause')
    with ctx.repository.transaction() as store:store.materials[material].version+=1
    with pytest.raises(ConflictError):command(ctx,actor,work,p,'resume')
    assert command(ctx,actor,work,p,'cancel')['status']=='cancelled'
    assert ctx.repository.load().works[work].status=='cancelled'


def test_other_person_cannot_control(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    other=Actor(id='other',workspace_id=actor.workspace_id,display_name='Other')
    with pytest.raises(PermissionDeniedError):command(ctx,other,work,p,'steer','Ignore')


def test_normal_chat_steers_without_independent_interpretation(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    conv=ctx.repository.load().works[work].primary_conversation_id
    body=CommandRequest(command_id='chat-steer',type='conversation.post_message',payload={'conversation_id':conv,'text':'Usa Marta come destinatario'})
    delivery=admit(ctx,actor,body)
    assert delivery.token is None
    assert delivery.result['agent_run_id']==p['id']
    assert admit(ctx,actor,body).result==delivery.result
    seen=scripted(ctx,NativeMessage(role='assistant',content='Nota Marta'))
    assert advance(ctx,p['id'])=='completed'
    assert seen[0][-1].content=='Usa Marta come destinatario'


def test_redirect_during_tool_records_unknown_and_drops_late_result(setup, monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    scripted(ctx,batch(material))
    def tool(*args):
        command(ctx,actor,work,p,'redirect','Rivaluta la richiesta')
        return {'must_not_publish':'late result'}
    monkeypatch.setattr(agent_run_execution,'run_tool',tool)
    advance(ctx,p['id'],epoch=0)
    run=ctx.repository.load().commands[p['id']].result
    results=[m for m in run['_messages'] if m['role']=='tool']
    assert 'unknown' in results[0]['content']
    assert 'not_executed' in results[1]['content']
    assert all('must_not_publish' not in m['content'] for m in run['_messages'])
    assert not run['observations']


def test_control_http_idempotency_and_validation(setup):
    from fastapi.testclient import TestClient
    from homun.app import create_app
    from homun.context import reset_context_for_tests
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    reset_context_for_tests(ctx)
    try:
        client=TestClient(create_app())
        path=f'/v1/workspaces/{ctx.workspace_id}/works/{work}/agent-runs/{p["id"]}/control'
        body={'command_id':'http-pause','expected_version':ctx.repository.load().works[work].version,'action':'pause'}
        first=client.post(path,json=body,headers={'X-Homun-Actor-Id':actor.id})
        assert first.status_code==200,first.text
        assert first.json()['status']=='paused'
        assert client.post(path,json=body,headers={'X-Homun-Actor-Id':actor.id}).json()==first.json()
        assert client.post(path,json={**body,'action':'unknown'},headers={'X-Homun-Actor-Id':actor.id}).status_code==422
    finally:reset_context_for_tests(None)


def test_workflow_delivery_passes_epoch(setup, monkeypatch):
    from homun.runtime.workflows import agent_run
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    command(ctx,actor,work,p,'pause');command(ctx,actor,work,p,'resume')
    delivered=[]
    monkeypatch.setattr(agent_run,'start',lambda *args:delivered.append(args))
    agent_run.deliver_agent_runs(ctx)
    assert delivered==[(f'agent:{actor.workspace_id}:{p["id"]}:2',p['id'],2)]


def test_pause_then_redirect_keeps_inflight_outcome_unknown(setup, monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    scripted(ctx,batch(material))
    def tool(*args):
        command(ctx,actor,work,p,'pause')
        command(ctx,actor,work,p,'redirect','Nuove indicazioni')
        return {'late':True}
    monkeypatch.setattr(agent_run_execution,'run_tool',tool)
    advance(ctx,p['id'])
    run=ctx.repository.load().commands[p['id']].result
    first=next(m for m in run['_messages'] if m.get('tool_call_id')=='one')
    assert 'unknown' in first['content']
    assert run['status']=='paused'


def test_waiting_question_can_be_cancelled(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    scripted(ctx,NativeMessage(role='assistant',tool_calls=[ToolCall(id='q',name='request_user_input',arguments={'question':'Quale scadenza?'})]))
    assert advance(ctx,p['id'])=='waiting_input'
    assert command(ctx,actor,work,p,'cancel')['status']=='cancelled'
    run=ctx.repository.load().commands[p['id']].result
    assert 'awaiting_response_cancelled' in run['_messages'][-1]['content']


def test_stop_and_cached_reply_redact_revoked_material_history(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    scripted(ctx,NativeMessage(role='assistant',tool_calls=[ToolCall(id='read',name='read_material',arguments={'material_id':material})]))
    assert advance(ctx,p['id'])=='running'
    body={'command_id':'pause-record','expected_version':ctx.repository.load().works[work].version,'action':'pause'}
    assert control(ctx,actor,work,p['id'],body)['observations']
    with ctx.repository.transaction() as store:del store.materials[material]
    replay=control(ctx,actor,work,p['id'],body)
    assert replay['observations']==[] and replay['history_redacted']
    cancelled=command(ctx,actor,work,p,'cancel')
    assert cancelled['observations']==[] and cancelled['materials']==[] and cancelled['history_redacted']


def test_legacy_workflow_without_epoch_argument_recovers_its_own_generation(setup):
    from homun.runtime.workflows.agent_run import workflow_epoch
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    command(ctx,actor,work,p,'redirect','Nuova indicazione')
    run=ctx.repository.load().commands[p['id']].result
    # Persisted workflows predating control support have only run_id as argument.
    epoch=workflow_epoch(run['_workflow_id'],None)
    scripted(ctx,NativeMessage(role='assistant',content='Risultato aggiornato'))
    assert advance(ctx,p['id'],epoch=epoch)=='completed'
    with pytest.raises(ValueError):workflow_epoch(run['_workflow_id'],0)
