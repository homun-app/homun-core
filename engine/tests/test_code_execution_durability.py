from types import SimpleNamespace
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.application.agent_tool_registry import registry_for
from homun.models.native_turn import NativeMessage, ToolCall


def prepare(setup, code):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    proposal=propose(ctx,actor,work,{'command_id':'run','expected_version':1,'code_execution':True})
    approve(ctx,actor,work,'run',{'command_id':'approve','digest':proposal['digest'],'expected_version':proposal['expected_version']})
    ctx.models.complete_tools=lambda *a,**k:SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=[ToolCall(id='python1',name='execute_code',arguments={'code':code})]),usage=None)
    return ctx, actor


def test_real_code_round_persists_receipt_and_does_not_replay(setup):
    ctx,actor=prepare(setup, 'print("actual child output")')
    assert advance(ctx,'run')=='running'
    run=ctx.repository.load().commands['run'].result
    assert run['_code_receipts']['python1']['status']=='completed'
    assert run['observations'][0]['result']['stdout'].strip()=='actual child output'
    assert next(t for t in registry_for(run).manifest() if t['name']=='execute_code')['replay']=='never'


def test_pending_receipt_after_restart_never_launches_code(setup):
    ctx,actor=prepare(setup, 'raise Exception("must not execute")')
    with ctx.repository.transaction() as store:
        run=store.commands['run'].result
        run['_code_receipts']={'python1':{'status':'dispatching'}}
    from homun.context import create_context
    second = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    second.models.complete_tools = ctx.models.complete_tools
    try:
        assert advance(second,'run')=='running'
        result=second.repository.load().commands['run'].result['observations'][0]['result']
    finally:
        second.close()
    assert result['error_code']=='execution_outcome_unknown'
    assert result['exit_code'] is None
