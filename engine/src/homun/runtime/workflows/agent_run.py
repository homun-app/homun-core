"""DBOS delivers adaptive turns with stable identity and journal order."""
from dbos import DBOS, SetWorkflowID
from homun.application.agent_run_execution import advance, fail
from homun.application.agent_runs import PROPOSAL_TYPE, resume_waiting
from homun.domain.errors import DomainError

_context = None


def bind_context(ctx):
    global _context
    _context = ctx


@DBOS.step(retries_allowed=True, max_attempts=3, interval_seconds=0.2)
def run_turn(run_id):
    if _context is None:
        raise RuntimeError('Adaptive runtime context unavailable')
    return advance(_context, run_id)


@DBOS.workflow()
def agent_run_workflow(run_id):
    try:
        while True:
            status = run_turn(run_id)
            if status not in {'running', 'busy'}:
                return status
            if status == 'busy':
                DBOS.sleep(5)
    except Exception:
        record_failure(run_id)
        return 'failed'


@DBOS.step()
def record_failure(run_id):
    fail(_context, run_id, 'agent_run_execution_failed')


def start(workflow_id, run_id):
    with SetWorkflowID(workflow_id):
        DBOS.retrieve_queue('homun-work').enqueue(agent_run_workflow, run_id)


def deliver_agent_runs(ctx):
    for record in ctx.repository.load().commands.values():
        if record.type != PROPOSAL_TYPE:
            continue
        run = record.result
        if run['status'] == 'waiting_input':
            try:
                resume_waiting(ctx, run['id'])
            except DomainError as exc:
                fail(ctx, run['id'], exc.code, blocked=True)
            run = ctx.repository.load().commands[run['id']].result
        if run['status'] not in {'queued', 'running'}:
            continue
        try:
            start(run['_workflow_id'], run['id'])
        except Exception:
            # The command remains an intent; stable workflow id deduplicates retry.
            continue
