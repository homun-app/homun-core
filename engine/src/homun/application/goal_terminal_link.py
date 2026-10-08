"""Pure goal-cycle binding checks shared by staging, approval and receipts."""
from copy import deepcopy
from homun.application.goal_manager import GoalManager
from homun.domain.errors import ConflictError
from homun.execution.contracts import digest

WAIT_REASON = 'goal_gate_pending'

def available(run):
    from homun.application.agent_tool_registry import registry_for
    return bool(run.get('terminal')) and any(
        tool['name'] == 'terminal_execute' for tool in registry_for(run).manifest())


def configuration(run, state):
    return digest([state.to_dict(), run.get('_automation_revision', 0), run.get('terminal')])


def _cycle(run, goal):
    config = configuration(run, goal.state)
    prior = run.get('_goal_gate_cycle')
    if (prior and prior['epoch'] == run['_epoch'] and prior['turn'] == run['turns']
            and prior['configuration'] == config):
        return deepcopy(prior)
    return {'id':digest([run['id'], run['_epoch'], run['turns'], config]),
            'epoch':run['_epoch'], 'turn':run['turns'], 'configuration':config, 'receipts':[]}


def passed(receipt):
    return (receipt.get('status') == 'exited' and receipt.get('exit_code') == 0
            and not receipt.get('timed_out') and not receipt.get('oom_killed')
            and not receipt.get('error_code') and receipt.get('logs') is not None)


def validate_link(ctx, store, actor, proposal, *, staging=False):
    from homun.application.agent_runs import lookup, authority
    from homun.application.agent_terminal_request import proposal_body
    link = proposal['_agent_binding']
    run = lookup(store, link['run_id'], proposal['work_id'])
    authority(ctx, store, actor, run, running=True)
    goal = GoalManager(run['work_id'], persist=False)
    cycle = link['cycle']
    expected_status = 'running' if staging else 'waiting_automation'
    if (run['status'] != expected_status or run['_epoch'] != link['epoch'] or run.get('_steering')
            or not goal.is_active() or configuration(run, goal.state) != cycle['configuration']
            or run['turns'] != cycle['turn'] or not available(run)):
        raise ConflictError('Goal gate has been paused, changed or superseded')
    if staging:
        if run.get('_lease_token') != link['lease_token'] or _cycle(run, goal) != cycle:
            raise ConflictError('Goal gate lease or cycle changed')
    elif run.get('goal_terminal_request_id') != proposal['id'] or run.get('_goal_gate_cycle') != cycle:
        raise ConflictError('Goal terminal request is no longer awaited')
    index = link['index']
    if index != len(cycle['receipts']) or not 0 <= index < len(goal.state.gates):
        raise ConflictError('Goal gate index differs from the approved cycle')
    gate = goal.state.gates[index]
    expected, _ = proposal_body(run, {'command':gate.command, 'timeout_seconds':gate.timeout_seconds}, proposal['id'])
    if (any(proposal.get(k) != value for k, value in expected.items() if k != 'command_id')
            or any(proposal.get(k) for k in ('background','stdin','pty'))):
        raise ConflictError('Terminal proposal differs from the goal gate')
    return run


def bind_wait(run, proposal):
    run['_goal_gate_cycle'] = deepcopy(proposal['_agent_binding']['cycle'])
    run.update(status='waiting_automation', goal_terminal_request_id=proposal['id'],
               automation_wait={'reason':WAIT_REASON})

