from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from homun.application.agent_context import prepare, ContextPreparationDeferred
from homun.application.agent_run_execution import _claim
from homun.application.agent_control import control
from homun.models.native_turn import NativeMessage, ToolCall
from homun.domain.errors import DomainError


def pressured(ctx,actor,work,material):
    p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        run=store.commands[p['id']].result
        for i in range(6):
            run['_messages'].append(NativeMessage(role='assistant',tool_calls=[ToolCall(id=f'r{i}',name='read_material',arguments={'material_id':material})]).model_dump())
            run['_messages'].append(NativeMessage(role='tool',tool_call_id=f'r{i}',name='read_material',content=('archived context '+str(i)+' ')*350).model_dump())
        run['_context_policy']={'context_window':4096,'max_output_tokens':512}
    _,run=_claim(ctx,p['id'])
    return p,run


def summary(text='Historical task: produce a note. Completed: reviewed older source extracts. Pending: finish the note.'):
    return SimpleNamespace(message=NativeMessage(role='assistant',content=text),usage=None)


def test_compaction_keeps_raw_history_and_reuses_checkpoint(setup):
    from homun.models.context_plan import project_checkpoint
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    before=run['_messages'].copy();seen=[]
    def summarize(messages,**kwargs):seen.append((messages,kwargs));return summary()
    ctx.models.complete_summary=summarize
    result=prepare(ctx,run,[])
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['_messages']==before
    assert len(seen)==1 and len(result)<len(before)
    assert saved['_context_checkpoint']['prefix_hash']
    assert saved['model_attempts']==1
    assert project_checkpoint([NativeMessage.model_validate(m) for m in before],saved['_context_checkpoint'])==result
    assert prepare(ctx,saved,[])==result
    assert len(seen)==1


def test_correction_during_summary_rejects_late_checkpoint(setup):
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    def summarize(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'steer','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Nuova istruzione'})
        return summary()
    ctx.models.complete_summary=summarize
    with pytest.raises(ContextPreparationDeferred):prepare(ctx,run,[])
    saved=ctx.repository.load().commands[p['id']].result
    assert '_context_checkpoint' not in saved
    assert '_lease_token' not in saved
    assert saved['_steering'][0]['text']=='Nuova istruzione'
    assert saved['status']=='running'


def test_bad_summary_preserves_history_and_does_not_publish_checkpoint(setup):
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    ctx.models.complete_summary=lambda *a,**k:summary('')
    with pytest.raises(DomainError) as exc:prepare(ctx,run,[])
    assert exc.value.code=='agent_context_summary_failed'
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['_messages']==run['_messages']
    assert '_context_checkpoint' not in saved


def test_summary_requires_attempt_room_for_acting_request(setup):
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['model_attempts']=11
    def forbidden(*a,**k):pytest.fail('No budget for summary plus acting request')
    ctx.models.complete_summary=forbidden
    with pytest.raises(DomainError):prepare(ctx,run,[])


def test_work_budget_must_cover_summary_and_next_request(setup):
    from homun.application import budgets
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        budgets.ensure(store,work).caps.model_attempts=1
    calls=[]
    ctx.models.complete_summary=lambda *a,**k:(calls.append(True) or summary())
    with pytest.raises(DomainError) as exc:prepare(ctx,run,[])
    assert exc.value.code=='budget_exhausted'
    assert calls==[]


def test_clipped_summary_input_is_explicit_in_checkpoint_coverage(setup):
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    ctx.models.complete_summary=lambda *a,**k:summary()
    prepare(ctx,run,[])
    checkpoint=ctx.repository.load().commands[p['id']].result['_context_checkpoint']
    assert checkpoint['summary_input_clipped_records']
    assert checkpoint['coverage']['sampled'] is True


