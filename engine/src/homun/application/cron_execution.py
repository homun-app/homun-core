"""Bounded cron execution outside the occurrence ownership transaction."""
import subprocess
import time

from homun.application.cron_contracts import CronExecutionResult
from homun.application import cron_occurrences


def execute(manager, job_id, *, now=None, custom_runner=None, claimed=None, cancelled=None, ctx=None, actor=None):
    curr = time.time() if now is None else float(now)
    job = manager.get_job(job_id)
    if not job:
        raise ValueError(f'Job not found: {job_id}')
    claimed = claimed or cron_occurrences.claim(manager._store, manager.workspace_id, job_id, now=curr, manual=True)
    if claimed is None or claimed.job_id != job_id:
        raise ValueError('Cron occurrence is already reserved or job is inactive')
    # Only the canonical staging runner promises replay-safe command identities.
    recovery_safe = bool(getattr(custom_runner, 'recovery_safe', False)) and not job.script
    if claimed.recovery_safe and not recovery_safe:
        raise ValueError('Cron staging recovery requires its canonical backend')
    if not cron_occurrences.begin_execution(manager._store, manager.workspace_id, claimed, recovery_safe=recovery_safe):
        raise ValueError('Cron occurrence claim is no longer current')
    parts = []
    for prior_id in job.context_from:
        prior = manager.get_job(prior_id)
        if prior and prior.last_output:
            parts.append(f'[Output from job {prior_id} ({prior.name or "unnamed"})]:\n{prior.last_output}')
    prompt = job.prompt or ''
    if parts:
        prompt = '\n\n'.join(parts) + '\n\n[Current Task]:\n' + prompt
    start = time.monotonic()
    refused = None
    if ctx is not None:
        from homun.application.cron_authority import require_owner
        from homun.domain.errors import DomainError
        try:
            require_owner(ctx, job, actor)
        except DomainError as exc:
            refused = CronExecutionResult('failed', error=exc.code, output=exc.message, exit_code=-1)
    if refused:
        result = refused
    elif cancelled and cancelled():
        result = CronExecutionResult('cancelled', error='cron_cancelled')
    elif custom_runner:
        try:
            result = custom_runner(dict(job_id=job.id, occurrence_id=claimed.occurrence_id,
                prompt=prompt, script=job.script, workdir=job.workdir, skills=job.skills,
                owner_actor=job.owner_actor, source_work_id=job.source_work_id,
                no_agent=job.no_agent, model_pin=job.model_pin, provider_pin=job.provider_pin))
            if not isinstance(result, CronExecutionResult):
                code, output, error = result
                result = CronExecutionResult('success' if code == 0 else 'failed', output, error, code)
        except Exception as exc:
            result = CronExecutionResult('unknown', error='cron_execution_outcome_unknown', output=str(exc))
    elif job.script:
        try:
            from homun.execution.owned_python import run_command
            code, out, err, truncated, failure = run_command(['/bin/sh', '-c', job.script],
                cwd=job.workdir, timeout=600, stdout_limit=50_000, stderr_limit=10_000, cancelled=cancelled)
            result = CronExecutionResult('unknown' if failure else 'success' if code == 0 else 'failed',
                out + ('\n' + err if err else ''), 'cron_execution_outcome_unknown' if failure else None if code == 0 else f'Script exited with code {code}', code)
        except OSError as exc:
            result = CronExecutionResult('failed', error=str(exc), exit_code=-1)
    else:
        from homun.application.cron_schedule import AGENT_RUNNER_UNAVAILABLE
        result = CronExecutionResult('failed', AGENT_RUNNER_UNAVAILABLE, 'backend_unavailable', -1)
    occurrence = cron_occurrences.settle(manager._store, manager.workspace_id, claimed, result,
                                        now=curr + time.monotonic() - start)
    manager.get_job(job_id)  # Refresh existing public objects from authoritative settlement.
    if occurrence.status == 'failed':
        manager.record_incident(job.id, occurrence.error or f'failed with exit code {occurrence.exit_code}', now=curr)
    return occurrence
