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
