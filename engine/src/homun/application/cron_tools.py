"""Execution of cronjob_manage tool for agent runs (H28/H29).

Derived from Hermes tools/cronjob_tools.py at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Homun exposes a single unified cronjob_manage tool to minimize context bloat while
providing full CRUD, manual runs, chained context, and incident inspection.
"""
from __future__ import annotations

from typing import Any, Dict

from homun.application.cron_manager import CronManager
from homun.domain.errors import ValidationError


def execute(ctx, actor, run, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    if run.get("cron", {}).get("policy") != "durable-cron-v1":
        raise ValidationError("Cron scheduling tools are not enabled for this run")

    mgr = CronManager(workspace_id=run.get("work_id") or "default")
    action = str(args.get("action") or "").strip().lower()

    if action == "add":
        schedule = str(args.get("schedule") or "").strip()
        if not schedule:
            raise ValidationError("Schedule expression is required for 'add'")
        try:
            job = mgr.create_job(
                schedule=schedule,
                prompt=args.get("prompt"),
                name=args.get("name"),
                skills=args.get("skills"),
                script=args.get("script"),
                no_agent=bool(args.get("no_agent") or False),
                workdir=args.get("workdir"),
                model_pin=args.get("model_pin"),
                provider_pin=args.get("provider_pin"),
                context_from=args.get("context_from"),
                repeat=args.get("repeat"),
                deliver=str(args.get("deliver") or "local"),
            )
            run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True)]
            return {"status": "created", "job": job.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "list":
        jobs = mgr.list_jobs()
        return {
            "count": len(jobs),
            "jobs": [j.to_dict() for j in jobs],
        }

    if action in {"get", "status"}:
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'get'")
        job = mgr.get_job(job_id)
        if not job:
            raise ValidationError(f"Job not found: {job_id}")
        return {"job": job.to_dict()}

    if action == "update":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'update'")
        try:
            job = mgr.update_job(
                job_id,
                schedule=args.get("schedule"),
                prompt=args.get("prompt"),
                name=args.get("name"),
                skills=args.get("skills"),
                script=args.get("script"),
                no_agent=args.get("no_agent"),
                workdir=args.get("workdir"),
                model_pin=args.get("model_pin"),
                provider_pin=args.get("provider_pin"),
                context_from=args.get("context_from"),
                repeat=args.get("repeat"),
                deliver=args.get("deliver"),
                reason=args.get("reason"),
            )
            run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True)]
            return {"status": "updated", "job": job.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "pause":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'pause'")
        reason = str(args.get("reason") or "user-paused")
        job = mgr.pause_job(job_id, reason=reason)
        if not job:
            raise ValidationError(f"Job not found: {job_id}")
        run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True)]
        return {"status": "paused", "job": job.to_dict()}

    if action == "resume":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'resume'")
        job = mgr.resume_job(job_id)
        if not job:
            raise ValidationError(f"Job not found: {job_id}")
        run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True)]
        return {"status": "active", "job": job.to_dict()}

    if action == "remove":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'remove'")
        removed = mgr.remove_job(job_id)
        if not removed:
            raise ValidationError(f"Job not found or already removed: {job_id}")
        run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True)]
        return {"status": "removed", "job_id": job_id}

    if action == "run":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'run'")
        try:
            occ = mgr.run_job(job_id)
            run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True)]
            return {"status": "executed", "occurrence": occ.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "history":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'history'")
        history = mgr.get_history(job_id)
        return {"job_id": job_id, "count": len(history), "occurrences": [o.to_dict() for o in history]}

    if action == "incidents":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'incidents'")
        incidents = mgr.get_incidents(job_id)
        return {"job_id": job_id, "count": len(incidents), "incidents": [i.to_dict() for i in incidents]}

    raise ValidationError(f"Unsupported cronjob action: {action!r}")
