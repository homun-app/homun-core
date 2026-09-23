import json
from types import SimpleNamespace
import pytest
from homun.models.native_turn import NativeMessage, ToolCall, project_messages, parse_response
from test_agent_runs import setup
from homun.application.agent_run_execution import advance
from homun.application.agent_runs import resume_waiting, propose, approve
from homun.context import create_context


def test_wire_projection_keeps_ids_and_ollama_object_arguments():
    history = [NativeMessage(role='assistant', tool_calls=[ToolCall(id='read1', name='read_material', arguments={'material_id':'m'})]),
               NativeMessage(role='tool', content='text', tool_call_id='read1', name='read_material')]
    for ollama in (False, True):
        wire = project_messages(history, ollama=ollama)
        assert wire[0]['tool_calls'][0]['id']=='read1'
        args = wire[0]['tool_calls'][0]['function']['arguments']
        assert (args if ollama else json.loads(args))=={'material_id':'m'}
        assert wire[1]['tool_call_id']=='read1'
    assert project_messages(history, ollama=True)[1]['tool_name']=='read_material'


def test_parse_native_calls_and_reject_truncated_or_reasoning_only():
    result = parse_response({'message':{'content':'', 'tool_calls':[{'function':{'name':'read_material','arguments':{'material_id':'m'}}}]}, 'done_reason':'stop'}, ollama=True)
    assert result.tool_calls[0].id
    assert result.content==''
    for response in ({'message':{'thinking':'secret reasoning'},'done_reason':'stop'},
                     {'message':{'content':'incomplete'},'done_reason':'length'}):
        with pytest.raises(ValueError):parse_response(response, ollama=True)
    with pytest.raises(ValueError):
        parse_response({'choices':[{'message':{'tool_calls':[{'id':'c','function':{'name':'read_material','arguments':'[]'}}]},'finish_reason':'tool_calls'}]}, ollama=False)


def native_start(ctx, actor, work, material, extra=None):
    ctx.models.set_active('openai_compatible')
    p=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'material_ids':[material] + ([extra] if extra else [])})
    approve(ctx,actor,work,p['id'],{'command_id':'approve','digest':p['digest'],'expected_version':p['expected_version']})
    return p


def test_pending_reads_survive_human_answer_and_restart(setup):
    from homun.application.material_ingest import ingest_file
    ctx,actor,work,material=setup
    project=ctx.repository.load().materials[material].project_id
    notes=ingest_file(ctx,actor,command_id='notes',project_id=project,
        filename='notes.txt',data=b'Verifica aggiuntiva: allegare il modulo B7.')['material_id']
    p=native_start(ctx,actor,work,material,notes)
    seen=[]
    def model(messages, **kw):
        seen.append(messages)
        return SimpleNamespace(message=NativeMessage(role='assistant', tool_calls=[
            ToolCall(id='r1',name='read_material',arguments={'material_id':material}),
            ToolCall(id='q1',name='request_user_input',arguments={'question':'Destinatario?'}),
            ToolCall(id='r2',name='read_material',arguments={'material_id':notes}),
        ]), usage=None)
    ctx.models.complete_tools=model
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='waiting_input'
    assert len(seen)==1
    store=ctx.repository.load();run=store.commands[p['id']].result
    assert len(run['_messages'][-2]['tool_calls'])==3
    ctx.service=ctx.service.for_store(store)
    ctx.service.apply(actor,'reply','work.provide_contribution',{'request_id':run['request_id'],
        'text':'Marta, verifica anche il secondo estratto','expected_version':store.works[work].version})
    ctx.persist()
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        def finish(messages, **kw):
            seen.append(messages)
            results=[m for m in messages if m.role=='tool']
            assert [m.tool_call_id for m in results]==['r1','q1','r2']
            assert 'Marta' in results[1].content
            assert 'modulo B7' in results[2].content
            return SimpleNamespace(message=NativeMessage(role='assistant',content='Nota per Marta'),usage=None)
        second.models.complete_tools=finish
        assert resume_waiting(second,p['id'])
        assert advance(second,p['id'])=='running'
        assert len(seen)==1
        assert advance(second,p['id'])=='completed'
        assert len(seen)==2
        assert len(second.repository.load().artifacts)==1
        assert second.repository.load().works[work].status=='review'
    finally:second.close()


def test_pending_native_tool_still_checks_source_authority(setup):
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[
        ToolCall(id='a',name='list_materials'),ToolCall(id='b',name='read_material',arguments={'material_id':material})]),usage=None)
    assert advance(ctx,p['id'])=='running'
    with ctx.repository.transaction() as store:store.materials[material].version+=1
    assert advance(ctx,p['id'])=='blocked'
    assert not ctx.repository.load().artifacts


