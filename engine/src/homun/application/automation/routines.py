"""Routine orchestration: transactional commands and the startup convergence.

The automation repeats the assignment, never the approval: each recurrence
creates a real work with the template's phases, waiting for the person's
explicit go exactly like a hand-made one.

Homun decides when a routine is due: `Routine.next_run_at` is written by the
domain commands through the calendar port (`routine_schedule.next_run_at`, the
same calculus as the preview) on create, cron/timezone change, pause, resume
and skip_next, and advanced by the heartbeat after every run (`routine_tick`).
DBOS only provides the durable heartbeat: a single schedule, never one per
routine. The recurrence run itself lives in routine_runs.
"""
from __future__ import annotations
import logging
from copy import deepcopy
from typing import Any

from homun.domain.errors import NotFoundError
from homun.domain.models import utc_now
from homun.application.automation.routine_schedule import (  # re-exported for routes and tests
    deep_validate_cron, next_occurrence, next_occurrences, next_run_at)
from homun.application.automation.routine_tick import (
    LEGACY_SCHEDULE_PREFIX, TICK_CRON, TICK_SCHEDULE_NAME)

__all__ = ["deep_validate_cron", "next_occurrence", "next_occurrences", "next_run_at",
           "public", "create_routine", "routine_action", "reconcile_routines", "list_routines"]

logger = logging.getLogger(__name__)


def public(routine) -> dict[str, Any]:
    return {
        "id": routine.id, "name": routine.name, "cron": routine.cron,
        "cron_timezone": routine.cron_timezone,
        "conversation_id": routine.conversation_id,
        "template": deepcopy(routine.template),
        "status": routine.status, "last_run_work_id": routine.last_run_work_id,
        "last_scheduled_for": routine.last_scheduled_for, "skip_until": routine.skip_until,
        "next_run_at": routine.next_run_at,
        "revision": routine.revision,
    }


def create_routine(ctx, actor, body) -> dict[str, Any]:
    """Transactional routine.create; the domain stores next_run_at through the port."""
    deep_validate_cron(body["cron"])
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            service = ctx.service.for_store(store)
            result = service.apply(actor, body["command_id"], "routine.create", {
                "name": body.get("name") or "",
                "cron": body["cron"],
                "cron_timezone": body.get("cron_timezone") or "Europe/Rome",
                "conversation_id": body["conversation_id"],
                "template": body["template"],
            })
        ctx.service.store = store
    return result


def routine_action(ctx, actor, action: str, body) -> dict[str, Any]:
    """pause/resume/stop/update/skip_next: one domain transition.

    skip_until is computed here (the application owns the calendar) and the
    domain moves next_run_at past it; nothing else to keep in step.
    """
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            routine = store.routines.get(str(body.get("routine_id") or ""))
            if routine is None:
                raise NotFoundError("Routine not found")
            payload = {"routine_id": routine.id, "expected_version": body["expected_version"]}
            for key in ("name", "cron", "cron_timezone", "template"):
                if body.get(key) is not None:
                    payload[key] = body[key]
            if action == "skip_next":
                deep_validate_cron(routine.cron)
                payload["skip_until"] = next_occurrence(routine.cron, routine.cron_timezone)
            service = ctx.service.for_store(store)
            result = service.apply(actor, body["command_id"], f"routine.{action}", payload)
        ctx.service.store = store
    return result


def reconcile_routines(ctx) -> list[str]:
    """On startup: every active routine has its next_run_at (routines saved
    before the heartbeat get it now, the same way the preview would), paused
    and stopped ones have none; the per-routine DBOS schedules of the previous
    design give way to the single heartbeat. Returns the repaired routine ids.
    """
    repaired = _converge_next_run_at(ctx)
    _converge_dbos_schedules()
    return repaired


def _converge_next_run_at(ctx) -> list[str]:
    repaired: list[str] = []
    with ctx.repository.locked():
        with ctx.repository.transaction() as store:
            for routine in store.routines.values():
                if routine.status == "active":
                    if routine.next_run_at is not None:
                        continue
                    try:
                        routine.next_run_at = next_run_at(routine.cron, routine.cron_timezone,
                                                          skip_until=routine.skip_until)
                    except Exception:
                        logger.exception("Routine %s: cron non calcolabile, resta senza prossima esecuzione",
                                         routine.id)
                        continue
                elif routine.next_run_at is None:
                    continue
                else:
                    routine.next_run_at = None
                routine.updated_at = utc_now()
                repaired.append(routine.id)
        ctx.service.store = store
    return repaired


def _converge_dbos_schedules() -> None:
    """The single heartbeat exists and is active; legacy per-routine schedules are gone."""
    from homun.runtime import dbos_app
    if not dbos_app.is_launched():
        return
    from dbos import DBOS
    from homun.runtime.workflows.routine_recurrence import routine_tick_workflow
    existing = {s["schedule_name"]: s for s in DBOS.list_schedules()}
    for name in existing:
        if name.startswith(LEGACY_SCHEDULE_PREFIX):
            DBOS.delete_schedule(name)
    tick = existing.get(TICK_SCHEDULE_NAME)
    if tick is not None and (tick.get("schedule") != TICK_CRON
                             or (tick.get("cron_timezone") or "UTC") != "UTC"):
        DBOS.delete_schedule(TICK_SCHEDULE_NAME)
        tick = None
    if tick is None:
        DBOS.create_schedule(schedule_name=TICK_SCHEDULE_NAME, workflow_fn=routine_tick_workflow,
                             schedule=TICK_CRON, cron_timezone="UTC")
    elif tick.get("status", "ACTIVE") != "ACTIVE":
        DBOS.resume_schedule(TICK_SCHEDULE_NAME)


def list_routines(ctx, actor) -> dict[str, Any]:
    from homun.policy import require_workspace_actor
    store = ctx.repository.load()
    require_workspace_actor(actor, store.workspace_id)
    return {"items": [public(r) for r in
                      sorted(store.routines.values(), key=lambda r: r.created_at)]}
