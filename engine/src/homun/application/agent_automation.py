"""Canonical finish decisions and idle wakes for approved adaptive work."""
from copy import deepcopy
import time

from homun.application import agent_native, automation_wakes
from homun.application.delegation_runtime import live_count
from homun.application.automation_store import get_automation_store
from homun.application.goal_manager import GoalManager
from homun.application.heartbeat_manager import HeartbeatManager
from homun.application.loop_manager import LoopManager
from homun.domain.models import Actor
from homun.domain.errors import DomainError


def _session_waiting(ctx, session_id, snapshot=None):
    snapshot = ctx.repository.load() if snapshot is None else snapshot
    candidates = [r.result for r in snapshot.commands.values()
                  if r.type == 'agent_run.propose' and isinstance(r.result, dict)
                  and (r.result.get('id') == session_id or r.result.get('work_id') == session_id)]
    # Unknown sessions cannot be silently treated as completed.
    return not candidates or any(r.get('status') not in {'completed', 'failed', 'cancelled', 'blocked'} for r in candidates)


from homun.application.automation_projection import _project


def evaluate_finish(ctx, run, response):
    """Judge outside engine transactions; journal before cross-store projection."""
    from homun.application.agent_runs import lookup, authority
    from homun.application.goal_judge import judge
    key = f'{run["_epoch"]}:{run["turns"]}'
    prior = run.get('_automation_finish')
    if prior and prior['key'] == key:
        return prior
    automation_wakes.migrate_legacy(run)
    goal = GoalManager(run['work_id'], persist=False)
    loop = LoopManager(run['work_id'])
    heartbeat = HeartbeatManager(run['work_id'])
    if not goal.has_goal() and not loop.has_loop() and not heartbeat.has_heartbeat():
        return None
    evaluation = {'key':key, 'action':'finish', 'reason':'automation_complete'}
    if goal.has_goal():
        evaluation['goal_before'] = goal.state.to_dict()
        from homun.application.goal_terminal import runner, available, GatePending
        # Always inject a receipt adapter: a changing wait barrier must never
        # fall through to the legacy standalone manager's shell runner.
        gate_runner = runner(ctx, run, goal)
        if goal.is_active() and goal.state.gates and not available(run):
            goal.pause('goal_gate_terminal_unavailable')
        try:
            outcome = goal.evaluate_after_turn(response,
                judge_fn=lambda **inputs: judge(ctx, run, **inputs),
                active_delegations=live_count(ctx, run), gate_runner=gate_runner,
                session_waiting_check=lambda sid: _session_waiting(ctx, sid))
        except GatePending:
            return {'action':'wait', 'reason':'goal_gate_pending'}
        if goal.state.paused_reason == 'goal_gate_terminal_unavailable':
            outcome['reason'] = 'goal_gate_terminal_unavailable'
        evaluation['goal_after'] = goal.state.to_dict()
        evaluation['reason'] = outcome.get('reason') or outcome.get('verdict') or 'goal'
        if outcome.get('should_continue'):
            evaluation.update(action='continue', prompt=outcome['continuation_prompt'])
        elif outcome.get('status') in {'active', 'paused'}:
            evaluation['action'] = 'wait'
    if loop.state and loop.state.awaiting_response:
        evaluation['loop_before'] = loop.state.to_dict()
        transient = object.__new__(automation_wakes.TransientLoopManager)
        transient.session_id, transient._state = loop.session_id, deepcopy(loop.state)
        def until_judge(until, answer):
            verdict = judge(ctx, run, goal=until, last_response=answer)
            return verdict[0], verdict[1]
        transient.complete_tick(response, until_judge=until_judge)
        evaluation['loop_after'] = transient.state.to_dict()
        loop._state = transient.state
    if loop.state and loop.state.status == 'paused' and evaluation['action'] == 'finish':
        evaluation.update(action='wait', reason=loop.state.paused_reason or 'loop_paused')
    if evaluation['action'] == 'finish' and (loop.is_active() or heartbeat.has_heartbeat()):
        evaluation.update(action='wait', reason='scheduled_automation')
    actor = Actor.model_validate(run['_actor'])
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            if current.get('_lease_token') != run.get('_lease_token') or current.get('_steering'):
                return None
            authority(ctx, store, actor, current, running=True)
            current['_automation_finish'] = evaluation
        ctx.service.store = store
    return evaluation


