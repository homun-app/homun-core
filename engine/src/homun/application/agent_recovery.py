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
from homun.domain.errors import DomainError
from homun.models.native_errors import NativeModelError, retry_delay

TOTAL_ATTEMPTS = 3


class RecoveryAttemptsExhausted(DomainError):
    code = 'agent_model_attempts_exhausted'


def migrate_inflight(run):
    """Before replacing an expired legacy lease, preserve its uncertain attempt.

    Old records lack phase identity for an unreported first failure. In that
    case the global call count is a conservative upper bound for either phase.
    Never infer that a provider request did not happen merely from missing output.
    """
    if '_model_phase_attempts' in run or not run.get('_lease_token') or run.get('_decision'):
        return
    from homun.application.agent_native import pending
    if pending(run):
        return
    previous = run.get('recovery') or {}
    if previous.get('status') == 'waiting' and previous.get('phase') in {'summary', 'decide'}:
        run['_model_phase_attempts'] = {previous['phase']: previous.get('attempts', 0) + 1}
    elif run.get('model_attempts', 0):
        count = min(TOTAL_ATTEMPTS, run['model_attempts'])
        run['_model_phase_attempts'] = {'summary': count, 'decide': count}


def can_attempt(run, phase):
    counters = run.get('_model_phase_attempts', {})
    previous = run.get('recovery') or {}
    legacy = (previous.get('attempts', 0)
              if previous.get('phase') == phase and previous.get('status') == 'waiting' else 0)
    return counters.get(phase, legacy) < TOTAL_ATTEMPTS


def begin(run, phase):
    """Reserve a retry slot in the caller's transaction, before provider IO."""
    counters = run.setdefault('_model_phase_attempts', {})
    if phase not in counters:
        previous = run.get('recovery') or {}
        counters[phase] = (previous.get('attempts', 0)
                           if previous.get('phase') == phase and previous.get('status') == 'waiting' else 0)
    if counters[phase] >= TOTAL_ATTEMPTS:
        raise RecoveryAttemptsExhausted('Model attempts exhausted, including interrupted calls')
    counters[phase] += 1


def waiting(run, *, now=None) -> bool:
    """True while a scheduled retry exists and is not due yet."""
    recovery = run.get('recovery')
    if not recovery or recovery.get('status') != 'waiting' or not recovery.get('next_attempt_at'):
        return False
    return datetime.fromisoformat(recovery['next_attempt_at']) > (now or utc_now())


def accept(run, phase):
    """Reset a phase's own counter once its output was accepted."""
    run.get('_model_phase_attempts', {}).pop(phase, None)
    if phase == 'decide':
        run.pop('_overflow_recoveries', None)
    recovery = run.get('recovery')
    if recovery and recovery.get('phase') == phase and recovery.get('status') != 'interrupted':
        recovery.update(status='recovered', attempts=0)
        recovery.pop('next_attempt_at', None)
        recovery.pop('retry_after_seconds', None)


def interrupt(run):
    """Owner controls fence unresolved waits; the new generation retries fresh."""
    # Keep the format marker: a later crash must not trigger legacy migration.
    run['_model_phase_attempts'] = {}
    run.pop('_force_context_compaction', None)
    run.pop('_overflow_recoveries', None)
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
            if not fenced and current.get('_steering', []) != expected_steering:
                interrupt(current)
                current.pop('_lease_token', None)
                current.pop('_lease_until', None)
                fenced = True
            if not fenced:
                authority(ctx, store, actor, current, running=True)
                previous = current.get('recovery') or {}
                attempts = current.get('_model_phase_attempts', {}).get(phase)
                if attempts is None:  # Compatibility with pre-counter in-flight calls.
                    attempts = previous.get('attempts', 0) + 1 if previous.get('phase') == phase else 1
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
