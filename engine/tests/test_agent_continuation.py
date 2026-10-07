from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application.agent_run_execution import advance
from homun.context import create_context
from homun.models.native_errors import NativeModelError
from homun.models.native_turn import NativeMessage
from homun.models.native_transport import complete_tools
from test_native_repetition import provider


def truncated(text='Prima parte.\n'):
    try:
        complete_tools(provider(text,'length'),[],tools=[])
    except NativeModelError as exc:
        return exc
    pytest.fail('Truncation accepted as complete')


def test_visible_truncation_carries_partial_text_without_raw_body():
    error=truncated()
    assert error.code=='agent_model_truncated'
    assert error.partial_text=='Prima parte.\n'
    assert 'Prima parte.' not in str(error)
    assert error.usage.output_tokens==600


def test_continuation_survives_restart_and_stitches_one_artifact(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated())
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['_continuation']['parts']==['Prima parte.\n']
    assert not ctx.repository.load().artifacts
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    def finish(messages,**kwargs):
        assert messages[-2].content=='Prima parte.\n' and 'Continue' in messages[-1].content
        return SimpleNamespace(message=NativeMessage(role='assistant',content='Seconda parte.'),usage=None)
    second.models.complete_tools=finish
    assert advance(second,p['id'])=='completed'
    store=second.repository.load();content=next(iter(store.artifacts.values())).content
    assert content.startswith('Prima parte.\nSeconda parte.')
    assert content.count('Prima parte.')==1
    assert len(store.artifacts)==1 and store.work_budgets[work].spent.output_tokens==600


def test_four_truncated_responses_fail_without_artifact(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated())
    assert [advance(ctx,p['id']) for _ in range(4)]==['running','running','running','failed']
    store=ctx.repository.load();run=store.commands[p['id']].result
    assert run['error_code']=='agent_model_truncated' and not store.artifacts
    assert store.work_budgets[work].spent.output_tokens==2400


@pytest.mark.parametrize('content',['', '<think>private unfinished reasoning', 'Visible <reasoning>hidden'])
def test_empty_or_reasoning_fragments_are_not_continued(content):
    assert truncated(content).partial_text is None


def test_truncated_tool_arguments_never_become_text_continuation():
    p=provider('Some introductory text','length')
    p._post=lambda *a,**k:{'choices':[{'finish_reason':'length','message':{'content':'Intro',
        'tool_calls':[{'id':'broken','function':{'name':'read_material','arguments':'{"id":'}}]}}]}
    with pytest.raises(NativeModelError) as caught:
        complete_tools(p,[],tools=[])
    assert caught.value.partial_text is None


def test_content_filter_is_not_continuation():
    with pytest.raises(NativeModelError) as caught:
        complete_tools(provider('partial','content_filter'),[],tools=[])
    assert caught.value.code=='agent_model_invalid_request' and caught.value.partial_text is None


@pytest.mark.parametrize('action',['steer','redirect'])
def test_correction_discards_old_assembly(setup,action):
    from homun.application.agent_control import control
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated('Obsolete answer.'))
    assert advance(ctx,p['id'])=='running'
    control(ctx,actor,work,p['id'],{'command_id':'change','action':action,'text':'New objective',
        'expected_version':ctx.repository.load().works[work].version})
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Corrected answer.'),usage=None)
    assert advance(ctx,p['id'])=='completed'
    content=next(iter(ctx.repository.load().artifacts.values())).content
    assert content.startswith('Corrected answer.') and 'Obsolete' not in content


def test_pause_resume_retains_accepted_partial(setup):
    from homun.application.agent_control import control
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated('Accepted.\n'))
    assert advance(ctx,p['id'])=='running'
    for action in ['pause','resume']:
        control(ctx,actor,work,p['id'],{'command_id':action,'action':action,
            'expected_version':ctx.repository.load().works[work].version})
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Continued.'),usage=None)
    assert advance(ctx,p['id'])=='completed'
    assert next(iter(ctx.repository.load().artifacts.values())).content.startswith('Accepted.\nContinued.')


@pytest.mark.parametrize('constraint',['legacy','attempts','window'])
def test_legacy_or_exhausted_limits_fail_without_continuation(setup,constraint):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        run=store.commands[p['id']].result
        if constraint=='legacy':run.pop('_continuation_version')
        elif constraint=='attempts':run['limits']['max_model_attempts']=1
    error=truncated()
    if constraint=='window':error.usage=error.usage.model_copy(update={'input_tokens':16000})
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(error)
    assert advance(ctx,p['id'])=='failed'
    run=ctx.repository.load().commands[p['id']].result
    assert '_continuation' not in run and run['error_code']=='agent_model_truncated'


