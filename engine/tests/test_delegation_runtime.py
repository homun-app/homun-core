"""Durable admitted children use the canonical scoped runtime."""
import json
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage, ToolCall


def start(setup):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = propose(ctx, actor, work, {'command_id':'parent','expected_version':1,
        'material_ids':[material], 'delegation':True})
    approve(ctx, actor, work, p['id'], {'command_id':'approve','digest':p['digest'],
        'expected_version':p['expected_version']})
    return ctx, actor, work, material, p


def delegate(ctx, p, arguments=None):
    arguments = arguments or {'task':'Read evidence', 'tools_include':['read_material'],
                               'run_in_background':True, 'max_turns':2}
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='delegate-1', name='delegate_task', arguments=arguments)]), usage=None)
    assert advance(ctx, p['id']) in {'running', 'waiting_automation'}
    return ctx.repository.load().commands[p['id']].result['observations'][-1]['result']


def test_background_returns_before_child_model_and_child_is_admitted(setup):
    ctx, actor, work, material, p = start(setup)
    calls = []
    ctx.models.complete = lambda *a, **kw: calls.append(True)
    result = delegate(ctx, p)
    assert result['status'] == 'queued'
    assert not calls
    child = ctx.repository.load().commands[result['child_run_id']].result
    assert child['status'] == 'queued'
    assert child['work_id'] == work
    assert child['allowed_tools'] == ['read_material']
    assert child['_delegation_parent']['run_id'] == p['id']
    assert child['observations'] == []
    assert all('delegate-1' not in json.dumps(m) for m in child['_messages'])


def test_child_real_tool_turn_finish_and_parent_receipt_once(setup):
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p)
    child_id = result['child_run_id']
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='read-1', name='read_material', arguments={'material_id':material})]), usage=None)
    assert advance(ctx, child_id) == 'running'
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant', content='Consegna venerdi'), usage=None)
    assert advance(ctx, child_id) == 'completed'
    assert not ctx.repository.load().artifacts
    assert ctx.repository.load().works[work].status == 'running'
    assert reconcile_delegations(ctx) == [result['delegation_id']]
    assert reconcile_delegations(ctx) == []
    parent = ctx.repository.load().commands[p['id']].result
    assert parent['_delegations'][result['delegation_id']]['status'] == 'completed'
    assert len([x for x in parent['_steering'] if x['source'] == 'delegation']) == 1


def test_child_scope_cannot_escape_parent_tools(setup):
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p, {'task':'Forbidden', 'tools_include':['terminal_execute'], 'run_in_background':True})
    assert result['error_code'] == 'delegation_tool_unavailable'
    assert len([r for r in ctx.repository.load().commands.values() if r.result.get('_delegation_parent')]) == 0


def test_unknown_parent_cannot_spawn_child(setup):
    from homun.application.delegation_tools import execute
    from homun.domain.errors import ValidationError
    ctx, actor, work, material, p = start(setup)
    with pytest.raises(ValidationError):
        execute(ctx, actor, {'id':'invented','work_id':work,'delegation':{'policy':'isolated-subagent-v1'}},
                'delegate_task', {'task':'Do work'})


def test_foreground_waits_then_durable_child_result_wakes_parent(setup):
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p, {'task':'Summarize', 'tools_include':[], 'max_turns':1})
    assert result['wait_for_child']
    assert ctx.repository.load().commands[p['id']].result['status'] == 'waiting_automation'
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant', content='Child evidence'), usage=None)
    assert advance(ctx, result['child_run_id']) == 'completed'
    reconcile_delegations(ctx)
    parent = ctx.repository.load().commands[p['id']].result
    assert parent['status'] == 'queued'
    assert parent['_epoch'] == 1
    assert advance(ctx, p['id'], epoch=0) == 'superseded'
    assert advance(ctx, p['id'], epoch=1) == 'completed'
    assert len(ctx.repository.load().artifacts) == 1


def test_restart_after_admission_before_parent_receipt_deduplicates(setup, monkeypatch):
    from homun.application import agent_native
    from homun.context import create_context
    ctx, actor, work, material, p = start(setup)
    append = agent_native.append_result
    monkeypatch.setattr(agent_native, 'append_result', lambda *a, **kw: (_ for _ in ()).throw(SystemExit('crash after admission')))
    with pytest.raises(SystemExit):
        delegate(ctx, p)
    first = ctx.repository.load()
    child_ids = [r.command_id for r in first.commands.values() if r.result.get('_delegation_parent')]
    assert len(child_ids) == 1
    limits = dict(first.commands[p['id']].result['limits'])
    monkeypatch.setattr(agent_native, 'append_result', append)
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until'] = '2000-01-01T00:00:00+00:00'
    reopened = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        reopened.models.complete_tools = lambda *a, **kw: (_ for _ in ()).throw(AssertionError('Replay must not call model'))
        assert advance(reopened, p['id']) == 'running'
        after = reopened.repository.load()
        assert [r.command_id for r in after.commands.values() if r.result.get('_delegation_parent')] == child_ids
        assert after.commands[p['id']].result['limits'] == limits
    finally:
        reopened.close()


