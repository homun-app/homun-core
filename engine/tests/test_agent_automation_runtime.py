"""Canonical advance, durable idle wake and goal judging integration."""
import json
from types import SimpleNamespace
import pytest
from test_agent_runs import setup
from homun.application.agent_runs import propose, approve
from homun.application.agent_run_execution import advance
from homun.application.goal_manager import GoalManager
from homun.application.goal_store import GoalStore, set_goal_store
from homun.application.automation_store import AutomationStore, set_automation_store
from homun.application.loop_manager import LoopManager
from homun.application.heartbeat_manager import HeartbeatManager
from homun.models.native_turn import NativeMessage


@pytest.fixture(autouse=True)
def stores(tmp_path):
    set_goal_store(GoalStore(tmp_path / 'goals.db'))
    set_automation_store(AutomationStore(tmp_path / 'automation.db'))
    yield
    set_goal_store(None)
    set_automation_store(None)


def start(setup):
    ctx, actor, work, material = setup
    ctx.models.set_active('openai_compatible')
    p = propose(ctx, actor, work, {'command_id':'run', 'expected_version':1,
        'material_ids':[material], 'goals':True})
    approve(ctx, actor, work, p['id'], {'command_id':'approve', 'digest':p['digest'],
        'expected_version':p['expected_version']})
    ctx.models.complete_tools = lambda *a, **k: SimpleNamespace(
        message=NativeMessage(role='assistant', content='Result with evidence'), usage=None)
    return ctx, actor, work, p


def test_goal_finish_judges_continues_then_publishes_once(setup):
    ctx, actor, work, p = start(setup)
    GoalManager(work).set('Check outcome', max_turns=3)
    verdicts = iter(['continue', 'done'])
    calls = []
    def judge(messages, **kwargs):
        calls.append((messages, kwargs))
        return SimpleNamespace(text=json.dumps({'verdict':next(verdicts), 'reason':'checked'}), usage=None)
    ctx.models.complete = judge
    assert advance(ctx, p['id']) == 'running'
    assert not ctx.repository.load().artifacts
    assert advance(ctx, p['id']) == 'completed'
    assert len(ctx.repository.load().artifacts) == 1
    assert GoalManager(work).state.status == 'done'
    assert len(calls) == 2
    assert all(call[1]['connection_id'] == p['connection_id'] for call in calls)
    assert ctx.repository.load().commands[p['id']].result['model_attempts'] == 4


def test_goal_blocked_does_not_publish_success(setup):
    ctx, actor, work, p = start(setup)
    GoalManager(work).set('Check outcome')
    ctx.models.complete = lambda *a, **k: SimpleNamespace(text=json.dumps({'verdict':'blocked','reason':'missing evidence'}), usage=None)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert not ctx.repository.load().artifacts
    assert GoalManager(work).state.status == 'paused'
    from homun.application.agent_automation import wake_due_automation
    assert wake_due_automation(ctx, now=10**12) == []


