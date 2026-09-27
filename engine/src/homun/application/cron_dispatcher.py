"""Process-local due-fire dispatcher for durable cron jobs (H28/H29).

Scans CronStore for active due jobs, claims them, and executes via script
subprocess or CronAgentRunner when an EngineContext is bound. Chronos remains
a separate optional provider adapter.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from homun.application.cron_agent_runner import make_cron_runner
from homun.application.cron_manager import CronManager
from homun.application.cron_store import get_cron_store
from homun.domain.models import Actor

logger = logging.getLogger(__name__)

Runner = Callable[[Dict[str, Any]], Tuple[int, str, Optional[str]]]


def list_due_job_ids(workspace_id: str = "default", *, now: Optional[float] = None) -> List[str]:
    """Return job ids that are claimable at `now`."""
    mgr = CronManager(workspace_id=workspace_id)
    curr = time.time() if now is None else float(now)
    due: List[str] = []
    for job in mgr.list_jobs():
        if mgr.is_due(job.id, now=curr):
            due.append(job.id)
    return due


def fire_due_jobs(
    workspace_id: str = "default",
    *,
    now: Optional[float] = None,
    ctx=None,
    actor: Optional[Actor] = None,
    custom_runner: Optional[Runner] = None,
    limit: int = 50,
    cancelled=None,
) -> List[Dict[str, Any]]:
    """Execute up to `limit` due jobs. Returns occurrence summaries."""
    mgr = CronManager(workspace_id=workspace_id, store=get_cron_store())
    curr = time.time() if now is None else float(now)
    results: List[Dict[str, Any]] = []
    for job in mgr.list_jobs():
        curr = time.time() if now is None else float(now)
        if cancelled and cancelled():
            break
        if len(results) >= limit:
            break
        if ctx is not None and actor is not None:
            from homun.application.cron_authority import require_owner
            from homun.domain.errors import DomainError
            try:
                require_owner(ctx, job, actor)
            except DomainError:
                continue
        claim = mgr.claim_job_for_fire(job.id, now=curr)
        if claim is None:
            continue
        runner = custom_runner
        if runner is None and not job.script and ctx is not None:
            runner = make_cron_runner(ctx, actor)
        try:
            occ = mgr.run_job(job.id, now=curr, custom_runner=runner, claim=claim, cancelled=cancelled, ctx=ctx, actor=actor)
            results.append({"job_id": job.id, "occurrence": occ.to_dict()})
        except Exception as exc:
            logger.warning("Due-fire failed for %s: %s", job.id, exc)
            results.append({"job_id": job.id, "error": str(exc)})
    return results
