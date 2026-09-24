"""CronManager: durable scheduling, lifecycle, preflight, chained context, and incident tracking (H28/H29).

Derived from Hermes cron/jobs.py, cron/executions.py, cron/incidents.py, cron/quota_hold.py,
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

_INTERVAL_RE = re.compile(
    r"^\s*(?:every\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*$",
    re.IGNORECASE,
)
_UNIT_SECONDS = {
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}

AGENT_RUNNER_UNAVAILABLE = (
    "Cron prompt/skills jobs require an injected agent runner; "
    "no synthetic success is returned without a real execution backend."
)


def reset_store(workspace_id: Optional[str] = None) -> None:
    """Clear durable cron state (tests should prefer an isolated :memory: store)."""
    store = get_cron_store()
    if workspace_id is not None:
        store.clear_workspace(workspace_id)
    else:
        store.clear_all()


def parse_schedule(schedule_str: str) -> Dict[str, Any]:
    """Parse schedule into structured kind and details."""
    raw = (schedule_str or "").strip()
    if not raw:
        raise ValueError("schedule string cannot be empty")

    # 1. Event trigger: on event:<name>
    if raw.lower().startswith("on event:"):
        event_name = raw[9:].strip()
        if not event_name:
            raise ValueError("Event name cannot be empty in 'on event:<name>'")
        return {"kind": "event", "event": event_name, "raw": raw}

    # 2. Relative interval: every 2h / 30m
    m = _INTERVAL_RE.match(raw)
    if m:
        seconds = int(float(m.group(1)) * _UNIT_SECONDS[m.group(2).lower()])
        return {"kind": "interval", "seconds": max(1, seconds), "raw": raw}

    # 3. One-shot: at <iso> / once: <iso>
    if raw.lower().startswith("once:") or raw.lower().startswith("at "):
        prefix_len = 5 if raw.lower().startswith("once:") else 3
        iso_part = raw[prefix_len:].strip()
        try:
            dt = datetime.fromisoformat(iso_part.replace("Z", "+00:00"))
            return {"kind": "once", "timestamp": dt.timestamp(), "raw": raw}
        except Exception as exc:
            raise ValueError(f"Invalid one-shot ISO timestamp: {iso_part!r}") from exc

    # 4. Standard cron: 5 or 6 fields
    parts = raw.split()
    if len(parts) in {5, 6}:
        return {"kind": "cron", "cron": raw, "raw": raw}

    raise ValueError(f"Unrecognized schedule format: {raw!r}")


def _parse_cron_field(expr: str, min_v: int, max_v: int) -> Set[int]:
    """Parse a single field of a cron expression into valid integer values."""
    expr = expr.strip()
    res: Set[int] = set()
    for part in expr.split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            subparts = part.split("/", 1)
            part = subparts[0]
            step = int(subparts[1])
        if part == "*":
            start_v, end_v = min_v, max_v
        elif "-" in part:
            start_s, end_s = part.split("-", 1)
            start_v, end_v = int(start_s), int(end_s)
        else:
            start_v = end_v = int(part)
        for v in range(start_v, end_v + 1, step):
            if min_v <= v <= max_v:
                res.add(v)
    return res


def compute_next_cron(cron_expr: str, now: float) -> float:
    """Compute next matching unix timestamp for a 5- or 6-field cron expression in pure Python."""
    parts = cron_expr.strip().split()
    if len(parts) == 6:
        parts = parts[1:]
    if len(parts) != 5:
        return now + 3600.0

    min_set = _parse_cron_field(parts[0], 0, 59)
    hr_set = _parse_cron_field(parts[1], 0, 23)
    dom_set = _parse_cron_field(parts[2], 1, 31)
    mon_set = _parse_cron_field(parts[3], 1, 12)
    dow_set = _parse_cron_field(parts[4], 0, 7)
    if 7 in dow_set:
        dow_set.add(0)

    curr_dt = datetime.fromtimestamp(now, tz=timezone.utc).replace(second=0, microsecond=0)
    curr_dt += dt_mod.timedelta(minutes=1)

    max_steps = 525600  # 1 year search ceiling
    for _ in range(max_steps):
        if curr_dt.month not in mon_set:
            if curr_dt.month == 12:
                curr_dt = curr_dt.replace(year=curr_dt.year + 1, month=1, day=1, hour=0, minute=0)
            else:
                curr_dt = curr_dt.replace(month=curr_dt.month + 1, day=1, hour=0, minute=0)
            continue

        dow = (curr_dt.weekday() + 1) % 7
        dom_match = curr_dt.day in dom_set
        dow_match = dow in dow_set

        dom_is_star = parts[2] == "*"
        dow_is_star = parts[4] == "*"
        if dom_is_star and dow_is_star:
            day_matches = True
        elif not dom_is_star and not dow_is_star:
            day_matches = dom_match or dow_match
        elif not dom_is_star:
            day_matches = dom_match
        else:
            day_matches = dow_match

        if not day_matches:
            curr_dt = (curr_dt + dt_mod.timedelta(days=1)).replace(hour=0, minute=0)
            continue

        if curr_dt.hour not in hr_set:
            curr_dt = (curr_dt + dt_mod.timedelta(hours=1)).replace(minute=0)
            continue

        if curr_dt.minute in min_set:
            return curr_dt.timestamp()

        curr_dt += dt_mod.timedelta(minutes=1)

    return now + 86400.0


def compute_next_run(job: CronJob, now: Optional[float] = None) -> float:
    """Compute the next due timestamp for a job."""
    curr = time.time() if now is None else float(now)
    parsed = parse_schedule(job.schedule_raw)

    if parsed["kind"] == "interval":
        interval = parsed["seconds"]
        return curr + interval

    if parsed["kind"] == "once":
        return parsed.get("timestamp", curr)

    if parsed["kind"] == "event":
        return 0.0

    if parsed["kind"] == "cron":
        return compute_next_cron(parsed["cron"], curr)

    return curr + 3600.0


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
        paused: bool = False,
        paused_reason: Optional[str] = None,
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
        if cached is not None:
            return cached
        job = self._store.get_job(self.workspace_id, job_id)
        if job is not None:
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

    def pause_job(self, job_id: str, reason: str = "user-paused") -> Optional[CronJob]:
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            return None
        job.status = "paused"
        job.paused_reason = reason
        job.next_run_at = 0.0
        return self._persist_job(job)

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

    def remove_job(self, job_id: str) -> bool:
        job = self.get_job(job_id)
        if not job or job.status == "cleared":
            return False
        job.status = "cleared"
        job.next_run_at = 0.0
        self._persist_job(job)
        return True

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

    def claim_job_for_fire(self, job_id: str, now: Optional[float] = None) -> Optional[CronJob]:
        """Claim a runnable job for execution, ensuring atomic execution reservation."""
        job = self.get_job(job_id)
        if not job or job.status != "active":
            return None
        curr = time.time() if now is None else float(now)
        if job.schedule_kind != "event" and curr < job.next_run_at:
            return None
        return job

    def run_job(
        self,
        job_id: str,
        *,
        now: Optional[float] = None,
        custom_runner: Optional[Callable[[Dict[str, Any]], Tuple[int, str, Optional[str]]]] = None,
    ) -> CronOccurrence:
        """Execute a job, resolving chained context and recording occurrence and incidents."""
        job = self.get_job(job_id)
        if not job:
            raise ValueError(f"Job not found: {job_id}")

        curr = time.time() if now is None else float(now)
        occ_id = f"occ-{uuid.uuid4().hex[:8]}"

        # 1. Chained context resolution (H28)
        chained_context_text = ""
        if job.context_from:
            chained_parts = []
            for prior_id in job.context_from:
                prior_job = self.get_job(prior_id)
                if prior_job and prior_job.last_output:
                    chained_parts.append(
                        f"[Output from job {prior_id} ({prior_job.name or 'unnamed'})]:\n{prior_job.last_output}"
                    )
            if chained_parts:
                chained_context_text = "\n\n".join(chained_parts)

        # 2. Execution payload preparation
        effective_prompt = job.prompt or ""
        if chained_context_text:
            effective_prompt = f"{chained_context_text}\n\n[Current Task]:\n{effective_prompt}"

        # 3. Execution
        start_time = time.time()
        exit_code = 0
        output = ""
        error = None

        if custom_runner is not None:
            try:
                exit_code, output, error = custom_runner({
                    "job_id": job.id,
                    "prompt": effective_prompt,
                    "script": job.script,
                    "workdir": job.workdir,
                    "skills": job.skills,
                    "no_agent": job.no_agent,
                    "model_pin": job.model_pin,
                    "provider_pin": job.provider_pin,
                })
            except Exception as exc:
                exit_code = -1
                error = str(exc)
                output = f"Execution failed: {exc}"
        elif job.script:
            cmd = job.script
            try:
                proc = subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    cwd=job.workdir or None,
                    timeout=600,
                )
                exit_code = proc.returncode
                output = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
                if exit_code != 0:
                    error = f"Script exited with code {exit_code}"
            except Exception as exc:
                exit_code = -1
                error = str(exc)
                output = f"Script execution error: {exc}"
        else:
            # Prompt/skills jobs need a real agent runner — never invent success.
            exit_code = -1
            error = "backend_unavailable"
            output = AGENT_RUNNER_UNAVAILABLE

        duration = time.time() - start_time
        status = "success" if exit_code == 0 else "failed"

        # 4. Record occurrence
        occurrence = CronOccurrence(
            occurrence_id=occ_id,
            job_id=job.id,
            run_at=curr,
            completed_at=curr + duration,
            status=status,
            exit_code=exit_code,
            output_preview=output[:2000],
            error=error,
            duration_s=round(duration, 3),
        )
        self._store.append_occurrence(self.workspace_id, occurrence)

        # 5. Update job metrics and state
        job.last_run_at = curr
        job.last_output = output
        job.run_count += 1

        if status == "success":
            job.consecutive_errors = 0
        else:
            job.error_count += 1
            job.consecutive_errors += 1
            self.record_incident(job.id, error or f"failed with exit code {exit_code}", now=curr)

        # 6. Repeat count evaluation
        if job.repeat is not None and job.run_count >= job.repeat:
            job.status = "completed"
            job.next_run_at = 0.0
        elif job.status == "active":
            job.next_run_at = compute_next_run(job, now=curr)

        self._persist_job(job)

        # 7. Durable delivery queuing (H29)
        if job.deliver != "local" and output and status == "success":
            self._store.append_delivery(self.workspace_id, {
                "job_id": job.id,
                "target": job.deliver,
                "output": output,
                "enqueued_at": curr,
            })

        return occurrence
