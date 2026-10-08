"""An interrupted provider call consumes its durable retry slot before IO."""
import pytest
from test_agent_runs import setup
from test_native_agent import native_start
from test_agent_recovery import final, due
from homun.application.agent_run_execution import advance
from homun.application.agent_control import control
from homun.context import create_context
from homun.models.native_errors import NativeModelError


class ProcessStopped(BaseException):
    pass


@pytest.mark.parametrize('phase',['decide','summary'])
def test_process_loss_during_each_call_cannot_create_fourth_attempt(setup,phase):
    ctx,actor,work,material=setup
    if phase=='summary':
        from test_agent_context import pressured
        p,_=pressured(ctx,actor,work,material)
    else:p=native_start(ctx,actor,work,material)
    calls=[]
    def stopped(*a,**k):calls.append(True);raise ProcessStopped()
    current=ctx
    try:
        for attempt in range(3):
            with current.repository.transaction() as store:
                run=store.commands[p['id']].result
                run.pop('_lease_token',None);run.pop('_lease_until',None)
            setattr(current.models,'complete_summary' if phase=='summary' else 'complete_tools',stopped)
            with pytest.raises(ProcessStopped):advance(current,p['id'])
            if current is not ctx:current.close()
            current=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
        with current.repository.transaction() as store:
            run=store.commands[p['id']].result
            run.pop('_lease_token',None);run.pop('_lease_until',None)
        setattr(current.models,'complete_summary' if phase=='summary' else 'complete_tools',stopped)
        assert advance(current,p['id'])=='failed'
        run=current.repository.load().commands[p['id']].result
        assert len(calls)==3 and run['model_attempts']==3
        assert run['error_code']=='agent_model_attempts_exhausted'
        assert not current.repository.load().artifacts
    finally:
        if current is not ctx:current.close()


def test_steering_during_failure_does_not_schedule_old_request(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def failing(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'correction','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Usa la nuova indicazione'})
        raise NativeModelError('agent_model_server_error',retry_after_seconds=600)
    ctx.models.complete_tools=failing
    assert advance(ctx,p['id'])=='running'
    assert ctx.repository.load().commands[p['id']].result.get('recovery',{}).get('status')!='waiting'
    seen=[]
    def finish(messages,**k):seen.extend(messages);return final()
    ctx.models.complete_tools=finish
    assert advance(ctx,p['id'])=='completed'
    assert any('Usa la nuova indicazione' in m.content for m in seen)


def test_steering_during_wait_can_continue_immediately(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    def failing(*a,**k):raise NativeModelError('agent_model_server_error',retry_after_seconds=600)
    ctx.models.complete_tools=failing
    assert advance(ctx,p['id'])=='running'
    control(ctx,actor,work,p['id'],{'command_id':'correction','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Nuova indicazione'})
    ctx.models.complete_tools=lambda *a,**k:final()
    assert advance(ctx,p['id'])=='completed'


def test_legacy_crashed_third_attempt_is_not_granted_again(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        run=store.commands[p['id']].result
        run.update(model_attempts=3,_lease_token='legacy-owner',_lease_until='2000-01-01T00:00:00+00:00',
            recovery={'phase':'decide','status':'waiting','attempts':2,'error_code':'agent_model_server_error','next_attempt_at':'2000-01-01T00:00:00+00:00'})
    ctx.models.complete_tools=lambda *a,**k:pytest.fail('Legacy in-flight third attempt consumed its slot')
    assert advance(ctx,p['id'])=='failed'
    assert ctx.repository.load().commands[p['id']].result['error_code']=='agent_model_attempts_exhausted'


def test_corrected_new_format_crash_is_not_migrated_as_legacy(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['model_attempts']=2
    def corrected_then_stopped(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'correct','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Nuova richiesta corretta'})
        raise ProcessStopped()
    ctx.models.complete_tools=corrected_then_stopped
    with pytest.raises(ProcessStopped):advance(ctx,p['id'])
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    ctx.models.complete_tools=lambda *a,**k:final()
    assert advance(ctx,p['id'])=='completed'
