"""Execution of cronjob_manage tool for agent runs (H28/H29).

Homun exposes a single unified cronjob_manage tool to minimize context bloat while
providing full CRUD, manual runs, chained context, and incident inspection.
"""
from __future__ import annotations

from typing import Any, Dict

from homun.application.cron_manager import CronManager
from homun.domain.errors import ValidationError


def execute(ctx, actor, run, tool: str, args: Dict[str, Any], *, runner_factory=None) -> Dict[str, Any]:
    if run.get("cron", {}).get("policy") != "durable-cron-v1":
        raise ValidationError("Cron scheduling tools are not enabled for this run")

    mgr = CronManager(workspace_id=actor.workspace_id)

    def accessible(job):
        return (job is not None and job.source_work_id == run.get('work_id')
                and (job.owner_actor or {}).get('id') == actor.id)

    target = args.get('job_id')
    if target and not accessible(mgr.get_job(str(target))):
        raise ValidationError('Cron job is outside this run scope')
    for prior_id in args.get('context_from') or []:
        if not accessible(mgr.get_job(prior_id)):
            raise ValidationError('Cron context source is outside this run scope')
    action = str(args.get("action") or "").strip().lower()

    if action == "add":
        schedule = str(args.get("schedule") or "").strip()
        if not schedule:
            raise ValidationError("Schedule expression is required for 'add'")
        try:
            job = mgr.create_job(
                schedule=schedule,
                owner_actor=actor.model_dump(mode="json"),
                source_work_id=run.get("work_id"),
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
                auto_approve=bool(args.get("auto_approve") or False),
            )
            run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True) if accessible(j)]
            return {"status": "created", "job": job.to_dict()}
        except ValueError as exc:
            raise ValidationError(str(exc))

    if action == "list":
        jobs = [job for job in mgr.list_jobs() if accessible(job)]
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
            run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True) if accessible(j)]
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
        run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True) if accessible(j)]
        return {"status": "paused", "job": job.to_dict()}

    if action == "resume":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'resume'")
        job = mgr.resume_job(job_id)
        if not job:
            raise ValidationError(f"Job not found: {job_id}")
        run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True) if accessible(j)]
        return {"status": "active", "job": job.to_dict()}

    if action == "remove":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'remove'")
        removed = mgr.remove_job(job_id)
        if not removed:
            raise ValidationError(f"Job not found or already removed: {job_id}")
        run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True) if accessible(j)]
        return {"status": "removed", "job_id": job_id}

    if action == "run":
        job_id = str(args.get("job_id") or "").strip()
        if not job_id:
            raise ValidationError("job_id is required for 'run'")
        try:
            job = mgr.get_job(job_id)
            custom_runner = None
            if job and not job.script and ctx is not None and runner_factory is not None:
                custom_runner = runner_factory(ctx, actor)
            occ = mgr.run_job(job_id, custom_runner=custom_runner, ctx=ctx, actor=actor)
            run.setdefault("_cron", {})["jobs"] = [j.to_dict() for j in mgr.list_jobs(include_cleared=True) if accessible(j)]
            return {"status": occ.status, "occurrence": occ.to_dict()}
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