@pytest.mark.parametrize('outcome',['empty','no_progress','provider_error'])
def test_stale_summary_failure_defers_instead_of_failing_correction(setup,outcome):
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    def summarize(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'steer','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Correzione durante riepilogo'})
        if outcome=='provider_error':raise RuntimeError('transport failed')
        return summary('' if outcome=='empty' else 'irrelevant text '*6000)
    ctx.models.complete_summary=summarize
    with pytest.raises(ContextPreparationDeferred):prepare(ctx,run,[])
    saved=ctx.repository.load().commands[p['id']].result
    assert saved['status']=='running'
    assert '_context_checkpoint' not in saved
    assert '_lease_token' not in saved
    assert saved['_steering'][0]['text']=='Correzione durante riepilogo'


@pytest.mark.parametrize('action',['redirect','cancel','pause'])
def test_control_during_summary_fences_checkpoint(setup,action):
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    def summarize(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':action,'expected_version':ctx.repository.load().works[work].version,'action':action,'text':'Nuovo obiettivo' if action=='redirect' else None})
        return summary()
    ctx.models.complete_summary=summarize
    with pytest.raises(ContextPreparationDeferred):prepare(ctx,run,[])
    saved=ctx.repository.load().commands[p['id']].result
    assert '_context_checkpoint' not in saved
    assert saved['status']=={'redirect':'queued','cancel':'cancelled','pause':'paused'}[action]


def test_checkpoint_restart_and_distinct_summary_acting_usage(setup):
    from homun.context import create_context
    from homun.application.agent_run_execution import advance
    from homun.application.agent_tools import catalog
    from homun.application.agent_native import QUESTION
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    ctx.models.complete_summary=lambda *a,**k:SimpleNamespace(message=summary().message,
        usage=SimpleNamespace(input_tokens=2400,output_tokens=80,model_id='test-model'))
    prepare(ctx,run,catalog()+[QUESTION])
    checkpoint=ctx.repository.load().commands[p['id']].result['_context_checkpoint']
    # Simulate process exit after checkpoint commit, before acting response.
    with ctx.repository.transaction() as store:
        current=store.commands[p['id']].result
        current.pop('_lease_token');current.pop('_lease_until')
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        seen=[]
        second.models.complete_summary=lambda *a,**k:pytest.fail('Persisted checkpoint must be reused')
        def finish(messages,**kw):
            seen.extend(messages)
            return SimpleNamespace(message=NativeMessage(role='assistant',content='Nota conclusiva.'),usage=None)
        second.models.complete_tools=finish
        assert advance(second,p['id'])=='completed'
        saved=second.repository.load()
        assert saved.commands[p['id']].result['_context_checkpoint']==checkpoint
        assert any(checkpoint['summary'] in m.content for m in seen)
        assert saved.commands[p['id']].result['model_attempts']==2
        budget=saved.work_budgets[work]
        assert budget.spent.input_tokens==2400
        assert budget.spent.output_tokens==80
        assert budget.spent.attempts==1
        assert budget.unknown.attempts==1
        assert len(saved.artifacts)==1 and saved.works[work].status=='review'
    finally:second.close()


def test_steering_between_summary_fence_and_validation_failure_is_not_terminal(setup,monkeypatch):
    from homun.application import agent_context
    from homun.application.agent_run_execution import advance
    from homun.models.context_plan import ContextPressureError
    ctx,actor,work,material=setup;p,run=pressured(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        current=store.commands[p['id']].result
        current.pop('_lease_token');current.pop('_lease_until')
    ctx.models.complete_summary=lambda *a,**k:summary()
    def invalid(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'steer-at-validation','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Correzione tardiva'})
        raise ContextPressureError('No progress')
    monkeypatch.setattr(agent_context,'build_checkpoint',invalid)
    assert advance(ctx,p['id'])=='running'
    saved=ctx.repository.load().commands[p['id']].result
    assert '_lease_token' not in saved
    assert saved['_steering'][0]['text']=='Correzione tardiva'
    assert 'error_code' not in saved
