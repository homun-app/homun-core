"""Approved terminal receipts for one fenced goal finish cycle; no shell runner."""
from copy import deepcopy
from homun.application import terminal_jobs
from homun.domain.models import Actor
from homun.execution.contracts import digest

from homun.application.goal_terminal_link import available, _cycle, passed, validate_link, configuration


class GatePending(Exception):
    """The finish decision is durably parked for a terminal approval/receipt."""


def runner(ctx, run, goal):
    """Lazy adapter: wait barriers are evaluated once by GoalManager itself."""
    snapshot = deepcopy(goal)
    prepared = None
    def evaluate(gate):
        nonlocal prepared
        if prepared is None:
            prepared = prepare(ctx, run, snapshot)
            if prepared is None:
                raise GatePending()
        return prepared(gate)
    return evaluate


def prepare(ctx, run, goal):
    """Return a receipt runner, or atomically stage the next command and wait."""
    from homun.application.agent_terminal_request import proposal_body
    cycle = _cycle(run, goal)
    receipts = cycle['receipts']
    if len(receipts) < len(goal.state.gates) and all(passed(r) for r in receipts):
        index = len(receipts)
        gate = goal.state.gates[index]
        proposal_id = 'goal-gate:' + digest([cycle['id'], index])
        body, ssh_key = proposal_body(run, {'command':gate.command, 'timeout_seconds':gate.timeout_seconds}, proposal_id)
        terminal_jobs.propose(ctx, Actor.model_validate(run['_actor']), run['work_id'], body,
            agent_binding={'kind':'goal_gate', 'run_id':run['id'], 'epoch':run['_epoch'],
                'call_id':proposal_id, 'lease_token':run['_lease_token'], 'cycle':cycle, 'index':index},
            ssh_key_path=ssh_key)
        return None
    results = iter(receipts)
    def receipt_runner(gate):
        receipt = next(results)
        return passed(receipt), receipt.get('exit_code'), (receipt.get('logs') or {}).get('text', '')[-3000:]
    return receipt_runner


def _queue(run, actor):
    run['_epoch'] += 1
    run.update(status='queued', _workflow_id=f'agent:{actor.workspace_id}:{run["id"]}:{run["_epoch"]}')
    for key in ('goal_terminal_request_id','automation_wait','_active_call_id'):
        run.pop(key, None)


def _supersede_configuration(ctx, run_id):
    """A changed configuration needs a fresh approval, never a stranded wait."""
    from homun.application.agent_runs import lookup, authority
    from homun.application.goal_manager import GoalManager
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if run['status'] != 'waiting_automation' or not run.get('goal_terminal_request_id'):
                return False
            actor = Actor.model_validate(run['_actor'])
            authority(ctx, store, actor, run, running=True)
            goal = GoalManager(run['work_id'], persist=False)
            cycle = run['_goal_gate_cycle']
            if goal.state and configuration(run, goal.state) == cycle['configuration']:
                return False
            run.pop('_goal_gate_cycle', None)
            _queue(run, actor)
        ctx.service.store = store
    return True


def resume(ctx, run_id):
    """Inspect only; commit a receipt and queue the retained finish decision once."""
    from homun.application.agent_runs import lookup
    if _supersede_configuration(ctx, run_id):
        return True
    store = ctx.repository.load()
    run = lookup(store, run_id)
    proposal_id = run.get('goal_terminal_request_id')
    if run['status'] != 'waiting_automation' or not proposal_id:
        return False
    actor = Actor.model_validate(run['_actor'])
    proposal = store.commands[proposal_id].result
    validate_link(ctx, store, actor, proposal)
    if proposal['status'] == 'pending_approval':
        return False
    terminal_jobs.refresh(ctx, actor, run['work_id'], proposal_id)
    if _supersede_configuration(ctx, run_id):
        return True
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if run['status'] != 'waiting_automation' or run.get('goal_terminal_request_id') != proposal_id:
                return False
            proposal = store.commands[proposal_id].result
            validate_link(ctx, store, actor, proposal)
            if proposal['status'] not in {'exited','dead'} or proposal.get('logs') is None:
                return False
            receipt = {key:deepcopy(proposal.get(key)) for key in
                       ('status','exit_code','timed_out','oom_killed','logs','error_code')}
            receipt['job_id'] = proposal_id
            run['_goal_gate_cycle']['receipts'].append(receipt)
            run['observations'].append({'tool':'goal_gate', 'arguments':{'command':proposal['command']},
                                        'message':'Goal gate terminal receipt', 'result':receipt})
            _queue(run, actor)
            run['_goal_gate_cycle']['epoch'] = run['_epoch']
        ctx.service.store = store
    return True
