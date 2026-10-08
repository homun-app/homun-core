from types import SimpleNamespace
import pytest
from homun.models.native_transport import complete_tools
from homun.models.native_errors import NativeModelError


def provider(text, reason='stop', *, ollama=False):
    body=({'message':{'content':text},'done_reason':reason,'prompt_eval_count':17,'eval_count':600}
          if ollama else {'choices':[{'message':{'content':text},'finish_reason':reason}],
                         'usage':{'prompt_tokens':17,'completion_tokens':600}})
    return SimpleNamespace(provider_id='fixture',default_model='fixture',_api_key=lambda:'fixture',
        _ollama_native_root=lambda:'http://localhost' if ollama else None,
        _post=lambda *a,**k:body,_post_ollama_chat=lambda *a,**k:body)


@pytest.mark.parametrize('ollama',[False,True])
@pytest.mark.parametrize('reason',['stop','length'])
def test_runaway_reply_is_typed_nonretryable_and_preserves_usage(ollama,reason):
    text=('The model repeats this exact lengthy explanation without making any further progress.\n'*30)
    with pytest.raises(NativeModelError) as caught:
        complete_tools(provider(text,reason,ollama=ollama),[],tools=[])
    assert caught.value.code=='agent_model_repetition'
    assert not caught.value.retryable
    assert caught.value.usage.input_tokens==17 and caught.value.usage.output_tokens==600
    assert caught.value.usage.error_code=='agent_model_repetition'
    assert text[:70] not in str(caught.value)


@pytest.mark.parametrize('text',[
    'yes '*20,
    '\n'.join(f"INSERT INTO records (workspace, source, label, value) VALUES ('workspace', 'source', 'record', {i});" for i in range(60)),
    '\n'.join(f'| Same heading and long shared explanatory prefix for each data row | {i} |' for i in range(60)),
])
def test_short_or_distinct_batch_rows_are_preserved(text):
    assert complete_tools(provider(text),[],tools=[]).message.content==text


def test_runaway_single_line_and_repeated_line_patterns():
    from homun.models.repetition import is_runaway_repetition
    assert is_runaway_repetition('a'*1000)
    assert is_runaway_repetition(('first recurring line\nsecond recurring line\n')*40)
    assert not is_runaway_repetition(None)


from test_agent_runs import setup


def test_run_rejects_repetition_without_tool_io_or_replay_after_restart(setup,monkeypatch):
    from test_native_agent import native_start
    from homun.application.agent_run_execution import advance
    from homun.context import create_context
    ctx,actor,work,material=setup
    p=native_start(ctx,actor,work,material)
    model=ctx.models._providers['openai_compatible']
    monkeypatch.setattr(model,'_api_key',lambda:'fixture')
    monkeypatch.setattr(model,'_ollama_native_root',lambda:None)
    calls=[]
    text='degenerate repetition with a long shared fragment that never changes.\n'*40
    def post(*a,**k):
        calls.append(True)
        return {'choices':[{'finish_reason':'tool_calls','message':{'content':text,
            'tool_calls':[{'id':'danger','function':{'name':'read_material','arguments':'{"material_id":"invalid"}'}}]}}],
            'usage':{'prompt_tokens':17,'completion_tokens':600}}
    monkeypatch.setattr(model,'_post',post)
    assert advance(ctx,p['id'])=='failed'
    store=ctx.repository.load();run=store.commands[p['id']].result
    assert run['error_code']=='agent_model_repetition'
    assert len(run['_messages'])==2 and not run['observations'] and not store.artifacts
    assert store.work_budgets[work].spent.output_tokens==600
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    assert advance(second,p['id'])=='failed' and len(calls)==1


def test_single_divider_in_normal_report_does_not_inflate_coverage():
    text='Report: '+' '.join(f'item{i}' for i in range(60))+'\n'+'-'*72+'\nEnd.'
    assert complete_tools(provider(text),[],tools=[]).message.content==text