def test_child_failure_does_not_fail_parent_work(setup):
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p, {'task':'Return structured data', 'tools_include':[], 'max_turns':1,
        'run_in_background':True, 'output_schema':{'type':'object','required':['answer']}})
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant', content='Raw partial work'), usage=None)
    assert advance(ctx, result['child_run_id']) == 'failed'
    assert ctx.repository.load().works[work].status == 'running'
    reconcile_delegations(ctx)
    receipt = ctx.repository.load().commands[p['id']].result['_delegations'][result['delegation_id']]
    assert receipt['status'] == 'failed'
    assert receipt['result'] == 'Raw partial work'
    assert receipt['schema_error']
    assert not ctx.repository.load().artifacts


def test_parent_cancel_fences_unstarted_child_without_model_call(setup):
    from homun.application.agent_control import control
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p)
    control(ctx, actor, work, p['id'], {'command_id':'cancel','action':'cancel',
        'expected_version':ctx.repository.load().works[work].version})
    ctx.models.complete_tools = lambda *a, **kw: (_ for _ in ()).throw(AssertionError('Cancelled child must not run'))
    assert advance(ctx, result['child_run_id']) == 'cancelled'
    assert reconcile_delegations(ctx) == [result['delegation_id']]
    assert ctx.repository.load().commands[p['id']].result['status'] == 'cancelled'


def test_parent_limit_allocation_cannot_be_multiplied_and_returns_unused(setup):
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    before = dict(ctx.repository.load().commands[p['id']].result['limits'])
    result = delegate(ctx, p)
    allocated = ctx.repository.load().commands[p['id']].result
    assert allocated['limits']['max_turns'] == before['max_turns'] - 2
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant', content='Done'), usage=None)
    assert advance(ctx, result['child_run_id']) == 'completed'
    reconcile_delegations(ctx)
    after = ctx.repository.load().commands[p['id']].result
    assert after['limits']['max_turns'] == before['max_turns'] - 1
    assert after['limits']['max_model_attempts'] == before['max_model_attempts'] - 1
    reconcile_delegations(ctx)
    assert ctx.repository.load().commands[p['id']].result['limits'] == after['limits']


def test_two_children_execute_independently_and_dispatch_with_stable_ids(setup, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from homun.runtime.workflows import agent_run
    ctx, actor, work, material, p = start(setup)
    args = {'task':'Independent analysis', 'tools_include':[], 'max_turns':2, 'run_in_background':True}
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='one',name='delegate_task',arguments=args),
                    ToolCall(id='two',name='delegate_task',arguments=args)]), usage=None)
    assert advance(ctx, p['id']) == 'running'
    assert advance(ctx, p['id']) == 'running'
    children = [r.result for r in ctx.repository.load().commands.values() if r.result.get('_delegation_parent')]
    assert len(children) == 2
    dispatched = []
    monkeypatch.setattr(agent_run, 'start', lambda *a: dispatched.append(a))
    agent_run.deliver_agent_runs(ctx)
    agent_run.deliver_agent_runs(ctx)
    assert all(dispatched.count((c['_workflow_id'], c['id'], 0)) == 2 for c in children)
    barrier = Barrier(2)
    def complete(*a, **kw):
        barrier.wait(timeout=5)
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Independent result'), usage=None)
    ctx.models.complete_tools = complete
    with ThreadPoolExecutor(2) as pool:
        outcomes = list(pool.map(lambda c: advance(ctx, c['id']), children))
    assert outcomes == ['completed', 'completed']
    assert not ctx.repository.load().artifacts


def test_child_call_outside_subset_is_refused_by_real_dispatch(setup):
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p, {'task':'Analyze', 'tools_include':[], 'max_turns':2, 'run_in_background':True})
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id='unauthorized',name='read_material',arguments={'material_id':material})]), usage=None)
    assert advance(ctx, result['child_run_id']) == 'running'
    observed = ctx.repository.load().commands[result['child_run_id']].result['observations'][-1]['result']
    assert observed['error_code'] == 'validation_error'
    assert 'text' not in observed