def test_source_change_during_truncation_is_blocked(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def change(*a,**k):
        with ctx.repository.transaction() as store:store.materials[material].version+=1
        raise truncated()
    ctx.models.complete_tools=change
    assert advance(ctx,p['id'])=='blocked'
    assert '_continuation' not in ctx.repository.load().commands[p['id']].result


@pytest.mark.parametrize('action',['steer','redirect','pause','cancel'])
def test_control_during_provider_call_fences_late_fragment(setup,action):
    from homun.application.agent_control import control
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def respond(*a,**k):
        body={'command_id':'control','action':action,'expected_version':ctx.repository.load().works[work].version}
        if action in {'steer','redirect'}:body['text']='Corrected objective'
        control(ctx,actor,work,p['id'],body)
        raise truncated('Late fragment must not be replayed.')
    ctx.models.complete_tools=respond
    expected={'steer':'running','redirect':'queued','pause':'paused','cancel':'cancelled'}[action]
    assert advance(ctx,p['id'])==expected
    run=ctx.repository.load().commands[p['id']].result
    assert '_continuation' not in run and 'Late fragment' not in str(run['_messages'])
    assert ctx.repository.load().work_budgets[work].spent.output_tokens==600


def test_final_decision_survives_crash_before_publication(setup):
    from homun.application.agent_run_execution import _claim, _decision
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated('First.\n'))
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Last.'),usage=None)
    _,snapshot=_claim(ctx,p['id'])
    assert _decision(ctx,snapshot).message=='First.\nLast.'
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Final was generated twice')
    assert advance(ctx,p['id'])=='completed'
    store=ctx.repository.load()
    assert next(iter(store.artifacts.values())).content.startswith('First.\nLast.')
    assert store.commands[p['id']].result['_messages'][-1]['content']=='Last.'


def test_new_tool_round_supersedes_fragment_assembly(setup):
    from homun.models.native_turn import ToolCall
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated('Preliminary.'))
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='list',name='list_materials')]),usage=None)
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Grounded final.'),usage=None)
    assert advance(ctx,p['id'])=='completed'
    assert 'Preliminary' not in next(iter(ctx.repository.load().artifacts.values())).content


@pytest.mark.parametrize('parts,expected',[
    (['https://example.com/long','-path'],'https://example.com/long-path'),
    (['{"value":"hel','lo"}'],'{"value":"hello"}'),
    (['inter','rupted'],'interrupted'),
])
def test_join_preserves_mid_token_boundaries(parts,expected):
    from homun.models.truncation import join_parts
    assert join_parts(parts)==expected


def test_large_assembled_final_has_same_contract_after_crash(setup):
    from homun.application.agent_run_execution import _claim, _decision
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    first=''.join(f'Unique row {i:04d}.\n' for i in range(1000))
    assert len(first)>16000
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated(first))
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Final.'),usage=None)
    _,snapshot=_claim(ctx,p['id'])
    assert _decision(ctx,snapshot).message==first+'Final.'
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Final must replay')
    assert advance(ctx,p['id'])=='completed'
    assert next(iter(ctx.repository.load().artifacts.values())).content.startswith(first+'Final.')


def test_aggregate_limit_rejection_keeps_reported_usage(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    first=''.join(f'Unique row {i:04d}.\n' for i in range(1000))
    error=truncated(first)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(error)
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(
        message=NativeMessage(role='assistant',content='x'*50000),usage=error.usage)
    assert advance(ctx,p['id'])=='failed'
    store=ctx.repository.load()
    assert not store.artifacts and store.work_budgets[work].spent.output_tokens>=1200
    assert store.work_budgets[work].unknown.attempts==0


def test_transient_retry_retains_assembly_and_separate_attempt_budget(setup):
    from test_agent_recovery import due
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(truncated('First.\n'))
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:(_ for _ in ()).throw(NativeModelError('agent_model_server_error'))
    assert advance(ctx,p['id'])=='running'
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['recovery']['attempts']==1 and saved['_continuation']['parts']==['First.\n']
    due(ctx,p['id'])
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Last.'),usage=None)
    assert advance(ctx,p['id'])=='completed'
    assert next(iter(ctx.repository.load().artifacts.values())).content.startswith('First.\nLast.')
