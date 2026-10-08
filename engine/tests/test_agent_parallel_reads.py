"""Bounded parallel reads preserve native order and canonical human controls."""
from threading import Barrier
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.models.native_turn import NativeMessage, ToolCall


def start(setup, **policy):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    run = propose(ctx,actor,work,{'command_id':'parallel','expected_version':1,
        'material_ids':[material],**policy})
    approve(ctx,actor,work,run['id'],{'command_id':'approve','digest':run['digest'],'expected_version':run['expected_version']})
    return ctx,actor,work,material,run


def two_reads(material):
    return [ToolCall(id=f'read-{i}',name='read_material',arguments={'material_id':material}) for i in range(2)]


def test_reads_execute_concurrently_but_commit_in_model_order(setup,monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material,run = start(setup,parallel_read_tools=True)
    barrier = Barrier(2,timeout=2)
    original = agent_run_execution.run_tool
    def read(*args):
        barrier.wait()
        return original(*args)
    monkeypatch.setattr(agent_run_execution,'run_tool',read)
    ctx.models.complete_tools = lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=two_reads(material)),usage=None)
    assert advance(ctx,run['id']) == 'running'
    current = ctx.repository.load().commands[run['id']].result
    assert current['parallel_read_tools'] is True
    assert [m['tool_call_id'] for m in current['_messages'] if m['role']=='tool'] == ['read-0','read-1']
    assert current['turns'] == 2
    assert len(current['observations']) == 2


def test_batch_stops_at_human_question(setup):
    ctx,actor,work,material,run = start(setup,parallel_read_tools=True)
    calls = two_reads(material) + [ToolCall(id='question',name='request_user_input',arguments={'question':'Proceed?'})] + [ToolCall(id='later',name='list_materials')]
    ctx.models.complete_tools = lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=calls),usage=None)
    assert advance(ctx,run['id']) == 'running'
    assert advance(ctx,run['id']) == 'waiting_input'
    current = ctx.repository.load().commands[run['id']].result
    assert [m['tool_call_id'] for m in current['_messages'] if m['role']=='tool'] == ['read-0','read-1']


def test_pause_during_parallel_reads_discards_uncommitted_results(setup,monkeypatch):
    from homun.application import agent_run_execution
    from homun.application.agent_control import control
    ctx,actor,work,material,run = start(setup,parallel_read_tools=True)
    barrier = Barrier(2,timeout=2)
    original = agent_run_execution.run_tool
    def read(*args):
        index = barrier.wait()
        if index == 0:
            control(ctx,actor,work,run['id'],{'command_id':'pause','action':'pause',
                'expected_version':ctx.repository.load().works[work].version})
        barrier.wait()
        return {'text':'Read completed after pause'}
    monkeypatch.setattr(agent_run_execution,'run_tool',read)
    ctx.models.complete_tools = lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=two_reads(material)),usage=None)
    assert advance(ctx,run['id']) == 'paused'
    current = ctx.repository.load().commands[run['id']].result
    assert not current['observations']
    assert not any(m['role']=='tool' for m in current['_messages'])


def test_crash_during_batch_commit_replays_reads_without_duplicate_results(setup,monkeypatch):
    from homun.application import agent_native
    ctx,actor,work,material,run = start(setup,parallel_read_tools=True)
    ctx.models.complete_tools = lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',tool_calls=two_reads(material)),usage=None)
    original = agent_native.append_result
    count = []
    def crash_on_second(*args):
        count.append(1)
        if len(count)==2:
            raise SystemExit('crash during result admission')
        return original(*args)
    monkeypatch.setattr(agent_native,'append_result',crash_on_second)
    with pytest.raises(SystemExit):
        advance(ctx,run['id'])
    assert not ctx.repository.load().commands[run['id']].result['observations']
    monkeypatch.setattr(agent_native,'append_result',original)
    with ctx.repository.transaction() as store:
        store.commands[run['id']].result['_lease_until']='2000-01-01T00:00:00+00:00'
    assert advance(ctx,run['id']) == 'running'
    current = ctx.repository.load().commands[run['id']].result
    assert [m['tool_call_id'] for m in current['_messages'] if m['role']=='tool'] == ['read-0','read-1']


def test_batch_is_bounded_to_four_reads_per_advance(setup,monkeypatch):
    from homun.application import agent_run_execution
    ctx,actor,work,material,run=start(setup,parallel_read_tools=True)
    barrier=Barrier(4,timeout=2)
    original=agent_run_execution.run_tool
    seen=[]
    def read(*args):
        seen.append(1)
        barrier.wait()
        return original(*args)
    monkeypatch.setattr(agent_run_execution,'run_tool',read)
    ctx.models.complete_tools=lambda *a,**k: SimpleNamespace(message=NativeMessage(role='assistant',
        tool_calls=[ToolCall(id=f'call-{i}',name='list_materials') for i in range(8)]),usage=None)
    assert advance(ctx,run['id'])=='running'
    assert len(seen)==4
    assert ctx.repository.load().commands[run['id']].result['turns']==4
    assert advance(ctx,run['id'])=='running'
    assert len(seen)==8


def test_side_effect_boundary_is_not_batched(setup):
    from homun.application.agent_parallel_reads import select
    ctx,actor,work,material,run=start(setup,parallel_read_tools=True)
    current=ctx.repository.load().commands[run['id']].result
    current['_messages'].append(NativeMessage(role='assistant',tool_calls=[
        *two_reads(material),ToolCall(id='write',name='write_workspace_file',arguments={'path':'x','content':'x'}),
        ToolCall(id='after',name='list_materials')]).model_dump())
    assert [call.id for call in select(current)]==['read-0','read-1']