def test_loop_wakes_idle_run_once_after_store_reopen(setup, tmp_path):
    ctx, actor, work, p = start(setup)
    state = LoopManager(work, min_interval=1).set('Check again', interval_seconds=1, times=1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert ctx.repository.load().works[work].status == 'running'
    assert not ctx.repository.load().artifacts
    set_automation_store(AutomationStore(tmp_path / 'automation.db'))
    from homun.application.agent_automation import wake_due_automation
    assert wake_due_automation(ctx, now=state.next_due_at + 1) == [p['id']]
    assert wake_due_automation(ctx, now=state.next_due_at + 1) == []
    run = ctx.repository.load().commands[p['id']].result
    assert run['_epoch'] == 1
    assert advance(ctx, p['id'], epoch=0) == 'superseded'
    assert advance(ctx, p['id'], epoch=1) == 'completed'
    assert LoopManager(work).state.ticks_fired == 1
    assert len(ctx.repository.load().artifacts) == 1
    assert wake_due_automation(ctx, now=10**12) == []


def test_heartbeat_respects_human_pause(setup):
    from homun.application.agent_control import control
    ctx, actor, work, p = start(setup)
    state = HeartbeatManager(work, min_seconds=1).set('Watch', 1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    control(ctx, actor, work, p['id'], {'command_id':'pause','action':'pause',
        'expected_version':ctx.repository.load().works[work].version})
    from homun.application.agent_automation import wake_due_automation
    assert wake_due_automation(ctx, now=state.created_at + 100) == []
    assert HeartbeatManager(work).state.fire_count == 0


def test_wake_crash_before_engine_commit_recovers_after_restart(setup, tmp_path, monkeypatch):
    from homun.application import automation_wakes
    from homun.application.agent_automation import wake_due_automation
    from homun.context import create_context
    ctx, actor, work, p = start(setup)
    state = HeartbeatManager(work, min_seconds=1).set('Watch', 1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    original = automation_wakes.prepare
    def crash(*a, **kw):
        original(*a, **kw)
        raise SystemExit('crash after durable wake before engine commit')
    monkeypatch.setattr(automation_wakes, 'prepare', crash)
    with pytest.raises(SystemExit):
        wake_due_automation(ctx, now=state.created_at + 10)
    assert ctx.repository.load().commands[p['id']].result['status'] == 'waiting_automation'
    assert HeartbeatManager(work).state.fire_count == 1
    monkeypatch.setattr(automation_wakes, 'prepare', original)
    reopened = create_context(db_path=ctx.data_dir/'ws.db', data_dir=ctx.data_dir, for_tests=True)
    try:
        assert wake_due_automation(reopened, now=state.created_at + 10) == [p['id']]
        assert wake_due_automation(reopened, now=state.created_at + 10) == []
        assert HeartbeatManager(work).state.fire_count == 1
        assert len(reopened.repository.load().commands[p['id']].result['_steering']) == 1
    finally:
        reopened.close()


def test_goal_evaluation_receipt_survives_projection_crash(setup, monkeypatch):
    from homun.application import agent_automation
    ctx, actor, work, p = start(setup)
    GoalManager(work).set('Verify')
    calls = []
    def judge(*a, **kw):
        calls.append(True)
        return SimpleNamespace(text='{"verdict":"done","reason":"verified"}', usage=None)
    ctx.models.complete = judge
    project = agent_automation._project
    monkeypatch.setattr(agent_automation, '_project', lambda *a: (_ for _ in ()).throw(SystemExit('crash')))
    with pytest.raises(SystemExit):
        advance(ctx, p['id'])
    monkeypatch.setattr(agent_automation, '_project', project)
    with ctx.repository.transaction() as store:
        store.commands[p['id']].result['_lease_until'] = '2000-01-01T00:00:00+00:00'
    assert advance(ctx, p['id']) == 'completed'
    assert len(calls) == 1
    assert GoalManager(work).state.turns_used == 1


def test_loop_budget_pause_is_not_artifact_success(setup):
    from homun.application.agent_automation import wake_due_automation
    ctx, actor, work, p = start(setup)
    state = LoopManager(work, min_interval=1).set('Check', interval_seconds=1, max_ticks=1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert wake_due_automation(ctx, now=state.next_due_at + 1) == [p['id']]
    assert advance(ctx, p['id'], epoch=1) == 'waiting_automation'
    assert LoopManager(work).state.status == 'paused'
    assert not ctx.repository.load().artifacts


def test_goal_barrier_wakes_when_time_elapses(setup):
    from homun.application.agent_automation import wake_due_automation
    ctx, actor, work, p = start(setup)
    manager = GoalManager(work)
    manager.set('Wait for evidence')
    state = manager.wait_for_seconds(120)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert wake_due_automation(ctx, now=state.waiting_until - 1) == []
    assert wake_due_automation(ctx, now=state.waiting_until + 1) == [p['id']]
    assert GoalManager(work).state.turns_used == 0


def test_new_goal_state_during_judge_wins_over_old_done(setup):
    ctx, actor, work, p = start(setup)
    GoalManager(work).set('Verify')
    def judge(*a, **kw):
        GoalManager(work).pause('human changed goal')
        return SimpleNamespace(text='{"verdict":"done","reason":"old result"}', usage=None)
    ctx.models.complete = judge
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert GoalManager(work).state.paused_reason == 'human changed goal'
    assert not ctx.repository.load().artifacts


def test_legacy_heartbeat_migrates_to_work_without_overwriting_existing(setup):
    ctx, actor, work, p = start(setup)
    HeartbeatManager(p['id'], min_seconds=1).set('Legacy watch', 1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert HeartbeatManager(work).state.prompt == 'Legacy watch'
    from homun.application.agent_automation import wake_due_automation
    assert wake_due_automation(ctx, now=10**12) == [p['id']]
    assert HeartbeatManager(work).state.fire_count == 1


def test_human_steer_wakes_idle_without_consuming_heartbeat(setup):
    from homun.application.agent_control import control
    ctx, actor, work, p = start(setup)
    HeartbeatManager(work, min_seconds=1).set('Watch', 1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    control(ctx, actor, work, p['id'], {'command_id':'steer','action':'steer','text':'Human priority',
        'expected_version':ctx.repository.load().works[work].version})
    from homun.application.agent_automation import wake_due_automation
    assert wake_due_automation(ctx, now=10**12) == []
    run = ctx.repository.load().commands[p['id']].result
    assert run['status'] == 'queued'
    assert run['_steering'][0]['text'] == 'Human priority'
    assert HeartbeatManager(work).state.fire_count == 0


def test_cleared_automation_wakes_once_to_finalize_approved_work(setup):
    from homun.application.agent_automation import wake_due_automation
    ctx, actor, work, p = start(setup)
    HeartbeatManager(work, min_seconds=1).set('Watch', 1)
    assert advance(ctx, p['id']) == 'waiting_automation'
    HeartbeatManager(work).clear()
    assert wake_due_automation(ctx) == [p['id']]
    assert advance(ctx, p['id'], epoch=1) == 'completed'
    assert len(ctx.repository.load().artifacts) == 1


def test_unknown_session_barrier_does_not_nest_repository_transactions(setup):
    from homun.application.agent_automation import wake_due_automation
    ctx, actor, work, p = start(setup)
    goal = GoalManager(work)
    goal.set('Check')
    goal.wait_on_session('other-session')
    assert advance(ctx, p['id']) == 'waiting_automation'
    assert wake_due_automation(ctx) == []


def test_human_steering_invalidates_finish_judge_before_projection(setup, monkeypatch):
    from homun.application import agent_automation
    from homun.application.agent_control import control
    ctx, actor, work, p = start(setup)
    GoalManager(work).set('Check')
    calls = []
    ctx.models.complete = lambda *a, **k: (calls.append(1) or SimpleNamespace(text='{"verdict":"done","reason":"verified"}', usage=None))
    evaluate = agent_automation.evaluate_finish
    def steer_after_evaluation(*args):
        result = evaluate(*args)
        control(ctx, actor, work, p['id'], {'command_id':'correction','action':'steer','text':'Use corrected evidence',
            'expected_version':ctx.repository.load().works[work].version})
        return result
    monkeypatch.setattr(agent_automation,'evaluate_finish',steer_after_evaluation)
    assert advance(ctx, p['id']) == 'running'
    assert not ctx.repository.load().artifacts
    assert GoalManager(work).state.status == 'active'
    monkeypatch.setattr(agent_automation,'evaluate_finish',evaluate)
    assert advance(ctx, p['id']) == 'completed'
    assert len(calls) == 2


def test_paused_heartbeat_keeps_work_incomplete(setup):
    ctx, actor, work, p = start(setup)
    heartbeat = HeartbeatManager(work)
    heartbeat.set('Watch',60)
    heartbeat.pause()
    assert advance(ctx,p['id']) == 'waiting_automation'
    assert not ctx.repository.load().artifacts