@pytest.mark.parametrize('ollama', [False, True])
def test_registry_native_transport_and_usage(setup, monkeypatch, ollama):
    from homun.models.agent_turn import ToolDefinition
    ctx,*_=setup
    provider=ctx.models._providers['openai_compatible']
    monkeypatch.setattr(provider, '_api_key', lambda:'test-key')
    monkeypatch.setattr(provider, '_ollama_native_root', lambda:'http://localhost:11434' if ollama else None)
    seen=[]
    def post(*args, **kwargs):
        payload=args[0] if ollama else args[1]
        seen.append(payload)
        message={'content':'', 'tool_calls':[{'id':'lookup','type':'function', 'function':{'name':'list_materials','arguments':{} if ollama else '{}'}}]}
        return ({'message':message,'done_reason':'stop','prompt_eval_count':11,'eval_count':7} if ollama else
                {'choices':[{'message':message,'finish_reason':'tool_calls'}],'usage':{'prompt_tokens':11,'completion_tokens':7}})
    monkeypatch.setattr(provider, '_post_ollama_chat' if ollama else '_post', post)
    result=ctx.models.complete_tools([NativeMessage(role='user',content='Read')],
        tools=[ToolDefinition(name='list_materials',description='List',input_schema={'type':'object'})],connection_id='openai_compatible')
    assert result.message.tool_calls[0].id=='lookup'
    assert seen[0]['tools'][0]['function']['name']=='list_materials'
    assert result.usage.input_tokens==11 and result.usage.output_tokens==7
    assert ctx.models.usage[-1].id==result.usage.id


def test_native_provider_failure_does_not_downgrade(setup):
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    def fail(*a,**k):raise RuntimeError('provider unavailable')
    def forbidden(*a,**k):pytest.fail('Unexpected JSON fallback')
    ctx.models.complete_tools=fail
    ctx.models.complete=forbidden
    assert advance(ctx,p['id'])=='failed'
    assert ctx.repository.load().commands[p['id']].result['error_code']=='agent_run_model_error'
    assert not ctx.repository.load().artifacts


def test_tool_call_is_persisted_before_execution(setup, monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[
        ToolCall(id='persisted',name='list_materials')]),usage=None)
    original=agent_run_execution.run_tool
    def read(*args):
        run=ctx.repository.load().commands[p['id']].result
        assert run['_messages'][-1]['tool_calls'][0]['id']=='persisted'
        assert run['_decision']['kind']=='tool'
        return original(*args)
    monkeypatch.setattr(agent_run_execution,'run_tool',read)
    assert advance(ctx,p['id'])=='running'


def test_unknown_tool_returns_error_and_can_recover(setup):
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[
        ToolCall(id='invalid',name='invented_tool')]),usage=None)
    assert advance(ctx,p['id'])=='running'
    def finish(messages,**kw):
        assert 'validation_error' in messages[-1].content
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Strumento non disponibile.'),usage=None)
    ctx.models.complete_tools=finish
    assert advance(ctx,p['id'])=='completed'


@pytest.mark.parametrize('response', [{}, {'choices':[]}, {'choices':[{'finish_reason':'stop','message':None}]}])
def test_malformed_provider_envelope_is_validation_error(response):
    with pytest.raises(ValueError):parse_response(response)


def test_restart_after_round_persisted_does_not_repeat_model(setup, monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[
        ToolCall(id='recover',name='read_material',arguments={'material_id':material})]),usage=None)
    class ProcessStopped(BaseException):pass
    def interrupted(*a,**k):raise ProcessStopped()
    with monkeypatch.context() as patch:
        patch.setattr(agent_run_execution,'run_tool',interrupted)
        with pytest.raises(ProcessStopped):advance(ctx,p['id'])
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        def forbidden(*a,**k):pytest.fail('Pending round triggered another model request')
        second.models.complete_tools=forbidden
        assert advance(second,p['id'])=='running'
        saved=second.repository.load().commands[p['id']].result
        assert saved['model_attempts']==1
        assert saved['_messages'][-1]['tool_call_id']=='recover'
        assert 'venerdi' in saved['_messages'][-1]['content']
    finally:second.close()


def test_native_inflight_result_cannot_publish_after_pause(setup):
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    def pause(*a,**k):
        store=ctx.repository.load();ctx.service=ctx.service.for_store(store)
        ctx.service.apply(actor,'pause','work.pause',{'work_id':work,'expected_version':store.works[work].version})
        ctx.persist()
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Too late'),usage=None)
    ctx.models.complete_tools=pause
    assert advance(ctx,p['id'])=='blocked'
    assert ctx.repository.load().works[work].status=='paused'
    assert not ctx.repository.load().artifacts


def test_empty_tool_round_cannot_become_final_answer():
    with pytest.raises(ValueError):
        parse_response({'choices':[{'finish_reason':'tool_calls',
            'message':{'content':'I will now read the document.','tool_calls':[]}}]})


@pytest.mark.parametrize('response', [[], {'choices':[{'finish_reason':'stop','message':{'content':'Done'}}], 'usage':['invalid']}])
def test_malformed_transport_response_records_durable_failure(setup, monkeypatch, response):
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    provider=ctx.models._providers['openai_compatible']
    monkeypatch.setattr(provider,'_api_key',lambda:'test-key')
    monkeypatch.setattr(provider,'_ollama_native_root',lambda:None)
    monkeypatch.setattr(provider,'_post',lambda *a,**k:response)
    assert advance(ctx,p['id'])=='failed'
    run=ctx.repository.load().commands[p['id']].result
    assert run['error_code']=='agent_run_invalid_decision'
    assert '_lease_token' not in run
    assert not ctx.repository.load().artifacts
