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


def test_asked_repetition_below_16k_is_delivered_when_the_turn_raised_the_floor():
    from homun.models.repetition import STOP_PATH_MIN_CHARS, is_runaway_repetition
    text='Ciao mondo!\n'*200
    assert len(text)<STOP_PATH_MIN_CHARS
    assert is_runaway_repetition(text)  # the normal floor still rejects it
    result=complete_tools(provider(text),[],tools=[],runaway_floor=STOP_PATH_MIN_CHARS)
    assert result.message.content==text


def test_asked_repetition_without_the_ask_is_still_rejected():
    text='Ciao mondo!\n'*200
    with pytest.raises(NativeModelError) as caught:
        complete_tools(provider(text),[],tools=[])
    assert caught.value.code=='agent_model_repetition'


def test_asked_copies_cap_formula():
    from homun.models.repetition import asked_copies_cap
    assert asked_copies_cap(200)==300  # 1.5x dominates
    assert asked_copies_cap(1000)==1500
    assert asked_copies_cap(4)==14  # copies+10 dominates
    assert asked_copies_cap(3)==13


def test_asked_copies_cap_delivers_200_and_rejects_400():
    """200 asked → 200 delivered whole (cap 300 slack); the model that
    keeps producing to 400 is rejected at turn end with the typed code —
    the reply stays under the 16k char ceiling, so ONLY the count fires."""
    from homun.models.repetition import STOP_PATH_MIN_CHARS
    delivered='Ciao mondo!\n'*200
    looped='Ciao mondo!\n'*400
    assert len(looped)<STOP_PATH_MIN_CHARS
    result=complete_tools(provider(delivered),[],tools=[],
                          runaway_floor=STOP_PATH_MIN_CHARS,runaway_copies=200)
    assert result.message.content==delivered
    with pytest.raises(NativeModelError) as caught:
        complete_tools(provider(looped),[],tools=[],
                       runaway_floor=STOP_PATH_MIN_CHARS,runaway_copies=200)
    assert caught.value.code=='agent_model_repetition'
    assert not caught.value.retryable


def test_without_explicit_copies_only_the_16k_cap_applies():
    """No explicit count in the ask → no count cap: a sub-16k repetition is
    delivered under the raised floor, and only the char ceiling judges."""
    from homun.models.repetition import STOP_PATH_MIN_CHARS
    text='Ciao mondo!\n'*400
    assert len(text)<STOP_PATH_MIN_CHARS
    result=complete_tools(provider(text),[],tools=[],
                          runaway_floor=STOP_PATH_MIN_CHARS)
    assert result.message.content==text


def test_live_watch_cuts_at_the_exact_unit_past_the_cap():
    """The live cut lands on the repetition that crosses the cap — the 301st
    of 200 asked (cap 300) — not at the next char-cadence doubling and not
    at any timeout: 300 delivered units all return False."""
    from homun.models.repetition import STOP_PATH_MIN_CHARS, RunawayStreamWatch
    watch=RunawayStreamWatch(min_chars=STOP_PATH_MIN_CHARS,asked_copies=200)
    unit='Ciao mondo!\n'
    for _ in range(300):
        assert watch.feed(unit) is False
    assert watch.feed(unit) is True


from test_agent_runs import setup


def test_run_rejects_repetition_without_tool_io_or_replay_after_restart(setup,monkeypatch):
    from test_native_agent import native_start
    from homun.application.agent.runs.run_execution import advance
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
