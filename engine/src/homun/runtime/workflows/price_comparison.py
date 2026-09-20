"""DBOS owns comparison recovery; command IDs give stable workflow identity."""
from dbos import DBOS, SetWorkflowID
from homun.application.price_comparison_execution import execute, fail

_context = None


def bind_context(ctx):
    global _context
    _context = ctx


@DBOS.step(retries_allowed=True, max_attempts=3, interval_seconds=0.2)
def compare_and_publish(proposal_id: str):
    if _context is None:
        raise RuntimeError('Comparison runtime context unavailable')
    execute(_context, proposal_id)


@DBOS.workflow()
def price_comparison_workflow(proposal_id: str):
    try:
        compare_and_publish(proposal_id)
    except Exception:
        fail(_context, proposal_id, 'comparison_execution_failed')


def start(workflow_id, proposal_id):
    with SetWorkflowID(workflow_id):
        DBOS.retrieve_queue('homun-work').enqueue(price_comparison_workflow, proposal_id)


def deliver_comparisons(ctx):
    from homun.application.price_comparison_policy import PROPOSAL_TYPE
    for record in ctx.repository.load().commands.values():
        if record.type != PROPOSAL_TYPE or record.result['status'] not in {'queued', 'running'}:
            continue
        proposal = record.result
        try:
            start(proposal['_workflow_id'], proposal['id'])
        except Exception:
            # The persisted approved command remains the dispatch intent. The
            # existing pump retries; DBOS deduplicates the stable workflow ID.
            continue
