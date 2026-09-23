"""Durable recovery for native model calls: persisted attempts, waits, fences.

Adapts the retry placement of Hermes agent/turn_api_error.py and
agent/turn_recovery.py (MIT; see homun/notices/hermes-agent.txt): three total
attempts per phase, Retry-After (capped 600s) or jittered base-2 backoff, and
counters that live in the run record so process restarts and DBOS replay never
reset them. Waits hold no lease or transaction: the workflow re-claims through
its busy path, revalidating authority, epoch and steering before each attempt.
Only the failed model request is retried — committed tool rounds are never
re-executed and partial replies are never published.
"""
from datetime import datetime, timedelta
from homun.application.agent_run_failures import fail, interrupted
from homun.application.agent_runs import authority, lookup
from homun.domain.models import utc_now
from homun.models.native_errors import NativeModelError, retry_delay

TOTAL_ATTEMPTS = 3


def waiting(run, *, now=None) -> bool:
    """True while a scheduled retry exists and is not due yet."""
    recovery = run.get('recovery')
    if not recovery or recovery.get('status') != 'waiting' or not recovery.get('next_attempt_at'):
        return False
    return datetime.fromisoformat(recovery['next_attempt_at']) > (now or utc_now())


def accept(run, phase):
    """Reset a phase's own counter once its output was accepted."""
    recovery = run.get('recovery')
    if recovery and recovery.get('phase') == phase and recovery.get('status') != 'interrupted':
        recovery.update(status='recovered', attempts=0)
        recovery.pop('next_attempt_at', None)
        recovery.pop('retry_after_seconds', None)


def interrupt(run):
    """Owner controls fence unresolved waits; the new generation retries fresh."""
    recovery = run.get('recovery')
    if recovery and recovery.get('status') == 'waiting':
        run['recovery'] = interrupted(recovery)


def schedule(ctx, actor, run, error: NativeModelError, *, phase, expected_steering):
    """Persist the verdict of a failed model call after its budget charge.

    Returns ``'waiting'`` (retry scheduled, lease released — the workflow's
    busy path brings the run back when due), ``'fenced'`` (a concurrent
    control owns the run now; nothing was written) or the terminal status
    recorded by :func:`fail` once attempts are exhausted.
    """
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            fenced = (current['_epoch'] != run['_epoch']
                      or current.get('_lease_token') != run.get('_lease_token'))
            outcome = 'fenced'
            recovery = None
            if not fenced:
                authority(ctx, store, actor, current, running=True)
                previous = current.get('recovery') or {}
                attempts = (previous.get('attempts', 0) + 1
                            if previous.get('phase') == phase else 1)
                recovery = {'phase': phase, 'status': 'waiting', 'attempts': attempts,
                            'error_code': error.code,
                            'next_attempt_at': (utc_now() + timedelta(
                                seconds=retry_delay(attempts, error))).isoformat()}
                if error.retry_after_seconds is not None:
                    recovery['retry_after_seconds'] = min(600.0, float(error.retry_after_seconds))
                if attempts < TOTAL_ATTEMPTS:
                    current['recovery'] = recovery
                    current.pop('_lease_token', None)
                    current.pop('_lease_until', None)
                    outcome = 'waiting'
                else:
                    recovery['status'] = 'exhausted'
                    outcome = 'exhausted'
        ctx.service.store = store
    if outcome == 'exhausted':
        return fail(ctx, run['id'], error.code, token=run.get('_lease_token'),
                    expected_steering=expected_steering, recovery=recovery)
    return outcome
