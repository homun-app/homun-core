"""Actor-scoped work, run and event reads."""
from typing import Any
from fastapi import APIRouter, Header, HTTPException, Query
from homun.context import get_context
from homun.application.conversation_messages import conversation_message_page
from homun.domain.errors import NotFoundError, PermissionDeniedError
from homun.policy.work import require_work_access
from homun.policy.intake import has_confirmed_intake
from homun.policy.read import can_read_work, readable_event_page
from homun.routes.domain_support import _actor_from_headers, _http_error
from homun.runtime import bridge as runtime_bridge

router = APIRouter()

@router.get("/works")
def list_works(
    workspace_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    items = []
    for work in sorted(ctx.service.store.works.values(), key=lambda w: w.created_at):
        if not can_read_work(ctx.service.store, actor, work.id):
            continue
        payload = work.model_dump(mode="json")
        pending = next(
            (
                c
                for c in ctx.service.store.contributions.values()
                if c.work_id == work.id and c.status == "pending"
            ),
            None,
        )
        if pending is not None:
            payload["pending_contribution"] = pending.model_dump(mode="json")
        payload["intake_confirmed"] = has_confirmed_intake(ctx.service.store, work.id)
        plan = ctx.service.current_plan(work)
        if plan is not None:
            # Compact current plan so clients can render the phase ladder without
            # a per-work roundtrip.
            payload["plan"] = plan.model_dump(mode="json")
        budget = ctx.service.store.work_budgets.get(work.id)
        if budget is not None:
            from homun.application.budgets import public as budget_public
            payload["budget"] = budget_public(budget)
        if work.current_artifact_version:
            artifact = next((a for a in ctx.service.store.artifacts.values()
                             if a.work_id == work.id and a.version == work.current_artifact_version), None)
            if artifact is not None:
                # The result awaiting (or having received) human review.
                payload["latest_artifact"] = {"id": artifact.id, "version": artifact.version,
                                              "title": artifact.title, "content": artifact.content}
        items.append(payload)
    return {"items": items}


@router.get("/works/{work_id}")
def get_work(
    workspace_id: str,
    work_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        work = require_work_access(ctx.service.store, actor, work_id, 'read')
    except (NotFoundError, PermissionDeniedError) as exc:
        raise _http_error(exc) from exc
    plan = ctx.service.current_plan(work)
    budget = ctx.service.store.work_budgets.get(work_id)
    from homun.application.budgets import public as budget_public
    work_payload = work.model_dump(mode="json")
    work_payload["intake_confirmed"] = has_confirmed_intake(ctx.service.store, work.id)
    return {
        "work": work_payload,
        "plan": plan.model_dump(mode="json") if plan else None,
        "budget": budget_public(budget) if budget else None,
    }


@router.get("/works/{work_id}/run")
def get_work_run(
    workspace_id: str,
    work_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        require_work_access(ctx.service.store, actor, work_id, 'read')
    except (NotFoundError, PermissionDeniedError) as exc:
        raise _http_error(exc) from exc
    run = runtime_bridge.current_run_for_work(ctx.service.store, work_id)
    if run is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": f"No run for work {work_id}"},
        )
    return runtime_bridge.run_public_view(ctx.service.store, run)


@router.get("/runs/{run_id}")
def get_run(
    workspace_id: str,
    run_id: str,
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        run = ctx.service.get_run(run_id)
        require_work_access(ctx.service.store, actor, run.work_id, 'read')
    except (NotFoundError, PermissionDeniedError) as exc:
        raise _http_error(exc) from exc
    return runtime_bridge.run_public_view(ctx.service.store, run)


@router.get("/events")
def list_events(
    workspace_id: str,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    return readable_event_page(ctx.service.store, actor, after, limit)



@router.get("/conversations/{conversation_id}/messages")
def list_conversation_messages(
    workspace_id: str,
    conversation_id: str,
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    x_homun_actor_id: str | None = Header(default=None),
    x_homun_actor_name: str | None = Header(default=None),
) -> dict[str, Any]:
    ctx = get_context().snapshot()
    if workspace_id != ctx.workspace_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Unknown workspace"})
    actor = _actor_from_headers(workspace_id, x_homun_actor_id, x_homun_actor_name)
    try:
        return conversation_message_page(ctx.service.store, actor, conversation_id, after, limit)
    except (NotFoundError, PermissionDeniedError) as exc:
        raise _http_error(exc) from exc
