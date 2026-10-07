from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage


def reply(text):
    return SimpleNamespace(message=NativeMessage(role='assistant',content=text),usage=None)


@pytest.mark.parametrize('text',["I'll now check the files.",'Ora posso preparare la nota italiana con questi dati.', 'I found the records. Next, I will summarize them.'])
def test_trailing_action_is_not_published_as_deliverable(setup,text):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:reply(text)
    assert advance(ctx,p['id'])=='running'
    assert not ctx.repository.load().artifacts
    def final(messages,**kwargs):
        assert messages[-1].role=='user' and 'complete' in messages[-1].content.lower()
        return reply('La consegna è prevista per venerdì.')
    ctx.models.complete_tools=final
    assert advance(ctx,p['id'])=='completed'
    assert next(iter(ctx.repository.load().artifacts.values())).content.startswith('La consegna')


def test_liveness_cap_survives_restart(setup):
    from homun.context import create_context
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:reply("I'll now check the files.")
    assert advance(ctx,p['id'])=='running'
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    second.models.complete_tools=ctx.models.complete_tools
    assert advance(second,p['id'])=='running'
    assert advance(second,p['id'])=='failed'
    store=second.repository.load()
    assert store.commands[p['id']].result['error_code']=='agent_model_stalled'
    assert not store.artifacts


@pytest.mark.parametrize('text',['42','Fatto.', 'I will now check the files. The answer is 42.',
    '"Ora posso preparare la nota."','The requested code:\n```\nI will now check\n```',
    'Questi sono i dati corretti.\n' * 20 + 'Ora posso preparare la nota.'])
def test_completed_or_quoted_answers_are_not_nudged(setup,text):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:reply(text)
    assert advance(ctx,p['id'])=='completed'


def test_legacy_run_keeps_existing_final_behavior(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:store.commands[p['id']].result.pop('_liveness_version')
    ctx.models.complete_tools=lambda *a,**k:reply("I'll now check the files.")
    assert advance(ctx,p['id'])=='completed'


def test_human_correction_during_generation_precedes_nudge(setup):
    from homun.application.agent_control import control
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def respond(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'steer','action':'steer','text':'New direction',
            'expected_version':ctx.repository.load().works[work].version})
        return reply("I'll now check the files.")
    ctx.models.complete_tools=respond
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert '_liveness_nudges' not in run and 'New direction' in run['_messages'][-1]['content']
    assert not ctx.repository.load().artifacts


def test_nudge_allows_real_tool_round_without_replaying_previous_result(setup):
    from homun.models.native_turn import ToolCall
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:reply("I'll now check the files.")
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='list',name='list_materials')]),usage=None)
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_tools=lambda *a,**k:reply('One authorized material is available.')
    assert advance(ctx,p['id'])=='completed'
    run=ctx.repository.load().commands[p['id']].result
    assert len(run['observations'])==1 and run['observations'][0]['tool']=='list_materials'


def test_stalled_final_keeps_all_known_usage(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def respond(*a,**k):
        result=reply("I'll now check the files.")
        result.usage=SimpleNamespace(input_tokens=17,output_tokens=40)
        return result
    ctx.models.complete_tools=respond
    assert [advance(ctx,p['id']) for _ in range(3)]==['running','running','failed']
    budget=ctx.repository.load().work_budgets[work]
    assert budget.spent.attempts==3 and budget.spent.output_tokens==120 and budget.unknown.attempts==0


@pytest.mark.parametrize('text',[
    'La traduzione è: "I will now check the files"',
    '«Ora posso preparare la nota»',
    '> I will now check the files.',
    '`I will now check the files`',
    '“I will now check the files.”',
])
def test_quoted_translation_or_excerpt_is_a_valid_deliverable(setup,text):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:reply(text)
    assert advance(ctx,p['id'])=='completed'


def test_genuine_human_correction_resets_nudge_counter(setup):
    from homun.application.agent_control import control
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    ctx.models.complete_tools=lambda *a,**k:reply("I'll now check the files.")
    assert advance(ctx,p['id'])=='running' and advance(ctx,p['id'])=='running'
    control(ctx,actor,work,p['id'],{'command_id':'new','action':'steer','text':'Corrected objective',
        'expected_version':ctx.repository.load().works[work].version})
    assert advance(ctx,p['id'])=='running'
    assert ctx.repository.load().commands[p['id']].result['_liveness_nudges']==1