def test_parent_cancel_during_child_model_discards_child_finish(setup):
    from homun.application.agent_control import control
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p)
    def model(*a, **kw):
        control(ctx, actor, work, p['id'], {'command_id':'cancel-mid-child','action':'cancel',
            'expected_version':ctx.repository.load().works[work].version})
        return SimpleNamespace(message=NativeMessage(role='assistant', content='Late child result'), usage=None)
    ctx.models.complete_tools = model
    assert advance(ctx, result['child_run_id']) in {'blocked','cancelled'}
    assert ctx.repository.load().works[work].status == 'cancelled'
    assert not ctx.repository.load().artifacts


def test_idle_automation_does_not_wake_waiting_parent_before_receipt(setup):
    from homun.application.delegation_runtime import reconcile_delegations, has_pending, live_count
    from homun.application.agent_automation import wake_due_automation
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p, {'task':'Evidence', 'tools_include':[], 'max_turns':1})
    assert has_pending(ctx, p)
    assert live_count(ctx, p) == 1
    assert wake_due_automation(ctx, now=10**12) == []
    parent = ctx.repository.load().commands[p['id']].result
    assert parent['_epoch'] == 0
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(message=NativeMessage(role='assistant', content='Evidence'), usage=None)
    assert advance(ctx, result['child_run_id']) == 'completed'
    assert live_count(ctx, p) == 0
    assert has_pending(ctx, p)  # Terminal output still needs durable admission.
    assert wake_due_automation(ctx, now=10**12) == []
    assert reconcile_delegations(ctx) == [result['delegation_id']]
    assert not has_pending(ctx, p)
    assert wake_due_automation(ctx, now=10**12) == []
    assert ctx.repository.load().commands[p['id']].result['_epoch'] == 1


def test_children_do_not_replace_parent_surface_or_accept_direct_work_controls(setup):
    from homun.application.agent_runs import list_runs
    from homun.application.agent_control import control
    from homun.domain.errors import ValidationError
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx, p)
    assert [r['id'] for r in list_runs(ctx, actor, work)['items']] == [p['id']]
    with pytest.raises(ValidationError, match="parent supervisor"):
        control(ctx, actor, work, result['child_run_id'], {'command_id':'child-cancel',
            'action':'cancel', 'expected_version':ctx.repository.load().works[work].version})
    assert ctx.repository.load().works[work].status == 'running'
    assert ctx.repository.load().commands[result['child_run_id']].result['status'] == 'queued'


def test_child_receipt_before_parent_tool_commit_does_not_park_forever(setup, monkeypatch):
    from homun.application import delegation_admission
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    admit = delegation_admission.admit
    def complete_before_parent_receipt(*args):
        handle = admit(*args)
        ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(
            message=NativeMessage(role='assistant',content='Child evidence'),usage=None)
        assert advance(ctx,handle['child_run_id']) == 'completed'
        assert reconcile_delegations(ctx) == [handle['delegation_id']]
        return handle
    monkeypatch.setattr(delegation_admission,'admit',complete_before_parent_receipt)
    delegate(ctx,p,{'task':'Read evidence','run_in_background':False,'max_turns':2})
    parent = ctx.repository.load().commands[p['id']].result
    assert parent['status'] == 'running'
    assert parent['_steering'][0]['source'] == 'delegation'
    assert advance(ctx,p['id']) == 'completed'


def test_unresolved_schema_reference_is_a_durable_child_failure(setup):
    from homun.application.delegation_runtime import reconcile_delegations
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx,p,{'task':'Produce JSON','max_turns':2,'output_schema':{'$ref':'#/$defs/missing'}})
    ctx.models.complete_tools = lambda *a, **kw: SimpleNamespace(
        message=NativeMessage(role='assistant',content='{"raw":"valuable work"}'),usage=None)
    assert advance(ctx,result['child_run_id']) == 'failed'
    assert reconcile_delegations(ctx) == [result['delegation_id']]
    child = ctx.repository.load().commands[result['child_run_id']].result
    assert child['error_code'] == 'delegation_output_schema_invalid'
    assert child['_delegation_result']['result'] == '{"raw":"valuable work"}'
    assert ctx.repository.load().works[work].status == 'running'


def test_external_schema_references_are_rejected_before_admission(setup):
    ctx, actor, work, material, p = start(setup)
    result = delegate(ctx,p,{'task':'Produce JSON','output_schema':{'$defs':{'secret':{'$ref':'http://127.0.0.1/private'}}}})
    assert result['error_code'] == 'delegation_schema_invalid'
    assert not any(c.result.get('_delegation_parent') for c in ctx.repository.load().commands.values())
