"""Overflow recovery must transform the request before retrying it."""
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from test_agent_context import pressured, summary
from test_agent_recovery import final
from test_native_agent import native_start
from homun.application.agent_run_execution import advance
from homun.application.agent_control import control
from homun.context import create_context
from homun.models.native_errors import NativeModelError


def history(ctx,actor,work,material):
    p,_=pressured(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        run=store.commands[p['id']].result
        run['_context_policy']={'context_window':32768,'max_output_tokens':2048}
        run.pop('_lease_token');run.pop('_lease_until')
    return p


def overflow(*a,**k):raise NativeModelError('agent_model_overflow')


def test_overflow_intent_survives_restart_and_compacts_before_retry(setup):
    ctx,actor,work,material=setup;p=history(ctx,actor,work,material)
    original=ctx.repository.load().commands[p['id']].result['_messages']
    ctx.models.complete_summary=lambda *a,**k:pytest.fail('Below ordinary trigger')
    ctx.models.complete_tools=overflow
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert run['_force_context_compaction'] and '_lease_token' not in run
    second=create_context(db_path=ctx.data_dir/'ws.db',data_dir=ctx.data_dir,for_tests=True)
    try:
        calls=[]
        def summarize(*a,**k):calls.append('summary');return summary()
        def complete(messages,**kw):
            calls.append('decide');assert len(messages)<len(original);return final()
        second.models.complete_summary=summarize;second.models.complete_tools=complete
        assert advance(second,p['id'])=='completed'
        run=second.repository.load().commands[p['id']].result
        assert calls==['summary','decide']
        assert run['model_attempts']==3
        assert run['_messages'][:len(original)]==original
        assert run['_context_checkpoint']['estimated_after']<run['_context_checkpoint']['estimated_before']*.95
        assert '_force_context_compaction' not in run
    finally:second.close()


def test_overflow_without_compressible_history_stops_before_identical_retry(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    calls=[]
    def fail(*a,**k):calls.append(True);return overflow()
    ctx.models.complete_tools=fail
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_summary=lambda *a,**k:pytest.fail('No prefix can be summarized')
    assert advance(ctx,p['id'])=='failed'
    assert len(calls)==1
    assert ctx.repository.load().commands[p['id']].result['error_code']=='agent_context_pressure'


def test_overflow_with_unknown_window_does_not_guess_capacity(setup):
    ctx,actor,work,material=setup;p=native_start(ctx,actor,work,material)
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_context_policy']['context_window']=None
    ctx.models.complete_tools=overflow
    assert advance(ctx,p['id'])=='failed'
    assert ctx.repository.load().commands[p['id']].result['error_code']=='agent_model_overflow'


def test_steering_fences_overflow_failure(setup):
    ctx,actor,work,material=setup;p=history(ctx,actor,work,material)
    def fail(*a,**k):
        control(ctx,actor,work,p['id'],{'command_id':'steer','expected_version':ctx.repository.load().works[work].version,'action':'steer','text':'Nuova istruzione'})
        return overflow()
    ctx.models.complete_tools=fail
    assert advance(ctx,p['id'])=='running'
    run=ctx.repository.load().commands[p['id']].result
    assert '_force_context_compaction' not in run and '_lease_token' not in run
    assert run['_steering'][0]['text']=='Nuova istruzione'


def test_repeated_overflow_is_bounded_and_never_resets_acting_attempts(setup):
    ctx,actor,work,material=setup;p=history(ctx,actor,work,material)
    calls=[]
    def fail(*a,**k):calls.append('decide');return overflow()
    def summarize(*a,**k):calls.append('summary');return summary()
    ctx.models.complete_tools=fail;ctx.models.complete_summary=summarize
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='running'
    assert advance(ctx,p['id'])=='failed'
    assert calls==['decide','summary','decide','summary','decide']
    run=ctx.repository.load().commands[p['id']].result
    assert run['model_attempts']==5
    assert run['_model_phase_attempts']['decide']==3
    assert run['error_code']=='agent_model_overflow'
    assert not ctx.repository.load().artifacts


def test_summary_overflow_degrades_deterministically(setup):
    """Il riassunto è un'ottimizzazione: se il provider lo rifiuta il run
    sopravvive con un riassunto deterministico, non muore a fine lavoro."""
    ctx,actor,work,material=setup;p=history(ctx,actor,work,material)
    ctx.models.complete_tools=overflow
    assert advance(ctx,p['id'])=='running'
    ctx.models.complete_summary=overflow
    assert advance(ctx,p['id']) in {'running','completed'}
    run=ctx.repository.load().commands[p['id']].result
    # il degrado spezza la ricorsione: il recovery si ferma e il run vive
    assert run.get('_overflow_recoveries',0)<=2
    assert run['status'] in {'running','completed','queued'}


def test_compaction_respects_remaining_global_attempt_budget(setup):
    ctx,actor,work,material=setup;p=history(ctx,actor,work,material)
    ctx.models.complete_tools=overflow
    assert advance(ctx,p['id'])=='running'
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['limits']['max_model_attempts']=2
    ctx.models.complete_summary=lambda *a,**k:pytest.fail('Summary plus next request cannot fit budget')
    assert advance(ctx,p['id'])=='failed'
    assert ctx.repository.load().commands[p['id']].result['model_attempts']==1


def test_overflow_on_last_acting_attempt_does_not_pay_for_useless_summary(setup):
    from test_agent_recovery import due
    ctx,actor,work,material=setup;p=history(ctx,actor,work,material)
    calls=[]
    def fail(*a,**k):
        calls.append(True)
        if len(calls)<3:raise NativeModelError('agent_model_server_error')
        return overflow()
    ctx.models.complete_tools=fail
    ctx.models.complete_summary=lambda *a,**k:pytest.fail('No remaining acting attempt')
    for _ in range(2):
        assert advance(ctx,p['id'])=='running'
        due(ctx,p['id'])
    assert advance(ctx,p['id'])=='failed'
    run=ctx.repository.load().commands[p['id']].result
    assert run['model_attempts']==3 and '_force_context_compaction' not in run
