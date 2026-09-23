from copy import deepcopy
import pytest
from homun.models.native_turn import NativeMessage as M, ToolCall
from homun.models.agent_turn import ToolDefinition
from homun.models.context_plan import (plan_context, build_checkpoint, project_checkpoint,
                                      estimate_tokens_rough, ContextPressureError)


def transcript(rounds=8, size=1600):
    rows = [M(role='system', content='Follow permissions.'), M(role='user', content='Compare the sources.')]
    for i in range(rounds):
        rows += [M(role='assistant', tool_calls=[ToolCall(id=f'c{i}', name='read', arguments={'i': i})]),
                 M(role='tool', tool_call_id=f'c{i}', name='read', content='x' * size)]
    return rows


def test_estimate_is_rough_unicode_safe():
    assert estimate_tokens_rough('') == 0
    assert estimate_tokens_rough('12345') == 2
    assert estimate_tokens_rough('你好한') == 3
    assert estimate_tokens_rough('العربية') >= 3
    assert estimate_tokens_rough('\ud800') > 0


def test_unknown_and_small_histories_unchanged():
    rows = transcript(1, 10)
    for window in (None, 16384):
        plan = plan_context(rows, [], context_window=window, max_output_tokens=1024)
        assert plan.cut is None
        assert plan.messages == rows
        assert plan.messages is not rows
    assert plan.input_limit == 15360


def test_reserves_tools_and_output_and_preserves_canonical():
    rows = transcript()
    original = deepcopy(rows)
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    assert plan.input_limit == 3072
    assert plan.before_tokens >= plan.threshold
    assert plan.cut is not None
    assert rows == original
    large_tool = ToolDefinition(name='large', description='z' * 15000, input_schema={})
    with pytest.raises(ContextPressureError, match='protected'):
        plan_context(rows, [large_tool], context_window=4096, max_output_tokens=1024)


def test_cut_keeps_atomic_parallel_groups_initial_objective_and_recent_group():
    rows = transcript()
    rows[2].tool_calls.append(ToolCall(id='parallel', name='read', arguments={}))
    rows.insert(4, M(role='tool', tool_call_id='parallel', name='read', content='y' * 1600))
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    assert plan.cut and rows[plan.cut].role == 'assistant'
    checkpoint = build_checkpoint(rows, plan, 'Read earlier sources; continue the comparison.', [])
    projected = project_checkpoint(rows, checkpoint)
    assert projected[:2] == rows[:2]
    assert projected[-2:] == rows[-2:]
    assert projected[2].role == 'assistant' and 'HISTORICAL' in projected[2].content
    assert 'c7' in {c.id for m in projected for c in m.tool_calls}
    assert rows[2].tool_calls[0].id == 'c0'


def test_latest_consecutive_corrections_remain_verbatim():
    rows = transcript()
    corrections = [M(role='user', content='Use only Italy.'), M(role='user', content='Do not publish.')]
    rows += corrections + transcript(1, 100)[2:]
    rows[-2].tool_calls[0].id = 'latest'
    rows[-1].tool_call_id = 'latest'
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    checkpoint = build_checkpoint(rows, plan, 'Earlier material read.', [])
    projected = project_checkpoint(rows, checkpoint)
    assert projected[-4:-2] == corrections


def test_pending_group_is_never_summarized():
    rows = transcript()
    rows += [M(role='assistant', tool_calls=[ToolCall(id='pending', name='read', arguments={})])]
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    assert plan.cut is not None
    assert all(c.id != 'pending' for m in plan.source for c in m.tool_calls)
    checkpoint = build_checkpoint(rows, plan, 'Earlier sources read.', [])
    assert project_checkpoint(rows, checkpoint)[-1] == rows[-1]


def test_reload_hash_mismatch_and_iterative_checkpoint():
    rows = transcript()
    first = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    cp = build_checkpoint(rows, first, 'Earlier sources read.', [])
    assert project_checkpoint(deepcopy(rows), deepcopy(cp)) == project_checkpoint(rows, cp)
    changed = deepcopy(rows); changed[2].tool_calls[0].arguments['i'] = 999
    with pytest.raises(ContextPressureError, match='prefix'):
        project_checkpoint(changed, cp)
    extended = deepcopy(rows)
    for m in transcript(8)[2:]:
        for call in m.tool_calls: call.id = 'new-' + call.id
        if m.tool_call_id: m.tool_call_id = 'new-' + m.tool_call_id
        extended.append(m)
    plan = plan_context(extended, [], context_window=4096, max_output_tokens=1024, checkpoint=cp)
    assert plan.cut > cp['prefix_length']
    assert any('Earlier sources read.' in m.content for m in plan.source)


