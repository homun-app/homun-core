"""Persist bounded compression intent after a provider context rejection.

No guessed context limit, blind replay, output-cap increase or recursive summary
recovery. The existing context planner proves a safe cut and meaningful reduction.
"""
from homun.application.agent_runs import lookup
from homun.application.agent_recovery import can_attempt

MAX_RECOVERIES = 2


def request_compaction(ctx, run, *, expected_steering):
    """True means handled or fenced; False leaves a typed terminal overflow."""
    handled = False
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            current = lookup(store, run['id'])
            if (current['_epoch'] != run['_epoch']
                    or current.get('_lease_token') != run.get('_lease_token')
                    or current['status'] != 'running'):
                handled = True
            elif current.get('_steering', []) != expected_steering:
                current.pop('_lease_token', None)
                current.pop('_lease_until', None)
                handled = True
            elif ((current.get('_context_policy') or {}).get('context_window')
                  and current.get('_overflow_recoveries', 0) < MAX_RECOVERIES
                  and can_attempt(current, 'decide')):
                current['_overflow_recoveries'] = current.get('_overflow_recoveries', 0) + 1
                current['_force_context_compaction'] = True
                current.pop('_lease_token', None)
                current.pop('_lease_until', None)
                handled = True
        ctx.service.store = store
    return handled
