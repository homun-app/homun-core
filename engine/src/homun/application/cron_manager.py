"""CronManager: durable scheduling, lifecycle, preflight, chained context, and incident tracking (H28/H29).

and tools/cronjob_tools.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun executes scheduled jobs with inference pins, chained context injection,
deterministic preflight verification, script and skill dispatch, quota hold,
and deduplicated incident reporting.
"""
from __future__ import annotations

import datetime as dt_mod
import logging
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from homun.application.cron_contracts import CronIncident, CronJob, CronOccurrence
from homun.application.cron_store import CronStore, get_cron_store

logger = logging.getLogger(__name__)

from homun.application.cron_schedule import parse_schedule, compute_next_cron, compute_next_run, AGENT_RUNNER_UNAVAILABLE


def reset_store(workspace_id: Optional[str] = None) -> None:
    """Clear durable cron state (tests should prefer an isolated :memory: store)."""
    store = get_cron_store()
    if workspace_id is not None:
        store.clear_workspace(workspace_id)
    else:
        store.clear_all()



def atomic_job_mutation(method):
    from functools import wraps
    @wraps(method)
    def mutate(self, *args, **kwargs):
        from homun.application.cron_occurrences import transaction
        with transaction(self._store):
            return method(self, *args, **kwargs)
    return mutate


