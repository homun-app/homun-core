"""HTTP surface for cron due-fire and Chronos provider status (H28/H29)."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.chronos_provider import ChronosProvider
from homun.application.cron_dispatcher import fire_due_jobs, list_due_job_ids

router = APIRouter(prefix="/v1/cron", tags=["cron"])


class FireDueRequest(BaseModel):
    workspace_id: str = Field(default="default")
    limit: int = Field(default=50, ge=1, le=500)
    now: Optional[float] = None


@router.get("/due")
def get_due_jobs(workspace_id: str = "default", now: Optional[float] = None) -> Dict[str, Any]:
    ids = list_due_job_ids(workspace_id, now=now)
    return {"workspace_id": workspace_id, "count": len(ids), "job_ids": ids}


@router.post("/fire-due")
def post_fire_due(body: FireDueRequest) -> Dict[str, Any]:
    results = fire_due_jobs(body.workspace_id, now=body.now, limit=body.limit)
    return {"workspace_id": body.workspace_id, "count": len(results), "results": results}


@router.get("/providers/chronos")
def chronos_status() -> Dict[str, Any]:
    status = ChronosProvider().status().to_dict()
    if not status.get("ready"):
        # Honest unavailability without inventing remote jobs.
        raise HTTPException(status_code=503, detail=status)
    return status