def apply_finish(service, actor, work, current, evaluation, response):
    """Return True when automation consumed this finish without final artifact."""
    if not evaluation or evaluation['action'] == 'finish':
        return False
    if evaluation['action'] == 'continue':
        current.setdefault('_steering', []).append({'text':evaluation['prompt'], 'source':'goal',
            'command_id':f'{current["id"]}:goal:{current["_epoch"]}:{current["turns"]}', 'actor_id':actor.id})
        current['status'] = 'running'
    else:
        current.update(status='waiting_automation', automation_wait={'reason':evaluation['reason']})
    service.append_engine_message(actor=actor,
        command_id=f'{current["id"]}:cycle:{current["_epoch"]}:{current["turns"]}',
        conversation_id=work.primary_conversation_id, author_id='homun_engine', text=response,
        event_payload={'work_id':work.id, 'agent_run_id':current['id'], 'status':current['status'],
                       'automation_reason':evaluation['reason']})
    return True


def wake_due_automation(ctx, *, now=None, limit=20):
    """Queue durable epochs; normal deliver_agent_runs owns DBOS dispatch."""
    from homun.application.agent_runs import PROPOSAL_TYPE, lookup, authority
    from homun.application.agent_run_fencing import _fence
    now = time.time() if now is None else float(now)
    woke = []
    for record in ctx.repository.load().commands.values():
        if len(woke) >= limit:
            break
        if record.type != PROPOSAL_TYPE or record.result.get('status') != 'waiting_automation':
            continue
        if record.result.get('automation_wait', {}).get('reason', '') == 'goal_gate_pending':
            continue  # Canonical terminal reconciliation owns this wait.
        if record.result.get('automation_wait', {}).get('reason', '').startswith('delegation_'):
            continue  # The child supervisor alone admits results and wakes this parent.
        wake = None
        with ctx.repository.locked():
            with ctx.repository.transaction() as store:
                run = lookup(store, record.result['id'])
                if run['status'] != 'waiting_automation' or run.get('_steering') or agent_native.pending(run):
                    continue
                actor = Actor.model_validate(run['_actor'])
                try:
                    work, _ = authority(ctx, store, actor, run, running=True)
                except DomainError as exc:
                    run['automation_wait'] = {'reason':exc.code}
                    continue
                if any(c.work_id == work.id and c.status == 'pending' for c in store.contributions.values()):
                    continue
                if run['turns'] >= run['limits']['max_turns'] or run['model_attempts'] >= run['limits']['max_model_attempts']:
                    run['automation_wait'] = {'reason':'agent_automation_budget_exhausted'}
                    continue
                goal = GoalManager(work.id, persist=False)
                if goal.state and goal.state.status == 'paused':
                    continue
                if goal.is_active():
                    if goal.is_waiting(now=now,
                            live_delegations=live_count(ctx, run, store),
                            session_waiting_check=lambda sid: _session_waiting(ctx, sid, store)):
                        continue
                    wake = {'wake_id':f'goal:{run["id"]}:{run["_epoch"]}:{run["turns"]}',
                            'source':'goal', 'text':goal.next_continuation_prompt()}
                else:
                    wake = automation_wakes.prepare(work.id, now=now)
                if not wake:
                    loop, heartbeat = LoopManager(work.id), HeartbeatManager(work.id)
                    if goal.has_goal() or loop.has_loop() or heartbeat.has_heartbeat():
                        continue
                    wake = {'wake_id':f'finalize:{run["id"]}:{run["_epoch"]}:{run["turns"]}',
                            'source':'finalize', 'text':'The automation has stopped. Finalize the approved work using the collected evidence.'}
                received = run.setdefault('_automation_wake_ids', [])
                if wake['wake_id'] not in received:
                    received.append(wake['wake_id'])
                    run.setdefault('_steering', []).append({'text':wake['text'], 'source':wake['source'],
                        'command_id':wake['wake_id'], 'actor_id':actor.id})
                    run.pop('automation_wait', None)
                    run['status'] = 'queued'
                    _fence(run, actor)
                    woke.append(run['id'])
            ctx.service.store = store
        if wake and wake['source'] in {'loop', 'heartbeat'}:
            automation_wakes.acknowledge(wake['wake_id'])
    return woke
