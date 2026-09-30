"""HTTP surface for cron due-fire and Chronos provider status (H28/H29)."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field

from homun.application.chronos_provider import ChronosProvider
from homun.routes.price_comparisons import request_context
from homun.application.cron_authority import require_owner
from homun.application.cron_manager import CronManager
from homun.domain.errors import DomainError
from homun.application.cron_dispatcher import fire_due_jobs, list_due_job_ids

router = APIRouter(prefix="/v1/cron", tags=["cron"])


class FireDueRequest(BaseModel):
    workspace_id: str = Field(default="ws_local")
    limit: int = Field(default=50, ge=1, le=500)
    now: Optional[float] = None


@router.get("/due")
def get_due_jobs(workspace_id: str = 'ws_local', now: Optional[float] = None,
                 x_homun_actor_id: str | None = Header(default=None),
                 x_homun_actor_name: str | None = Header(default=None)) -> Dict[str, Any]:
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    mgr = CronManager(workspace_id=workspace_id)
    ids = []
    for job_id in list_due_job_ids(workspace_id, now=now):
        try:
            require_owner(ctx, mgr.get_job(job_id), actor)
        except DomainError:
            continue
        ids.append(job_id)
    return {"workspace_id": workspace_id, "count": len(ids), "job_ids": ids}


@router.post("/fire-due")
def post_fire_due(body: FireDueRequest,
                  x_homun_actor_id: str | None = Header(default=None),
                  x_homun_actor_name: str | None = Header(default=None)) -> Dict[str, Any]:
    ctx, actor = request_context(body.workspace_id, x_homun_actor_id, x_homun_actor_name)
    results = fire_due_jobs(body.workspace_id, now=body.now, limit=body.limit, ctx=ctx, actor=actor)
    return {"workspace_id": body.workspace_id, "count": len(results), "results": results}


class CronJobCreateRequest(BaseModel):
    schedule: str = Field(min_length=1, max_length=120)
    prompt: Optional[str] = None
    name: Optional[str] = None
    skills: Optional[list] = None
    script: Optional[str] = None
    no_agent: bool = False
    workdir: Optional[str] = None
    model_pin: Optional[str] = None
    provider_pin: Optional[str] = None
    context_from: Optional[list] = None
    repeat: Optional[int] = None
    deliver: str = "local"
    auto_approve: bool = False
    source_work_id: Optional[str] = None
    paused: bool = False


@router.post("/jobs")
def create_cron_job(body: CronJobCreateRequest,
                    x_homun_actor_id: str | None = Header(default=None),
                    x_homun_actor_name: str | None = Header(default=None)) -> Dict[str, Any]:
    """Human cron job creation (parity with `hermes cron create`)."""
    ctx, actor = request_context("ws_local" if not hasattr(body, "workspace_id") else body.workspace_id,
                                 x_homun_actor_id, x_homun_actor_name)
    if actor.kind != "person":
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Persons only"})
    mgr = CronManager(workspace_id=ctx.workspace_id)
    try:
        job = mgr.create_job(
            body.schedule, prompt=body.prompt, name=body.name, skills=body.skills,
            script=body.script, no_agent=body.no_agent, workdir=body.workdir,
            model_pin=body.model_pin, provider_pin=body.provider_pin,
            context_from=body.context_from, repeat=body.repeat, deliver=body.deliver,
            auto_approve=body.auto_approve,
            owner_actor=actor.model_dump(mode="json"), source_work_id=body.source_work_id,
            paused=body.paused)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"code": "validation_error", "message": str(exc)})
    return {"job": job.to_dict()}


@router.get("/deliveries")
def get_deliveries(workspace_id: str = 'ws_local',
                   x_homun_actor_id: str | None = Header(default=None),
                   x_homun_actor_name: str | None = Header(default=None)) -> Dict[str, Any]:
    ctx, actor = request_context(workspace_id, x_homun_actor_id, x_homun_actor_name)
    if actor.kind != 'person':
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Persons only"})
    mgr = CronManager(workspace_id=workspace_id)
    deliveries = mgr.get_deliveries()
    return {"workspace_id": workspace_id, "count": len(deliveries), "deliveries": deliveries}


@router.post("/deliveries/dispatch")
def dispatch_deliveries(body: FireDueRequest,
                        x_homun_actor_id: str | None = Header(default=None),
                        x_homun_actor_name: str | None = Header(default=None)) -> Dict[str, Any]:
    """Manually drain queued cron deliveries (the pump also does this)."""
    ctx, actor = request_context(body.workspace_id, x_homun_actor_id, x_homun_actor_name)
    if actor.kind != 'person':
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Persons only"})
    from homun.application.cron_deliveries import deliver_pending
    return deliver_pending(ctx, limit=max(1, min(body.limit, 100)))


@router.get("/providers/chronos")
def chronos_status() -> Dict[str, Any]:
    status = ChronosProvider().status().to_dict()
    if not status.get("ready"):
        # Honest unavailability without inventing remote jobs.
        raise HTTPException(status_code=503, detail=status)
    return status


class ActivateEventRequest(BaseModel):
    workspace_id: str = 'ws_local'
    activation_id: str = Field(min_length=1, max_length=160)


@router.post('/jobs/{job_id}/activate')
def activate_cron_event(job_id: str, body: ActivateEventRequest,
                        x_homun_actor_id: str | None = Header(default=None),
                        x_homun_actor_name: str | None = Header(default=None)):
    ctx, actor = request_context(body.workspace_id, x_homun_actor_id, x_homun_actor_name)
    mgr = CronManager(workspace_id=ctx.workspace_id)
    job = mgr.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={'code':'not_found','message':'Cron job not found'})
    try:
        require_owner(ctx, job, actor)
        occurrence = mgr.activate_event(job_id, activation_id=body.activation_id)
    except DomainError as exc:
        from homun.routes.domain_support import _http_error
        raise _http_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={'code':'validation_error','message':str(exc)}) from exc
    return {'job_id':job_id, 'occurrence':occurrence.to_dict()}