def test_rejects_empty_nonshrinking_and_nonfitting_summary():
    rows = transcript()
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    for summary in (' ', 'x' * 50000):
        with pytest.raises(ContextPressureError): build_checkpoint(rows, plan, summary, [])


def test_protected_correction_overflow_and_bad_pairs_fail_truthfully():
    rows = transcript() + [M(role='user', content='x' * 20000)]
    with pytest.raises(ContextPressureError, match='protected'):
        plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    with pytest.raises(ContextPressureError):
        plan_context([M(role='tool', tool_call_id='unknown', name='read')], [], context_window=4096, max_output_tokens=1024)


def test_checkpoint_unknown_window_is_used_and_plan_detects_changed_source():
    rows = transcript()
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    cp = build_checkpoint(rows, plan, 'Earlier sources read.', [])
    unknown = plan_context(rows, [], context_window=None, max_output_tokens=1024, checkpoint=cp)
    assert unknown.cut is None and unknown.input_limit == 0
    assert unknown.messages == project_checkpoint(rows, cp)
    rows[2].content = 'Changed while summarizing'
    with pytest.raises(ContextPressureError): build_checkpoint(rows, plan, 'Earlier sources read.', [])


def test_output_reservation_changes_fit_and_schemas_count_in_estimate():
    rows = transcript(1, 100)
    tool = ToolDefinition(name='read', description='d' * 800, input_schema={'type': 'object'})
    bare = plan_context(rows, [], context_window=None, max_output_tokens=100)
    with_tool = plan_context(rows, [tool], context_window=None, max_output_tokens=100)
    assert with_tool.before_tokens > bare.before_tokens + 190
    with pytest.raises(ContextPressureError):
        plan_context(rows, [], context_window=1000, max_output_tokens=999)


def test_checkpoint_does_not_share_nested_mutable_messages():
    rows = transcript()
    plan = plan_context(rows, [], context_window=4096, max_output_tokens=1024)
    cp = build_checkpoint(rows, plan, 'Earlier sources read.', [])
    projected = project_checkpoint(rows, cp)
    projected[-2].tool_calls[0].arguments['i'] = -1
    assert rows[-2].tool_calls[0].arguments['i'] == 7
    plan.source[0].content = 'mutated copy'
    assert rows[2].content == ''


def test_malformed_checkpoint_is_a_typed_pressure_error():
    for cp in ({'version': 1, 'prefix_length': True}, [], {'version': 1, 'prefix_length': 4, 'summary': ''}):
        with pytest.raises(ContextPressureError): project_checkpoint(transcript(), cp)


def test_unresolved_parallel_call_cannot_be_crossed_by_correction():
    rows = transcript(1)
    rows[2].tool_calls.append(ToolCall(id='unanswered', name='read'))
    rows.append(M(role='user', content='Correction before missing tool response'))
    with pytest.raises(ContextPressureError, match='unresolved'):
        plan_context(rows, [], context_window=4096, max_output_tokens=1024)


def test_forced_compaction_reduces_history_below_normal_trigger():
    from homun.models.native_turn import NativeMessage, ToolCall
    messages=[NativeMessage(role='system',content='Instructions'),NativeMessage(role='user',content='Objective')]
    for i in range(5):
        messages.append(NativeMessage(role='assistant',tool_calls=[ToolCall(id=str(i),name='read',arguments={})]))
        messages.append(NativeMessage(role='tool',tool_call_id=str(i),name='read',content='older result '*180))
    normal=plan_context(messages,[],context_window=16384,max_output_tokens=2048)
    assert normal.cut is None
    forced=plan_context(messages,[],context_window=16384,max_output_tokens=2048,force=True)
    assert forced.cut is not None
    assert build_checkpoint(messages,forced,'Historical results reviewed.',[])['estimated_after']<forced.before_tokens*.95


def test_forced_compaction_refuses_unknown_capacity_or_no_safe_prefix():
    from homun.models.native_turn import NativeMessage
    messages=[NativeMessage(role='system',content='Instructions'),NativeMessage(role='user',content='Objective')]
    for window in (None,16384):
        with pytest.raises(ContextPressureError):
            plan_context(messages,[],context_window=window,max_output_tokens=2048,force=True)
