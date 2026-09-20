"""DBOS owns chain recovery; steps reuse the per-tool executions unchanged."""
from dbos import DBOS, SetWorkflowID

from homun.application.price_comparison_execution import execute as compare_execute
from homun.application.material_read_execution import execute as read_execute

_context = None


def bind_context(ctx):
    global _context
    _context = ctx


def run_chain_step_direct(ctx, capability: str, proposal_id: str):
    """Same step execution without DBOS registration (tests and direct drives)."""
    execute = read_execute if capability == 'read_material' else compare_execute
    execute(ctx, proposal_id)


@DBOS.step(retries_allowed=False)
def run_chain_step(capability: str, proposal_id: str):
    if _context is None:
        raise RuntimeError('Tool chain runtime context unavailable')
    run_chain_step_direct(_context, capability, proposal_id)


@DBOS.workflow()
def tool_chain_workflow(steps: list):
    """Sequential execution under DBOS; run_chain drives the same core in tests."""
    if _context is None:
        raise RuntimeError('Tool chain runtime context unavailable')
    _run_core(_context, steps, _dbos_step_runner)


def _dbos_step_runner(ctx, capability, proposal_id):
    run_chain_step(capability, proposal_id)


def run_chain(ctx, steps):
    """Drive a chain without DBOS (tests); same semantics as the workflow core."""
    global _context
    _context = ctx
    _run_core(ctx, steps, run_chain_step_direct)


def _run_core(ctx, steps, runner):
    for step in steps:
        record = ctx.repository.load().commands.get(step['proposal_id'])
        if record is None or record.type not in ('material_read.propose', 'price_comparison.propose'):
            continue
        if record.result['status'] in {'completed', 'blocked'}:
            continue
        if record.result['status'] == 'failed':
            _block_remaining(ctx, steps, step['proposal_id'])
            return
        try:
            runner(ctx, step['capability'], step['proposal_id'])
        except Exception:
            _block_remaining(ctx, steps, step['proposal_id'])
            return
        outcome = ctx.repository.load().commands.get(step['proposal_id'])
        if outcome is None or outcome.result['status'] != 'completed':
            _block_remaining(ctx, steps, step['proposal_id'])
            return
        if not _continue_if_more_steps(ctx, steps, step):
            return
    _mark_chain(ctx, steps, 'completed')


def _continue_if_more_steps(ctx, steps, finished_step):
    """Mechanical continuation between chain steps.

    Each tool completion moves the work to REVIEW (single-tool semantics).
    The person's chain approval already enumerated every effect, so the chain
    moves the work back through READY→RUNNING to run the next step — recorded
    as events, without touching versions the steps are bound to. The last step
    leaves the work in REVIEW for the human.
    """
    remaining = [s for s in steps
                 if ctx.repository.load().commands.get(s['proposal_id']) is not None
                 and ctx.repository.load().commands[s['proposal_id']].result['status']
                 in {'queued', 'running', 'pending_approval'}]
    if not remaining:
        return True
    from homun.domain.ids import new_id
    from homun.domain.models import DomainEvent, utc_now
    from homun.domain.states import WorkStatus
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            chain_record = store.commands.get(_chain_id_of(steps))
            work = store.works[chain_record.result['work_id']]
            transitions = []
            if work.status == WorkStatus.REVIEW:
                work.status = WorkStatus.READY
                transitions.append(WorkStatus.READY)
            if work.status == WorkStatus.READY:
                work.status = WorkStatus.RUNNING
                transitions.append(WorkStatus.RUNNING)
            if transitions:
                work.updated_at = utc_now()
                # Each submit bumped the work version: rebind the remaining
                # steps to the current one. The chain approval authorized the
                # whole enumeration; sources keep their identity checks.
                for remaining_step in remaining:
                    record = store.commands.get(remaining_step['proposal_id'])
                    if record is not None and record.result['status'] in {'queued', 'running', 'pending_approval'}:
                        record.result['_run_version'] = work.version
                        record.result['expected_version'] = work.version
                for status in transitions:
                    store.events.append(DomainEvent(
                        event_id=new_id('evt'),
                        workspace_id=store.workspace_id, aggregate_id=work.id,
                        aggregate_type='work', aggregate_version=work.version,
                        sequence=store.next_sequence(), type='work.chain_continued',
                        actor_id='homun_engine', command_id=chain_record.result['id'],
                        payload={'status': status, 'chain_id': chain_record.result['id']}))
        ctx.service.store = store
    return True


def _block_remaining(ctx, steps, failed_id):
    """A failed step keeps completed artifacts and blocks the rest of the chain."""
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            chain_id = next((s['proposal_id'] for s in steps if s['proposal_id'] == failed_id), None)
            for step in steps:
                record = store.commands.get(step['proposal_id'])
                if record is None:
                    continue
                if record.result['status'] in {'pending_approval', 'queued', 'running'}:
                    record.result.update(status='blocked', error_code='chain_step_failed')
            chain_record = store.commands.get(_chain_id_of(steps))
            if chain_record and chain_record.result['status'] in {'queued', 'running'}:
                chain_record.result.update(status='failed', error_code='chain_step_failed')
        ctx.service.store = store


def _chain_id_of(steps):
    return steps[0]['proposal_id'].rsplit(':', 1)[0] if steps else ''


def _mark_chain(ctx, steps, status):
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            chain_record = store.commands.get(_chain_id_of(steps))
            if chain_record and chain_record.result['status'] in {'queued', 'running'}:
                chain_record.result.update(status=status)
                chain_record.result.pop('error_code', None)
        ctx.service.store = store


def start(workflow_id, steps):
    with SetWorkflowID(workflow_id):
        DBOS.retrieve_queue('homun-work').enqueue(tool_chain_workflow, steps)


def deliver_chains(ctx):
    from homun.application.tool_chains import PROPOSAL_TYPE
    for record in ctx.repository.load().commands.values():
        if record.type != PROPOSAL_TYPE or record.result['status'] not in {'queued', 'running'}:
            continue
        chain = record.result
        try:
            start(chain['_workflow_id'], chain['steps'])
        except Exception:
            # The approved command remains the dispatch intent; the pump retries
            # and DBOS deduplicates the stable workflow id.
            continue
