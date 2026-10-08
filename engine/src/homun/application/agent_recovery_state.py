"""Pure recovery-state transitions shared by controls and execution."""

def interrupted(recovery) -> dict:
    """A fenced recovery starts the next generation with a fresh budget."""
    verdict = {key: value for key, value in recovery.items()
               if key not in {'next_attempt_at', 'retry_after_seconds'}}
    verdict.update(status='interrupted', attempts=0)
    return verdict


def interrupt(run):
    """Owner controls fence unresolved waits; the new generation retries fresh."""
    # Keep the format marker: a later crash must not trigger legacy migration.
    run['_model_phase_attempts'] = {}
    run.pop('_force_context_compaction', None)
    run.pop('_overflow_recoveries', None)
    recovery = run.get('recovery')
    if recovery and recovery.get('status') == 'waiting':
        run['recovery'] = interrupted(recovery)

