"""Terminal agent-run failure recording; extracted so recovery paths share it
without importing the execution module (which owns the turn loop)."""
from homun.application.agent_runs import lookup
from homun.domain.ids import new_id
from homun.domain.models import DomainEvent, utc_now
from homun.domain.states import WorkStatus


from homun.application.agent_recovery_state import interrupted


def fail(ctx, run_id, code, *, token=None, blocked=False, epoch=None, expected_steering=None,
         recovery=None):
    """Mark a run failed (or blocked) unless a concurrent change superseded it.

    ``recovery`` attaches the durable recovery verdict of the failing call.
    The steering fence applies to terminal failures exactly as it does to
    successful results: a correction that arrived during generation defers the
    failure and resets the retry budget for the corrected request.
    """
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            run = lookup(store, run_id)
            if epoch is not None and run['_epoch'] != epoch:
                return 'superseded'
            goal_wait = (run['status'] == 'waiting_automation'
                         and run.get('automation_wait', {}).get('reason') == 'goal_gate_pending')
            if run['status'] not in {'queued', 'running', 'waiting_input', 'waiting_external'} and not goal_wait:
                return run['status']
            if token is not None and run.get('_lease_token') != token:
                return run['status']
            if expected_steering is not None and run.get('_steering', []) != expected_steering:
                # Terminal failures obey the same human-input fence as successful results.
                run.pop('_lease_token', None)
                run.pop('_lease_until', None)
                if recovery is not None:
                    run['recovery'] = interrupted(recovery)
            else:
                run.update(status='blocked' if blocked else 'failed', error_code=code)
                if recovery is not None:
                    run['recovery'] = recovery
                run.pop('_lease_token', None)
                run.pop('_lease_until', None)
                work = store.works[run['work_id']]
                if not run.get('_delegation_parent') and work.status == WorkStatus.RUNNING and work.version == run.get('_run_version'):
                    work.status = WorkStatus.FAILED
                    work.version += 1
                    work.updated_at = utc_now()
                    store.events.append(DomainEvent(event_id=new_id('evt'), workspace_id=store.workspace_id,
                        aggregate_id=work.id, aggregate_type='work', aggregate_version=work.version,
                        sequence=store.next_sequence(), type='work.agent_run_failed', actor_id='homun_engine',
                        command_id=run_id, payload={'error_code': code}))
        ctx.service.store = store
    if run['status'] in {'failed', 'blocked'}:
        from homun.execution.browser_sessions import close_browser
        close_browser(run_id)
    return run['status']