class CronManager:
    """Manager for durable cron jobs, preflight checks, and execution histories."""

    def __init__(self, workspace_id: str = "default", store: Optional[CronStore] = None):
        self.workspace_id = str(workspace_id or "default")
        self._store = store or get_cron_store()
        # Write-through cache keeps object identity for callers within this manager.
        self._jobs: Dict[str, CronJob] = {}

    def _persist_job(self, job: CronJob) -> CronJob:
        self._jobs[job.id] = job
        self._store.put_job(self.workspace_id, job)
        return job

    def create_job(
        self,
        schedule: str,
        *,
        prompt: Optional[str] = None,
        name: Optional[str] = None,
        skills: Optional[List[str]] = None,
        script: Optional[str] = None,
        no_agent: bool = False,
        workdir: Optional[str] = None,
        model_pin: Optional[str] = None,
        provider_pin: Optional[str] = None,
        context_from: Optional[List[str]] = None,
        repeat: Optional[int] = None,
        deliver: str = "local",
        auto_approve: bool = False,
        paused: bool = False,
        paused_reason: Optional[str] = None,
        owner_actor: Optional[Dict[str, Any]] = None,
        source_work_id: Optional[str] = None,
        now: Optional[float] = None,
    ) -> CronJob:
        prompt_text = (prompt or "").strip() or None
        script_path = (script or "").strip() or None
        norm_skills = [s.strip() for s in (skills or []) if s.strip()]

        if not prompt_text and not script_path and not norm_skills:
            raise ValueError("Job must specify at least one of prompt, script, or skills")

        parsed = parse_schedule(schedule)
        job_id = f"job-{uuid.uuid4().hex[:8]}"
        curr = time.time() if now is None else float(now)

        if parsed["kind"] == "once" and repeat is None:
            repeat = 1

        job = CronJob(
            id=job_id,
            schedule_raw=schedule,
            schedule_kind=parsed["kind"],
            name=name.strip() if name else None,
            prompt=prompt_text,
            skills=norm_skills,
            script=script_path,
            no_agent=bool(no_agent),
            workdir=workdir.strip() if workdir else None,
            model_pin=model_pin.strip() if model_pin else None,
            provider_pin=provider_pin.strip() if provider_pin else None,
            context_from=[c.strip() for c in (context_from or []) if c.strip()],
            repeat=repeat,
            deliver=deliver,
            auto_approve=bool(auto_approve),
            owner_actor=owner_actor,
            source_work_id=source_work_id,
            status="paused" if paused else "active",
            paused_reason=paused_reason if paused else None,
            created_at=curr,
            next_run_at=compute_next_run(CronJob(id="", schedule_raw=schedule), now=curr) if not paused else 0.0,
        )

        self.preflight_check(job)
        return self._persist_job(job)

    def preflight_check(self, job: CronJob) -> None:
        """Validate job runnable prerequisites before saving or execution."""
        if not job.prompt and not job.script and not job.skills:
            raise ValueError("Preflight failed: no executable payload (prompt, script, or skills)")
        if job.no_agent and not job.script:
            raise ValueError("Preflight failed: no_agent=True requires a script path")
        if job.model_pin is not None and not job.model_pin.strip():
            raise ValueError("Preflight failed: model_pin cannot be an empty string")
        if job.provider_pin is not None and not job.provider_pin.strip():
            raise ValueError("Preflight failed: provider_pin cannot be an empty string")
        if job.script and job.workdir:
            full_path = os.path.join(job.workdir, job.script) if not os.path.isabs(job.script) else job.script
            if not os.path.exists(full_path):
                logger.warning("Preflight notice: script path does not exist yet (%s)", full_path)

    def get_job(self, job_id: str) -> Optional[CronJob]:
        cached = self._jobs.get(job_id)
        job = self._store.get_job(self.workspace_id, job_id)
        if job is not None:
            if cached is not None:
                cached.__dict__.update(job.__dict__)
                return cached
            self._jobs[job_id] = job
        return job

    def list_jobs(self, include_cleared: bool = False) -> List[CronJob]:
        # Prefer store as source of truth; reuse cached objects for identity.
        result: List[CronJob] = []
        for job in self._store.list_jobs(self.workspace_id):
            cached = self._jobs.get(job.id)
            if cached is None:
                self._jobs[job.id] = job
                result.append(job)
            else:
                for key, value in job.__dict__.items():
                    setattr(cached, key, value)
                result.append(cached)
        if not include_cleared:
            result = [j for j in result if j.status != "cleared"]
        return result

    @atomic_job_mutation
    def update_job(
        self,
        job_id: str,
        *,
        schedule: Optional[str] = None,
        prompt: Optional[str] = None,
        name: Optional[str] = None,
        skills: Optional[List[str]] = None,
        script: Optional[str] = None,
        no_agent: Optional[bool] = None,
        workdir: Optional[str] = None,
        model_pin: Optional[str] = None,
        provider_pin: Optional[str] = None,
        context_from: Optional[List[str]] = None,
        repeat: Optional[int] = None,
        deliver: Optional[str] = None,
        reason: Optional[str] = None,
        now: Optional[float] = None,
    ) -> CronJob:
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            raise ValueError(f"Job not found: {job_id}")

        curr = time.time() if now is None else float(now)

        if schedule is not None:
            parsed = parse_schedule(schedule)
            job.schedule_raw = schedule
            job.schedule_kind = parsed["kind"]
            if job.status == "active":
                job.next_run_at = compute_next_run(job, now=curr)

        if prompt is not None:
            job.prompt = prompt.strip() or None
        if name is not None:
            job.name = name.strip() or None
        if skills is not None:
            job.skills = [s.strip() for s in skills if s.strip()]
        if script is not None:
            job.script = script.strip() or None
        if no_agent is not None:
            job.no_agent = bool(no_agent)
        if workdir is not None:
            job.workdir = workdir.strip() or None
        if model_pin is not None:
            job.model_pin = model_pin.strip() or None
        if provider_pin is not None:
            job.provider_pin = provider_pin.strip() or None
        if context_from is not None:
            job.context_from = [c.strip() for c in context_from if c.strip()]
        if repeat is not None:
            job.repeat = repeat
        if deliver is not None:
            job.deliver = deliver
        if reason is not None:
            job.paused_reason = reason

        self.preflight_check(job)
        return self._persist_job(job)

    @atomic_job_mutation
    def pause_job(self, job_id: str, reason: str = "user-paused") -> Optional[CronJob]:
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            return None
        job.status = "paused"
        job.paused_reason = reason
        job.next_run_at = 0.0
        return self._persist_job(job)

    @atomic_job_mutation
    def resume_job(self, job_id: str, now: Optional[float] = None) -> Optional[CronJob]:
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            return None
        job.status = "active"
        job.paused_reason = None
        job.quota_hold = False
        curr = time.time() if now is None else float(now)
        job.next_run_at = compute_next_run(job, now=curr)
        return self._persist_job(job)

    @atomic_job_mutation
    def remove_job(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            return False
        job.status = "cleared"
        job.next_run_at = 0.0
        self._persist_job(job)
        return True

    @atomic_job_mutation
    def trigger_quota_hold(self, job_id: str, reason: str = "provider quota exhausted", now: Optional[float] = None) -> Optional[CronJob]:
        """Apply quota hold to pause job until quota/balance is restored (H29)."""
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            return None
        curr = time.time() if now is None else float(now)
        job.quota_hold = True
        job.status = "paused"
        job.paused_reason = f"quota_hold: {reason}"
        job.next_run_at = 0.0
        self._persist_job(job)
        self.record_incident(job_id, f"Quota hold triggered: {reason}", now=curr)
        return job

    def record_incident(self, job_id: str, error_message: str, now: Optional[float] = None) -> CronIncident:
        """Record or deduplicate an incident for this job."""
        curr = time.time() if now is None else float(now)
        incidents = self.get_incidents(job_id)

        for inc in incidents:
            if not inc.resolved and inc.error_message == error_message:
                inc.occurrence_count += 1
                inc.last_seen_at = curr
                self._store.put_incident(self.workspace_id, inc)
                return inc

        new_inc = CronIncident(
            job_id=job_id,
            error_message=error_message,
            first_seen_at=curr,
            last_seen_at=curr,
            occurrence_count=1,
            resolved=False,
        )
        self._store.put_incident(self.workspace_id, new_inc)
        return new_inc

    def resolve_incidents(self, job_id: str) -> int:
        """Mark all open incidents for a job as resolved."""
        incidents = self.get_incidents(job_id)
        count = 0
        for inc in incidents:
            if not inc.resolved:
                inc.resolved = True
                self._store.put_incident(self.workspace_id, inc)
                count += 1
        return count

    def get_incidents(self, job_id: str) -> List[CronIncident]:
        return self._store.list_incidents(self.workspace_id, job_id)

    def get_history(self, job_id: str) -> List[CronOccurrence]:
        return self._store.list_occurrences(self.workspace_id, job_id)

    def get_deliveries(self) -> List[Dict[str, Any]]:
        return self._store.list_deliveries(self.workspace_id)

    def is_due(self, job_id: str, now: Optional[float] = None) -> bool:
        from homun.application.cron_occurrences import is_due
        return is_due(self._store, self.workspace_id, job_id, now=time.time() if now is None else float(now))

    def activate_event(self, job_id: str, *, activation_id: str, now: Optional[float] = None):
        from homun.application.cron_occurrences import activate_event
        return activate_event(self._store, self.workspace_id, job_id, activation_id=activation_id,
                              now=time.time() if now is None else float(now))

    def claim_job_for_fire(self, job_id: str, now: Optional[float] = None):
        from homun.application.cron_occurrences import claim
        return claim(self._store, self.workspace_id, job_id, now=time.time() if now is None else float(now))

    def run_job(self, job_id: str, *, now: Optional[float] = None, custom_runner=None, claim=None, cancelled=None, ctx=None, actor=None) -> CronOccurrence:
        from homun.application.cron_execution import execute
        return execute(self, job_id, now=now, custom_runner=custom_runner, claimed=claim, cancelled=cancelled, ctx=ctx, actor=actor)
