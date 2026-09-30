"""DBOS delivers adaptive turns with stable identity and journal order."""
from dbos import DBOS, SetWorkflowID
import logging
from homun.application.agent_run_execution import advance, fail
from homun.application.agent_runs import PROPOSAL_TYPE, resume_waiting
from homun.domain.errors import DomainError

_context = None


def bind_context(ctx):
    global _context
    _context = ctx


@DBOS.step(retries_allowed=True, max_attempts=3, interval_seconds=0.2)
def run_turn(run_id, epoch=0):
    if _context is None:
        raise RuntimeError('Adaptive runtime context unavailable')
    return advance(_context, run_id, epoch=epoch)


def workflow_epoch(workflow_id, epoch):
    """Recover the epoch from old persisted one-argument workflow invocations."""
    if not isinstance(workflow_id,str) or not workflow_id.startswith('agent:'):
        raise ValueError('Unknown adaptive workflow identity')
    recorded=int(workflow_id.rsplit(':',1)[-1])
    if epoch is not None and epoch != recorded:
        raise ValueError('Adaptive workflow epoch does not match its identity')
    return recorded


@DBOS.workflow()
def agent_run_workflow(run_id, epoch=None):
    epoch = workflow_epoch(DBOS.workflow_id, epoch)
    try:
        while True:
            status = run_turn(run_id, epoch)
            if status not in {'running', 'busy'}:
                return status
            if status == 'busy':
                DBOS.sleep(5)
    except Exception:
        record_failure(run_id, epoch)
        return 'failed'


@DBOS.step()
def record_failure(run_id, epoch=0):
    fail(_context, run_id, 'agent_run_execution_failed', epoch=epoch)


def start(workflow_id, run_id, epoch=0):
    with SetWorkflowID(workflow_id):
        DBOS.retrieve_queue('homun-work').enqueue(agent_run_workflow, run_id, epoch)


def deliver_agent_runs(ctx):
    for record in ctx.repository.load().commands.values():
        if record.type != PROPOSAL_TYPE:
            continue
        run = record.result
        if run['status'] in {'pending_approval', 'waiting_external'}:
            from homun.application.approval_auto import sweep as auto_approve
            try:
                if auto_approve(ctx, record.command_id):
                    run = ctx.repository.load().commands[record.command_id].result
            except Exception:
                # A policy approval must never block delivery; the human gate stays.
                logging.getLogger(__name__).warning('Policy auto-approve failed for %s', record.command_id, exc_info=True)
        if run['status'] == 'waiting_automation' and run.get('automation_wait', {}).get('reason') == 'goal_gate_pending':
            from homun.application.goal_terminal import resume as resume_goal_gate
            try:
                resume_goal_gate(ctx, run['id'])
            except DomainError as exc:
                fail(ctx, run['id'], exc.code, blocked=True, epoch=run['_epoch'],
                     expected_steering=run.get('_steering', []))
            run = ctx.repository.load().commands[run['id']].result
        if run['status'] == 'waiting_external':
            from homun.application.agent_external import resume_external
            try:
                if run.get('terminal_request_id'):
                    from homun.application.agent_terminal import resume as resume_terminal
                    resume_terminal(ctx,run['id'])
                elif run.get('terminal_wait_id'):
                    from homun.application.agent_terminal_sessions import resume_wait
                    resume_wait(ctx,run['id'])
                elif run.get('file_edit_request_id'):
                    from homun.application.workspace_file_edits import resume as resume_edit
                    resume_edit(ctx,run['id'])
                else:
                    resume_external(ctx, run['id'])
            except DomainError as exc:
                logging.getLogger(__name__).warning('Run %s blocked during resume (%s): %s',
                                                    run['id'], exc.code, exc.message, exc_info=True)
                fail(ctx, run['id'], exc.code, blocked=True)
            run = ctx.repository.load().commands[run['id']].result
        if run['status'] == 'waiting_input':
            try:
                from homun.application.clarification_deadlines import expire_waiting
                expire_waiting(ctx, run['id'])
                resume_waiting(ctx, run['id'])
            except DomainError as exc:
                fail(ctx, run['id'], exc.code, blocked=True, epoch=run['_epoch'])
            run = ctx.repository.load().commands[run['id']].result
        if run['status'] == 'completed' and (run.get('skills') or {}).get('policy') == 'workspace-catalog-v1':
            from homun.application.skill_reflection import maybe_reflect
            try:
                maybe_reflect(ctx, record.command_id)
            except Exception:
                # Reflection is learning, not delivery; failures never break the sweep.
                logging.getLogger(__name__).warning('Skill reflection failed for %s', record.command_id, exc_info=True)
        if run['status'] not in {'queued', 'running'}:
            continue
        try:
            start(run['_workflow_id'], run['id'], run['_epoch'])
        except Exception:
            # The command remains an intent; stable workflow id deduplicates retry.
            continue
