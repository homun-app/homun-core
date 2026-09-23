"""DBOS owns synthesis recovery; command IDs give stable workflow identity."""
from dbos import DBOS, SetWorkflowID
from homun.application.synthesis_execution import execute, fail

_context = None


def bind_context(ctx):
    global _context
    _context = ctx


@DBOS.step(retries_allowed=True, max_attempts=3, interval_seconds=0.2)
def compose_and_publish(proposal_id: str):
    if _context is None:
        raise RuntimeError('Synthesis runtime context unavailable')
    execute(_context, proposal_id)


@DBOS.workflow()
def synthesis_workflow(proposal_id: str):
    try:
        compose_and_publish(proposal_id)
    except Exception:
        fail(_context, proposal_id, 'synthesis_execution_failed')


def start(workflow_id, proposal_id):
    with SetWorkflowID(workflow_id):
        DBOS.retrieve_queue('homun-work').enqueue(synthesis_workflow, proposal_id)


def deliver_syntheses(ctx):
    from homun.application.synthesis import PROPOSAL_TYPE
    for record in ctx.repository.load().commands.values():
        if record.type != PROPOSAL_TYPE or record.result['status'] not in {'queued', 'running'}:
            continue
        try:
            start(record.result['_workflow_id'], record.result['id'])
        except Exception:
            # The persisted approved command remains the dispatch intent. The
            # pump retries; DBOS deduplicates the stable workflow ID.
            continue
