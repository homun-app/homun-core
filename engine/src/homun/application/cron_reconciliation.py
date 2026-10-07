"""Project terminal canonical run outcomes onto durable cron occurrences."""
import time

from homun.application.cron_contracts import CronExecutionResult
from homun.application.cron_store import get_cron_store
from homun.application.cron_occurrences import settle


def reconcile_cron_runs(ctx, *, store=None, now=None, limit=50):
    store = store or get_cron_store()
    now = time.time() if now is None else float(now)
    workspace_id = ctx.workspace_id
    snapshot = ctx.repository.snapshot()
    results = []
    for job in store.list_jobs(workspace_id):
        for occurrence in store.list_occurrences(workspace_id, job.id):
            if len(results) >= limit:
                return results
            if occurrence.status not in {'awaiting_approval', 'running'} or not occurrence.agent_run_id:
                continue
            record = snapshot.commands.get(occurrence.agent_run_id)
            if not record:
                continue  # Never infer failure or success from missing evidence.
            run = record.result
            if run.get('work_id') != occurrence.work_id:
                continue
            status = run.get('status')
            if status == 'completed':
                artifact = snapshot.artifacts.get(run.get('artifact_id'))
                if not artifact:
                    continue
                outcome = CronExecutionResult('success', output=artifact.content, exit_code=0)
            elif status in {'failed', 'blocked', 'cancelled', 'rejected'}:
                outcome = CronExecutionResult('cancelled' if status in {'cancelled', 'rejected'} else 'failed',
                    error=run.get('error_code') or f'agent_run_{status}', exit_code=-1)
            elif status in {'queued', 'running', 'waiting_input', 'waiting_external', 'paused', 'waiting_automation'}:
                if occurrence.status == 'running':
                    continue
                outcome = CronExecutionResult('running')
            else:
                continue
            try:
                settled = settle(store, workspace_id, occurrence, outcome, now=now)
            except ValueError:
                continue  # Another reconciler settled the same fenced occurrence.
            results.append(settled.to_dict())
    return results
