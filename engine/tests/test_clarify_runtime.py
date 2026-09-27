import json
import pytest
from homun.domain.errors import ValidationError
from types import SimpleNamespace
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve, resume_waiting
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage, ToolCall
from homun.context import create_context


def test_structured_clarify_waits_and_resumes_same_call_after_restart(setup):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    proposal = propose(ctx, actor, work, {'command_id':'run', 'expected_version':1, 'clarify':True})
    approve(ctx,actor,work,'run',{'command_id':'approve','digest':proposal['digest'],'expected_version':proposal['expected_version']})
    questions=[{'id':'format','question':'Formato?', 'choices':['PDF','CSV']},
               {'id':'columns','question':'Colonne?', 'choices':['Nome','Prezzo'], 'multi_select':True}]
    ctx.models.complete_tools=lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='clarify1',name='clarify',arguments={'questions':questions})]),usage=None)
    assert advance(ctx,'run') == 'waiting_input'
    store=ctx.repository.load();run=store.commands['run'].result
    assert [q['id'] for q in run['clarify_request']] == ['format','columns']
    assert not any(m['role']=='tool' for m in run['_messages'])
    ctx.service=ctx.service.for_store(store)
    for malformed in ({'answers':{}}, {'answers':{'wrong':'CSV'}}, {'answers':{'format':7,'columns':['Nome']}}):
        with pytest.raises(ValidationError):
            ctx.service.apply(actor,'bad-answer','work.provide_contribution',{'request_id':run['request_id'],
                'text':json.dumps(malformed),'expected_version':store.works[work].version})
        assert ctx.service.store.contributions[run['request_id']].status == 'pending'
    ctx.service.apply(actor,'answer','work.provide_contribution',{'request_id':run['request_id'],
        'text':json.dumps({'answers':{'format':'CSV','columns':['Nome','Prezzo']}}),
        'expected_version':store.works[work].version})
    ctx.persist()
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        assert resume_waiting(second,'run')
        assert not resume_waiting(second,'run')
        resumed=second.repository.load().commands['run'].result
        result=resumed['_messages'][-1]
        assert result['tool_call_id']=='clarify1'
        responses=json.loads(result['content'])['responses']
        assert [r['id'] for r in responses]==['format','columns']
        assert responses[1]['user_response']==['Nome','Prezzo']
        second.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',content='Scelto CSV con nome e prezzo.'),usage=None)
        assert advance(second,'run')=='completed'
    finally:
        second.close()


def test_response_keys_cannot_alias_another_question():
    from homun.application.agent_clarification import answer, questions
    pending = questions({'questions':[{'id':'q1','question':'First?'},{'id':'other','question':'Second?'}]})
    with pytest.raises(ValidationError): answer(pending, json.dumps({'answers':{'q1':'PDF'}}))
    result = answer(pending, json.dumps({'answers':{'q1':'PDF'},'partial':True}))
    assert result['responses'][0]['user_response']=='PDF'
    assert result['responses'][1]['user_response']==''
    assert result['partial'] is True

@pytest.mark.parametrize('item',[{'question':{'invalid':'shape'}},{'question':'Test','multi_select':'false'}])
def test_malformed_questions_are_not_coerced(item):
    from homun.application.agent_clarification import questions
    with pytest.raises(ValidationError): questions({'questions':[item]})
